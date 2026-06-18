const DEFAULT_SESSION_WINDOW_ID = 'session_6h';
const DEFAULT_WEEKLY_WINDOW_ID = 'weekly';

export async function readPaperclipUsage({ client, companyId, pools, now = new Date().toISOString() }) {
  if (!client) throw new Error('readPaperclipUsage requires client');
  if (!companyId) throw new Error('readPaperclipUsage requires companyId');

  if (typeof client.getQuotaWindows === 'function') {
    const quotaWindows = await client.getQuotaWindows(companyId);
    return (pools ?? []).map((pool) => usageSnapshotForPool(pool, quotaWindows, now));
  }

  const snapshots = [];
  for (const pool of pools ?? []) {
    const windows = buildWindows(pool, now);
    const snapshotWindows = {};

    for (const windowConfig of windows) {
      const rows = await client.getCostsByAgentModel(companyId, {
        from: windowConfig.from,
        to: windowConfig.to,
      });
      const aggregate = aggregateRows(rows, pool);
      snapshotWindows[windowConfig.id] = {
        usagePct: usagePct(aggregate.totalTokens, windowConfig.quotaTokens),
        resetAt: windowConfig.resetAt,
        totalTokens: aggregate.totalTokens,
        inputTokens: aggregate.inputTokens,
        cachedInputTokens: aggregate.cachedInputTokens,
        outputTokens: aggregate.outputTokens,
        runCount: aggregate.runCount,
        costCents: aggregate.costCents,
        quotaTokens: windowConfig.quotaTokens ?? null,
        source: 'paperclip-costs-by-agent-model',
      };
    }

    snapshots.push({
      providerPoolId: pool.poolId,
      collectedAt: now,
      source: 'paperclip-costs',
      filters: usageFilters(pool),
      windows: snapshotWindows,
    });
  }

  return snapshots;
}

export function usageSnapshotForPool(pool, quotaWindows, now = new Date().toISOString()) {
  const expectedProvider = quotaProviderForPool(pool);
  const row = (quotaWindows ?? []).find((item) => normalizeProvider(item.provider) === expectedProvider);
  if (!row || row.ok === false) {
    return {
      providerPoolId: pool.poolId,
      collectedAt: now,
      source: 'paperclip-costs/quota-windows',
      provider: pool.provider ?? null,
      ok: row?.ok ?? false,
      error: row?.error ?? 'missing Paperclip quota telemetry',
      paperclipSource: row?.source ?? null,
      windows: missingQuotaWindows(),
    };
  }

  const session = findQuotaWindow(row.windows, /session|^[0-9]+h|hour|limit/i);
  const weekly = findQuotaWindow(row.windows, /week/i);
  return {
    providerPoolId: pool.poolId,
    collectedAt: now,
    source: 'paperclip-costs/quota-windows',
    provider: row.provider ?? pool.provider ?? null,
    ok: row.ok ?? true,
    paperclipSource: row.source ?? null,
    windows: {
      session_6h: quotaWindowSnapshot(session),
      weekly: quotaWindowSnapshot(weekly),
    },
  };
}

export function buildWindows(pool, now = new Date().toISOString()) {
  const usageWindows = pool.paperclipUsage?.windows ?? pool.usageWindows ?? {};
  const session = usageWindows.session_6h ?? {};
  const weekly = usageWindows.weekly ?? {};
  const nowMs = new Date(now).getTime();

  return [
    buildWindow(DEFAULT_SESSION_WINDOW_ID, {
      durationHours: session.durationHours ?? 6,
      quotaTokens: session.quotaTokens ?? pool.sessionQuotaTokens,
      resetAt: session.resetAt ?? now,
    }, nowMs),
    buildWindow(DEFAULT_WEEKLY_WINDOW_ID, {
      durationHours: weekly.durationHours ?? 24 * 7,
      quotaTokens: weekly.quotaTokens ?? pool.weeklyQuotaTokens,
      resetAt: weekly.resetAt ?? pool.weeklyResetAt ?? now,
      from: weekly.from,
    }, nowMs),
  ];
}

