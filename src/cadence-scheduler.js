import { clamp, parseDate } from './pacing.js';

const DEFAULT_TARGET_WEEKLY_USAGE_PCT = 50;
const DEFAULT_MIN_INTERVAL_SEC = 15 * 60;
const DEFAULT_BASE_INTERVAL_SEC = 2 * 60 * 60;
const DEFAULT_MAX_INTERVAL_SEC = 8 * 60 * 60;
const DEFAULT_HARD_STOP_PCT = 98;
const DEFAULT_SESSION_HARD_STOP_PCT = 90;
const DEFAULT_RUSH_FILL_HOURS = 3;
const DEFAULT_MAX_CONCURRENT_RUNS = 1;

export function buildCadenceAudit({ config, usageSnapshots = [], agents = [], now = new Date().toISOString() } = {}) {
  const generatedAt = now;
  if (!config?.enabled) {
    return {
      generatedAt,
      enabled: false,
      pools: [],
      summary: { poolCount: 0, patchCount: 0, reason: 'plugin disabled' },
    };
  }

  const participants = config.participants ?? config.bindings ?? [];
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const pools = (config.pools ?? config.providerPools ?? []).map((pool) => buildPoolAudit({
    pool,
    participants: participants.filter((participant) => participant.providerPoolId === pool.poolId),
    agentById,
    snapshot: usageSnapshots.find((item) => item.providerPoolId === pool.poolId),
    now,
  }));

  return {
    generatedAt,
    enabled: true,
    pools,
    summary: {
      poolCount: pools.length,
      bindingCount: pools.reduce((sum, pool) => sum + pool.bindings.length, 0),
      patchCount: pools.reduce((sum, pool) => sum + pool.proposedPatches.length, 0),
    },
  };
}

export async function applyCadenceRecommendations({ audit, client } = {}) {
  if (!audit) throw new Error('applyCadenceRecommendations requires an audit');
  if (!client) throw new Error('applyCadenceRecommendations requires a Paperclip client');

  const actions = [];
  const skipped = [];
  for (const pool of audit.pools ?? []) {
    for (const proposed of pool.proposedPatches ?? []) {
      if (proposed.noPatchRequired) {
        skipped.push({
          poolId: pool.poolId,
          agentId: proposed.agentId,
          reason: 'heartbeat_already_matches_recommendation',
        });
        continue;
      }
      const response = await client.updateAgent(proposed.agentId, proposed.patch);
      const verified = client.getAgent ? await client.getAgent(proposed.agentId) : response;
      actions.push({
        poolId: pool.poolId,
        participantId: proposed.participantId,
        agentId: proposed.agentId,
        action: proposed.action,
        patch: proposed.patch,
        response: compactAgent(response),
        verified: compactAgent(verified),
      });
    }
  }
  return { appliedAt: new Date().toISOString(), invoked: actions.length > 0, actions, skipped };
}

function buildPoolAudit({ pool, participants, agentById, snapshot, now }) {
  if (!snapshot) {
    return holdPool(pool, participants, 'missing telemetry for provider pool');
  }

  const telemetry = readTelemetry({ pool, snapshot, now });
  const bindings = participants.map((participant) => buildBinding(participant, agentById.get(participant.agentId)));
  const recommendation = recommendCadence({ pool, telemetry });
  const proposedPatches = bindings
    .filter((binding) => binding.agentId)
    .map((binding) => proposedHeartbeatPatch({ binding, recommendation }));

  return {
    poolId: pool.poolId,
    provider: pool.provider,
    mode: recommendation.mode,
    quota: telemetry.quota,
    threeDayUsage: telemetry.threeDayUsage,
    projectedWeeklyUsagePct: telemetry.projectedWeeklyUsagePct,
    capacityCountedOnce: true,
    sharedCompanyIds: [...new Set(bindings.map((binding) => binding.companyId).filter(Boolean))],
    bindings,
    recommendation: recommendation.publicRecommendation,
    proposedPatches,
    decisionRecord: {
      providerPoolId: pool.poolId,
      provider: pool.provider,
      quota: telemetry.quota,
      threeDayUsage: telemetry.threeDayUsage,
      projectedWeeklyUsagePct: telemetry.projectedWeeklyUsagePct,
      chosenIntervalSec: recommendation.publicRecommendation.intervalSec,
      enabled: recommendation.publicRecommendation.enabled,
      paused: recommendation.publicRecommendation.enabled === false,
      reason: recommendation.reason,
    },
    reason: annotateSharedReason(recommendation.reason, bindings),
  };
}

