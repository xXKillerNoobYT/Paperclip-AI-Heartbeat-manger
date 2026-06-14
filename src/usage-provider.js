import { readFixtureUsage } from './fixture-provider.js';
import { PaperclipClient } from './paperclip-client.js';

const SESSION_WINDOW_RE = /(session|current|6\s*h|5\s*h)/i;
const WEEKLY_WINDOW_RE = /week/i;

export async function readUsageInputs(config, options = {}) {
  const source = config.usageSource ?? { type: config.paperclipBaseUrl ? 'paperclip' : 'fixture' };
  const now = options.now ?? config.now ?? new Date().toISOString();

  if (source.type === 'paperclip') {
    return readPaperclipUsageInputs(config, { ...options, source, now });
  }

  const usagePath = options.usagePath ?? config.fixtureUsagePath ?? source.fixtureUsagePath;
  if (!usagePath) {
    throw new Error('missing fixture usage path: set --usage, config.fixtureUsagePath, or usageSource.fixtureUsagePath');
  }
  return {
    usageSnapshots: await readFixtureUsage(usagePath),
    costLimits: {},
    sourceDiagnostics: [{ source: 'fixture', ok: true, path: usagePath }],
  };
}

export async function readPaperclipUsageInputs(config, { source, now, fetchImpl } = {}) {
  const baseUrl = source.baseUrl ?? config.paperclipBaseUrl;
  if (!baseUrl) throw new Error('usageSource.type=paperclip requires usageSource.baseUrl or paperclipBaseUrl');

  const client = new PaperclipClient({ baseUrl, dryRun: true, fetchImpl });
  const companyIds = unique([
    ...(source.companyIds ?? config.scope?.companyIds ?? []),
    ...(config.participants ?? []).map((participant) => participant.companyId).filter(Boolean),
  ]);
  if (companyIds.length === 0) {
    return {
      usageSnapshots: [],
      costLimits: {},
      sourceDiagnostics: [{ source: 'paperclip', ok: false, reason: 'missing companyIds for Paperclip telemetry lookup' }],
    };
  }

  const quotaCompanyId = source.quotaCompanyId ?? companyIds[0];
  const [quotaResult, budgetResults] = await Promise.all([
    client.getProviderQuotaWindows(quotaCompanyId)
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, error })),
    Promise.all(companyIds.map(async (companyId) => readCompanyCostLimit(client, companyId))),
  ]);

  const diagnostics = [];
  let usageSnapshots = [];
  if (quotaResult.ok) {
    usageSnapshots = mapQuotaWindowsToSnapshots(config.pools ?? [], quotaResult.result, now);
    diagnostics.push({
      source: 'paperclip_quota_windows',
      ok: true,
      companyId: quotaCompanyId,
      providerCount: Array.isArray(quotaResult.result) ? quotaResult.result.length : 0,
      snapshotCount: usageSnapshots.length,
    });
    for (const provider of quotaResult.result ?? []) {
      if (provider.ok === false) {
        diagnostics.push({
          source: 'paperclip_quota_windows',
          ok: false,
          provider: provider.provider,
          reason: provider.error ?? 'provider quota endpoint returned not ok',
        });
      }
    }
  } else {
    diagnostics.push({
      source: 'paperclip_quota_windows',
      ok: false,
      companyId: quotaCompanyId,
      reason: quotaResult.error.message,
    });
  }

  const costLimits = {};
  for (const result of budgetResults) {
    costLimits[result.companyId] = result;
    diagnostics.push({
      source: 'paperclip_cost_limits',
      ok: result.ok,
      companyId: result.companyId,
      status: result.status,
      reason: result.reason ?? null,
    });
  }

  if (usageSnapshots.length === 0 && source.allowFixtureFallback) {
    const fallbackPath = source.fixtureUsagePath ?? config.fixtureUsagePath;
    if (fallbackPath) {
      diagnostics.push({ source: 'fixture_fallback', ok: true, path: fallbackPath });
      usageSnapshots = await readFixtureUsage(fallbackPath);
    }
  }

  return { usageSnapshots, costLimits, sourceDiagnostics: diagnostics };
}

