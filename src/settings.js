import { isAbsolute, resolve } from 'node:path';

export function buildPluginSettings(config, { configDir = process.cwd() } = {}) {
  const paperclip = config.paperclip ?? {};
  const live = config.live ?? {};
  const storage = config.storage ?? {};
  const toolDefaults = config.toolDefaults ?? config.tools ?? {};

  return {
    enabled: config.enabled !== false,
    paperclip: {
      baseUrl: paperclip.baseUrl ?? config.paperclipBaseUrl ?? live.paperclipBaseUrl ?? null,
      companyIds: normalizeList(paperclip.companyIds ?? paperclip.companyId ?? config.scope?.companyIds),
      participantsSource: config.participantsSource ?? paperclip.participantsSource ?? (paperclip.participants?.enabled ? 'paperclip' : 'config'),
    },
    storage: {
      sharedStatePath: resolveConfiguredPath(storage.sharedStatePath ?? config.sharedStatePath, configDir),
      decisionLogPath: resolveConfiguredPath(live.decisionLogPath ?? storage.decisionLogPath, configDir),
      idempotencyStorePath: resolveConfiguredPath(live.idempotencyStorePath ?? storage.idempotencyStorePath, configDir),
      syncDirectory: resolveConfiguredPath(storage.syncDirectory ?? config.syncDirectory, configDir),
    },
    providerPools: (config.pools ?? []).map((pool) => ({
      poolId: pool.poolId,
      provider: pool.provider,
      quotaProvider: pool.quotaProvider ?? pool.providerSlug ?? pool.provider,
      subscriptionOnly: pool.subscriptionOnly !== false,
      allowExtraSpend: pool.allowExtraSpend === true,
      extraSpendBudgetCents: integerOrNull(pool.extraSpendBudgetCents),
      requireCompanyCostLimit: pool.requireCompanyCostLimit === true,
      finalDayHours: pool.finalDayHours ?? null,
      preFinalWeeklyUnderburnPct: pool.preFinalWeeklyUnderburnPct ?? null,
      hardStopAtPct: pool.hardStopAtPct ?? null,
      sessionHardStopPct: pool.sessionHardStopPct ?? null,
      estimatedWakeCostPct: pool.estimatedWakeCostPct ?? null,
      estimatedWakeCostCents: integerOrNull(pool.estimatedWakeCostCents),
    })),
    toolDefaults: normalizeToolDefaults(toolDefaults),
    validation: validatePluginSettings(config),
  };
}

export function validatePluginSettings(config) {
  const warnings = [];
  const errors = [];

  for (const pool of config.pools ?? []) {
    const label = pool.poolId ?? pool.provider ?? 'unnamed-pool';
    if (pool.subscriptionOnly !== false && pool.allowExtraSpend === true) {
      errors.push(`${label}: subscriptionOnly=true cannot be combined with allowExtraSpend=true`);
    }
    if (pool.subscriptionOnly === false && pool.allowExtraSpend === true && !Number.isFinite(Number(pool.extraSpendBudgetCents))) {
      warnings.push(`${label}: allowExtraSpend=true should set extraSpendBudgetCents so paid overage has a hard cap`);
    }
    if (pool.requireCompanyCostLimit === true && pool.subscriptionOnly === false && pool.allowExtraSpend !== true) {
      warnings.push(`${label}: requireCompanyCostLimit=true is set, but allowExtraSpend is not enabled`);
    }
  }

  if (!config.storage?.sharedStatePath && !config.sharedStatePath) {
    warnings.push('storage.sharedStatePath is not set; multi-computer turn taking will not have an operator-visible synced file location');
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function evaluatePoolSpendPolicy(pool) {
  if (pool.subscriptionOnly !== false && pool.allowExtraSpend === true) {
    return { decision: 'hold', reason: 'provider pool is subscription-only but allowExtraSpend=true' };
  }
  if (pool.subscriptionOnly === false && pool.allowExtraSpend === true) {
    const budget = Number(pool.extraSpendBudgetCents);
    const estimated = Number(pool.estimatedWakeCostCents ?? 0);
    if (!Number.isFinite(budget)) {
      return { decision: 'hold', reason: 'extra spending enabled without extraSpendBudgetCents hard cap' };
    }
    if (budget <= 0) {
      return { decision: 'hold', reason: 'extra spending budget is zero' };
    }
    if (estimated > budget) {
      return { decision: 'hold', reason: 'estimated wake cost exceeds extra spending budget' };
    }
  }
  return { decision: 'allow', reason: 'provider spend policy allows scheduler evaluation' };
}

function resolveConfiguredPath(value, baseDir) {
  if (!value) return null;
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeToolDefaults(value) {
  return {
    enabledToolsets: normalizeList(value.enabledToolsets ?? value.enabled ?? value.toolsets),
    disabledToolsets: normalizeList(value.disabledToolsets ?? value.disabled),
    requireExplicitLiveApproval: value.requireExplicitLiveApproval !== false,
    notes: value.notes ?? null,
  };
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