function holdPool(pool, participants, reason) {
  return {
    poolId: pool.poolId,
    provider: pool.provider,
    mode: 'hold',
    quota: null,
    threeDayUsage: null,
    projectedWeeklyUsagePct: null,
    capacityCountedOnce: true,
    sharedCompanyIds: [...new Set(participants.map((participant) => participant.companyId).filter(Boolean))],
    bindings: participants.map((participant) => buildBinding(participant, null)),
    recommendation: { enabled: false, intervalSec: null, maxConcurrentRuns: 0, action: 'hold' },
    proposedPatches: [],
    decisionRecord: { providerPoolId: pool.poolId, provider: pool.provider, reason, paused: true },
    reason,
  };
}

function readTelemetry({ pool, snapshot, now }) {
  const weekly = snapshot.windows?.weekly ?? {};
  const session = snapshot.windows?.session_6h ?? {};
  const current = parseDate(now, 'now');
  const weeklyReset = parseDate(weekly.resetAt, 'weekly resetAt');
  const hoursRemaining = Math.max((weeklyReset.getTime() - current.getTime()) / 3_600_000, 0);
  const weeklyProgress = weeklyProgressFromReset({ now, resetAt: weekly.resetAt });
  const heartbeatCount = snapshot.history?.heartbeatCount ?? snapshot.threeDayUsage?.heartbeatCount ?? 0;
  const totalUsagePct = snapshot.history?.totalUsagePct ?? snapshot.threeDayUsage?.totalUsagePct ?? null;
  const averageUsagePctPerHeartbeat = heartbeatCount > 0 && Number.isFinite(totalUsagePct)
    ? totalUsagePct / heartbeatCount
    : pool.estimatedWeeklyWakeCostPct ?? pool.estimatedWakeCostPct ?? 1;
  const weeklyUsagePct = finiteOr(weekly.usagePct, 0);
  const projectedWeeklyUsagePct = weeklyProgress > 0
    ? weeklyUsagePct / weeklyProgress
    : weeklyUsagePct;

  return {
    quota: {
      sessionUsagePct: finiteOr(session.usagePct, null),
      sessionResetAt: session.resetAt ?? null,
      weeklyUsagePct,
      weeklyResetAt: weekly.resetAt,
      hoursRemaining,
      weeklyProgress,
    },
    threeDayUsage: {
      days: snapshot.history?.days ?? snapshot.threeDayUsage?.days ?? 3,
      heartbeatCount,
      totalUsagePct,
      averageUsagePctPerHeartbeat,
      byCompany: snapshot.history?.byCompany ?? snapshot.threeDayUsage?.byCompany ?? {},
    },
    projectedWeeklyUsagePct,
  };
}

function recommendCadence({ pool, telemetry }) {
  const targetWeeklyUsagePct = pool.targetWeeklyUsagePct ?? DEFAULT_TARGET_WEEKLY_USAGE_PCT;
  const hardStopAtPct = pool.hardStopAtPct ?? DEFAULT_HARD_STOP_PCT;
  const sessionHardStopPct = pool.sessionHardStopPct ?? DEFAULT_SESSION_HARD_STOP_PCT;
  const rushFillHours = pool.rushFillHours ?? pool.finalRushHours ?? DEFAULT_RUSH_FILL_HOURS;
  const minIntervalSec = pool.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC;
  const baseIntervalSec = pool.baseIntervalSec ?? pool.ceoIntervalSec ?? DEFAULT_BASE_INTERVAL_SEC;
  const maxIntervalSec = pool.maxIntervalSec ?? DEFAULT_MAX_INTERVAL_SEC;
  const maxConcurrentRuns = pool.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;

  const { quota, projectedWeeklyUsagePct } = telemetry;
  if (quota.weeklyUsagePct >= hardStopAtPct) {
    return recommendation({
      mode: 'hard_stop',
      enabled: false,
      intervalSec: null,
      maxConcurrentRuns: 0,
      action: 'pause_interval_heartbeat',
      reason: `weekly usage ${quota.weeklyUsagePct}% is at or above hard stop ${hardStopAtPct}%`,
    });
  }
  if (quota.sessionUsagePct != null && quota.sessionUsagePct >= sessionHardStopPct) {
    return recommendation({
      mode: 'session_hold',
      enabled: false,
      intervalSec: null,
      maxConcurrentRuns: 0,
      action: 'pause_interval_heartbeat',
      reason: `session usage ${quota.sessionUsagePct}% is at or above session hard stop ${sessionHardStopPct}%`,
    });
  }

  if (quota.hoursRemaining <= rushFillHours) {
    return recommendation({
      mode: 'rush_fill',
      enabled: true,
      intervalSec: minIntervalSec,
      maxConcurrentRuns,
      action: 'set_interval_heartbeat',
      reason: `rush-fill mode: ${round(quota.hoursRemaining)}h before weekly reset with headroom under ${hardStopAtPct}%`,
    });
  }

  if (projectedWeeklyUsagePct > targetWeeklyUsagePct) {
    return recommendation({
      mode: 'normal',
      enabled: true,
      intervalSec: maxIntervalSec,
      maxConcurrentRuns,
      action: 'set_interval_heartbeat',
      reason: `projected weekly use ${round(projectedWeeklyUsagePct)}% is above normal target ${targetWeeklyUsagePct}%`,
    });
  }

  const targetProgressUsagePct = targetWeeklyUsagePct * quota.weeklyProgress;
  if (quota.weeklyUsagePct < targetProgressUsagePct * 0.8) {
    return recommendation({
      mode: 'normal',
      enabled: true,
      intervalSec: minIntervalSec,
      maxConcurrentRuns,
      action: 'set_interval_heartbeat',
      reason: `weekly usage ${quota.weeklyUsagePct}% is safely under budget trajectory ${round(targetProgressUsagePct)}%`,
    });
  }

  return recommendation({
    mode: 'normal',
    enabled: true,
    intervalSec: baseIntervalSec,
    maxConcurrentRuns,
    action: 'set_interval_heartbeat',
    reason: `steady cadence keeps projected weekly use ${round(projectedWeeklyUsagePct)}% under normal target ${targetWeeklyUsagePct}%`,
  });
}