function buildWindow(id, config, nowMs) {
  const resetAt = config.resetAt;
  const to = new Date(nowMs).toISOString();
  const from = config.from ?? new Date(nowMs - config.durationHours * 60 * 60 * 1000).toISOString();
  return {
    id,
    from,
    to,
    resetAt,
    quotaTokens: config.quotaTokens,
  };
}

function aggregateRows(rows, pool) {
  const filters = usageFilters(pool);
  const matchedRows = (rows ?? []).filter((row) => matches(row, filters));
  return matchedRows.reduce((aggregate, row) => {
    const inputTokens = numberValue(row.inputTokens);
    const cachedInputTokens = numberValue(row.cachedInputTokens);
    const outputTokens = numberValue(row.outputTokens);
    aggregate.inputTokens += inputTokens;
    aggregate.cachedInputTokens += cachedInputTokens;
    aggregate.outputTokens += outputTokens;
    aggregate.totalTokens += inputTokens + cachedInputTokens + outputTokens;
    aggregate.costCents += numberValue(row.costCents);
    aggregate.runCount += numberValue(row.runCount ?? row.runs ?? 0);
    return aggregate;
  }, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costCents: 0,
    runCount: 0,
  });
}

function usageFilters(pool) {
  const source = pool.paperclipUsage ?? {};
  return {
    provider: normalizeProvider(source.provider ?? pool.paperclipProvider ?? pool.provider),
    biller: normalize(source.biller ?? pool.paperclipBiller ?? pool.biller),
    billingType: normalize(source.billingType ?? pool.paperclipBillingType ?? 'subscription_included'),
    models: normalizeList(source.models ?? pool.paperclipModels),
    agentIds: new Set(source.agentIds ?? pool.paperclipAgentIds ?? []),
  };
}

function matches(row, filters) {
  if (filters.provider && normalizeProvider(row.provider) !== filters.provider) return false;
  if (filters.biller && normalize(row.biller) !== filters.biller) return false;
  if (filters.billingType && normalize(row.billingType) !== filters.billingType) return false;
  if (filters.models.size > 0 && !filters.models.has(normalize(row.model))) return false;
  if (filters.agentIds.size > 0 && !filters.agentIds.has(row.agentId)) return false;
  return true;
}

function findQuotaWindow(windows, pattern) {
  return (windows ?? []).find((window) => pattern.test(`${window.label ?? ''} ${window.name ?? ''} ${window.id ?? ''}`));
}

function quotaWindowSnapshot(window) {
  if (!window) {
    return {
      usagePct: null,
      resetAt: null,
      confidence: 'missing',
      label: null,
      valueLabel: null,
    };
  }
  return {
    usagePct: window.usedPercent ?? window.usagePct ?? null,
    resetAt: window.resetsAt ?? window.resetAt ?? null,
    confidence: 'reported',
    label: window.label ?? null,
    valueLabel: window.valueLabel ?? null,
  };
}

function missingQuotaWindows() {
  return {
    session_6h: quotaWindowSnapshot(null),
    weekly: quotaWindowSnapshot(null),
  };
}

function usagePct(totalTokens, quotaTokens) {
  if (!Number.isFinite(quotaTokens) || quotaTokens <= 0) {
    return null;
  }
  return Math.min(100, (totalTokens / quotaTokens) * 100);
}

function normalize(value) {
  return value == null ? null : String(value).trim().toLowerCase();
}

function quotaProviderForPool(pool) {
  return normalizeProvider(
    pool.paperclipUsage?.quotaProvider
      ?? pool.quotaProvider
      ?? pool.paperclipUsage?.provider
      ?? pool.paperclipProvider
      ?? pool.provider,
  );
}

function normalizeProvider(value) {
  const provider = normalize(value);
  if (!provider) return provider;
  if (['openai-codex', 'codex', 'openai'].includes(provider)) return 'openai';
  if (['claude', 'anthropic'].includes(provider)) return 'anthropic';
  return provider;
}

function normalizeList(values) {
  return new Set((values ?? []).map(normalize).filter(Boolean));
}

function numberValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