export function mapQuotaWindowsToSnapshots(pools, quotaProviders, now = new Date().toISOString()) {
  const providers = Array.isArray(quotaProviders) ? quotaProviders : [];
  return pools.map((pool) => {
    const provider = findProviderForPool(providers, pool);
    if (!provider?.ok) return null;
    const windows = Array.isArray(provider.windows) ? provider.windows : [];
    const session = findWindow(windows, pool.sessionWindowLabel, SESSION_WINDOW_RE);
    const weekly = findWindow(windows, pool.weeklyWindowLabel, WEEKLY_WINDOW_RE);
    return {
      providerPoolId: pool.poolId,
      provider: pool.provider,
      source: provider.source ?? 'paperclip_quota_windows',
      collectedAt: now,
      windows: {
        ...(session ? { session_6h: normalizeQuotaWindow(session, 'session_6h') } : {}),
        ...(weekly ? { weekly: normalizeQuotaWindow(weekly, 'weekly') } : {}),
      },
    };
  }).filter(Boolean);
}

export function evaluateCompanyCostLimit(limit, options = {}) {
  if (!limit?.ok) {
    return { decision: 'hold', reason: limit?.reason ?? 'missing company cost limit telemetry', limit: limit ?? null };
  }
  if (limit.activeIncidentCount > 0) {
    return { decision: 'hold', reason: 'active budget incident blocks wake', limit };
  }
  if (limit.budgetCents > 0 && limit.spendCents >= limit.budgetCents) {
    return { decision: 'hold', reason: 'company monthly budget hard stop blocks wake', limit };
  }
  const estimatedCostCents = options.estimatedCostCents ?? 0;
  if (limit.budgetCents > 0 && estimatedCostCents > 0 && limit.spendCents + estimatedCostCents > limit.budgetCents) {
    return { decision: 'hold', reason: 'estimated wake cost would exceed company monthly budget', limit };
  }
  return { decision: 'allow', reason: 'company cost limit allows wake', limit };
}

async function readCompanyCostLimit(client, companyId) {
  try {
    const [summary, overview] = await Promise.all([
      client.getCompanyCostSummary(companyId),
      client.getCompanyBudgetOverview(companyId),
    ]);
    const activeIncidents = overview.activeIncidents ?? [];
    return {
      ok: true,
      companyId,
      status: activeIncidents.length > 0 ? 'incident' : 'ok',
      spendCents: summary.spendCents ?? 0,
      budgetCents: summary.budgetCents ?? 0,
      utilizationPercent: summary.utilizationPercent ?? 0,
      activeIncidentCount: activeIncidents.length,
      policyCount: (overview.policies ?? []).length,
      pausedAgentCount: overview.pausedAgentCount ?? 0,
      pausedProjectCount: overview.pausedProjectCount ?? 0,
    };
  } catch (error) {
    return { ok: false, companyId, status: 'missing', reason: error.message };
  }
}

function findProviderForPool(providers, pool) {
  const desired = [pool.quotaProvider, pool.provider, pool.providerSlug]
    .filter(Boolean)
    .map(normalizeProvider);
  return providers.find((provider) => desired.includes(normalizeProvider(provider.provider)));
}

function normalizeProvider(provider) {
  if (provider === 'claude') return 'anthropic';
  if (provider === 'codex' || provider === 'openai-codex') return 'openai';
  return String(provider ?? '').toLowerCase();
}

function findWindow(windows, exactLabel, fallbackRe) {
  if (exactLabel) {
    const exact = windows.find((window) => String(window.label).toLowerCase() === String(exactLabel).toLowerCase());
    if (exact) return exact;
  }
  return windows.find((window) => fallbackRe.test(String(window.label ?? window.window ?? '')) && finitePercent(window));
}

function normalizeQuotaWindow(window, kind) {
  return {
    usagePct: numberOrNull(window.usedPercent ?? window.usagePct),
    resetAt: window.resetsAt ?? window.resetAt ?? null,
    confidence: finitePercent(window) ? 'reported' : 'missing',
    source: 'paperclip_quota_windows',
    label: window.label ?? kind,
    valueLabel: window.valueLabel ?? null,
    detail: window.detail ?? null,
  };
}

function finitePercent(window) {
  return Number.isFinite(Number(window.usedPercent ?? window.usagePct));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