function recommendation({ mode, enabled, intervalSec, maxConcurrentRuns, action, reason }) {
  return {
    mode,
    reason,
    publicRecommendation: { enabled, intervalSec, maxConcurrentRuns, action },
  };
}

function buildBinding(participant, agent) {
  const heartbeat = agent?.runtimeConfig?.heartbeat ?? {};
  return {
    participantId: participant.participantId,
    companyId: participant.companyId,
    agentId: participant.agentId,
    role: participant.role ?? null,
    currentHeartbeat: {
      enabled: heartbeat.enabled ?? null,
      intervalSec: heartbeat.intervalSec ?? null,
      maxConcurrentRuns: heartbeat.maxConcurrentRuns ?? null,
      wakeOnDemand: heartbeat.wakeOnDemand ?? null,
    },
    runtimeConfig: agent?.runtimeConfig ?? {},
  };
}

function proposedHeartbeatPatch({ binding, recommendation }) {
  const currentRuntime = binding.runtimeConfig ?? {};
  const currentHeartbeat = currentRuntime.heartbeat ?? {};
  const nextHeartbeat = {
    ...currentHeartbeat,
    enabled: recommendation.publicRecommendation.enabled,
    wakeOnDemand: currentHeartbeat.wakeOnDemand === false ? false : true,
  };
  if (recommendation.publicRecommendation.intervalSec == null) {
    delete nextHeartbeat.intervalSec;
  } else {
    nextHeartbeat.intervalSec = recommendation.publicRecommendation.intervalSec;
  }
  if (recommendation.publicRecommendation.maxConcurrentRuns != null) {
    nextHeartbeat.maxConcurrentRuns = recommendation.publicRecommendation.maxConcurrentRuns;
  }
  const patch = { runtimeConfig: { ...currentRuntime, heartbeat: nextHeartbeat } };
  return {
    participantId: binding.participantId,
    companyId: binding.companyId,
    agentId: binding.agentId,
    action: recommendation.publicRecommendation.action,
    noPatchRequired: heartbeatEquivalent(currentHeartbeat, nextHeartbeat),
    patch,
    reason: recommendation.reason,
  };
}

function heartbeatEquivalent(left, right) {
  return JSON.stringify(normalizeHeartbeat(left)) === JSON.stringify(normalizeHeartbeat(right));
}

function normalizeHeartbeat(heartbeat) {
  return {
    enabled: heartbeat.enabled ?? null,
    intervalSec: heartbeat.intervalSec ?? null,
    maxConcurrentRuns: heartbeat.maxConcurrentRuns ?? null,
    wakeOnDemand: heartbeat.wakeOnDemand ?? null,
  };
}

function annotateSharedReason(reason, bindings) {
  const companyCount = new Set(bindings.map((binding) => binding.companyId).filter(Boolean)).size;
  if (companyCount <= 1) return reason;
  return `${reason}; shared pool coordinates ${companyCount} companies without double-counting provider capacity`;
}

function weeklyProgressFromReset({ now, resetAt }) {
  const current = parseDate(now, 'now');
  const end = parseDate(resetAt, 'weekly resetAt');
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const start = new Date(end.getTime() - weekMs);
  return clamp((current.getTime() - start.getTime()) / weekMs, 0.000001, 1);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function compactAgent(agent) {
  if (!agent) return null;
  return {
    id: agent.id,
    companyId: agent.companyId ?? null,
    heartbeat: agent.runtimeConfig?.heartbeat ?? null,
  };
}
