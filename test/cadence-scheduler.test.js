import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCadenceRecommendations, buildCadenceAudit } from '../src/cadence-scheduler.js';

const now = '2026-06-18T12:00:00.000Z';

function baseConfig() {
  return {
    enabled: true,
    pools: [
      {
        poolId: 'openai-subscription',
        provider: 'openai-codex',
        targetWeeklyUsagePct: 50,
        hardStopAtPct: 98,
        sessionHardStopPct: 90,
        rushFillHours: 3,
        minIntervalSec: 900,
        baseIntervalSec: 7200,
        maxIntervalSec: 21600,
        maxConcurrentRuns: 1,
      },
      {
        poolId: 'anthropic-subscription',
        provider: 'anthropic',
        targetWeeklyUsagePct: 50,
        hardStopAtPct: 98,
        sessionHardStopPct: 90,
        rushFillHours: 3,
        minIntervalSec: 1200,
        baseIntervalSec: 10800,
        maxIntervalSec: 28800,
        maxConcurrentRuns: 1,
      },
    ],
    participants: [
      { participantId: 'wpr2-ceo', companyId: 'wpr2', agentId: 'agent-wpr2', providerPoolId: 'openai-subscription', role: 'CEO' },
      { participantId: 'local-ceo', companyId: 'local', agentId: 'agent-local', providerPoolId: 'openai-subscription', role: 'CEO' },
      { participantId: 'gov-ceo', companyId: 'gov', agentId: 'agent-gov', providerPoolId: 'anthropic-subscription', role: 'CEO' },
    ],
  };
}

const agents = [
  { id: 'agent-wpr2', companyId: 'wpr2', runtimeConfig: { heartbeat: { enabled: true, intervalSec: 900, maxConcurrentRuns: 2, wakeOnDemand: true } } },
  { id: 'agent-local', companyId: 'local', runtimeConfig: { heartbeat: { enabled: true, intervalSec: 900, maxConcurrentRuns: 2, wakeOnDemand: true } } },
  { id: 'agent-gov', companyId: 'gov', runtimeConfig: { heartbeat: { enabled: true, intervalSec: 900, maxConcurrentRuns: 2, wakeOnDemand: true } } },
];

function snapshot(providerPoolId, weeklyUsagePct, weeklyResetAt, extra = {}) {
  return {
    providerPoolId,
    collectedAt: now,
    windows: {
      session_6h: { usagePct: extra.sessionUsagePct ?? 12, resetAt: extra.sessionResetAt ?? '2026-06-18T15:00:00.000Z' },
      weekly: { usagePct: weeklyUsagePct, resetAt: weeklyResetAt },
    },
    history: {
      days: 3,
      heartbeatCount: extra.heartbeatCount ?? 12,
      totalUsagePct: extra.totalUsagePct ?? 12,
      byCompany: extra.byCompany ?? {},
    },
  };
}

test('audit supports shared provider pools without double-counting capacity per company', () => {
  const audit = buildCadenceAudit({
    config: baseConfig(),
    agents,
    usageSnapshots: [
      snapshot('openai-subscription', 30, '2026-06-21T00:00:00.000Z', {
        byCompany: { wpr2: { heartbeatCount: 8, totalUsagePct: 8 }, local: { heartbeatCount: 4, totalUsagePct: 4 } },
      }),
      snapshot('anthropic-subscription', 45, '2026-06-21T00:00:00.000Z', {
        byCompany: { gov: { heartbeatCount: 6, totalUsagePct: 9 } },
      }),
    ],
    now,
  });

  const openai = audit.pools.find((pool) => pool.poolId === 'openai-subscription');
  assert.equal(openai.provider, 'openai-codex');
  assert.equal(openai.bindings.length, 2);
  assert.equal(openai.quota.weeklyUsagePct, 30);
  assert.equal(openai.capacityCountedOnce, true);
  assert.equal(openai.threeDayUsage.heartbeatCount, 12);
  assert.equal(openai.recommendation.intervalSec, 7200);
  assert.match(openai.reason, /shared pool.*2 companies/i);
});

test('audit slows cadence when projected weekly use exceeds normal 50 percent target', () => {
  const audit = buildCadenceAudit({
    config: baseConfig(),
    agents,
    usageSnapshots: [snapshot('anthropic-subscription', 45, '2026-06-21T00:00:00.000Z')],
    now,
  });

  const gov = audit.pools.find((pool) => pool.poolId === 'anthropic-subscription');
  assert.equal(gov.mode, 'normal');
  assert.equal(gov.recommendation.intervalSec, 28800);
  assert.equal(gov.recommendation.enabled, true);
  assert.match(gov.reason, /projected weekly use.*above.*50/i);
  assert.equal(gov.proposedPatches[0].agentId, 'agent-gov');
  assert.equal(gov.proposedPatches[0].patch.runtimeConfig.heartbeat.intervalSec, 28800);
  assert.equal(gov.proposedPatches[0].patch.runtimeConfig.heartbeat.wakeOnDemand, true);
});

test('audit rush-fills remaining headroom in final hours before weekly reset', () => {
  const audit = buildCadenceAudit({
    config: baseConfig(),
    agents,
    usageSnapshots: [snapshot('openai-subscription', 61, '2026-06-18T14:00:00.000Z')],
    now,
  });

  const openai = audit.pools.find((pool) => pool.poolId === 'openai-subscription');
  assert.equal(openai.mode, 'rush_fill');
  assert.equal(openai.recommendation.intervalSec, 900);
  assert.equal(openai.recommendation.enabled, true);
  assert.match(openai.reason, /rush-fill/i);
});

test('audit pauses interval heartbeat when provider headroom is too low while preserving wake-on-demand', () => {
  const audit = buildCadenceAudit({
    config: baseConfig(),
    agents,
    usageSnapshots: [snapshot('openai-subscription', 98.5, '2026-06-18T14:00:00.000Z')],
    now,
  });

  const openai = audit.pools.find((pool) => pool.poolId === 'openai-subscription');
  assert.equal(openai.recommendation.enabled, false);
  assert.equal(openai.recommendation.intervalSec, null);
  assert.match(openai.reason, /hard stop/i);
  assert.equal(openai.proposedPatches[0].patch.runtimeConfig.heartbeat.enabled, false);
  assert.equal(openai.proposedPatches[0].patch.runtimeConfig.heartbeat.wakeOnDemand, true);
});

test('audit holds without proposing patches when weekly reset telemetry is missing', () => {
  const config = {
    enabled: true,
    pools: [{ poolId: 'openai-subscription', provider: 'openai-codex' }],
    participants: [{ participantId: 'wpr2-ceo', companyId: 'wpr2', agentId: 'agent-wpr2', providerPoolId: 'openai-subscription', role: 'CEO' }],
  };

  const audit = buildCadenceAudit({
    config,
    agents,
    usageSnapshots: [{
      providerPoolId: 'openai-subscription',
      windows: { weekly: { usagePct: 10 }, session_6h: { usagePct: 10 } },
      history: { days: 3, heartbeatCount: 1, totalUsagePct: 1 },
    }],
    now,
  });

  const openai = audit.pools.find((pool) => pool.poolId === 'openai-subscription');
  assert.equal(openai.mode, 'hold');
  assert.equal(openai.recommendation.action, 'hold');
  assert.equal(openai.proposedPatches.length, 0);
  assert.equal(audit.summary.patchCount, 0);
  assert.match(openai.decisionRecord.reason, /missing weekly resetAt/i);
});

test('apply mode patches changed CEO heartbeats once and reports unchanged decisions as idempotent', async () => {
  const patched = [];
  const store = new Map(agents.map((agent) => [agent.id, structuredClone(agent)]));
  const client = {
    async updateAgent(agentId, patch) {
      patched.push({ agentId, patch });
      const current = store.get(agentId);
      const next = { ...current, runtimeConfig: patch.runtimeConfig };
      store.set(agentId, next);
      return next;
    },
    async getAgent(agentId) {
      return store.get(agentId);
    },
  };

  const audit = buildCadenceAudit({
    config: baseConfig(),
    agents: Array.from(store.values()),
    usageSnapshots: [snapshot('anthropic-subscription', 45, '2026-06-21T00:00:00.000Z')],
    now,
  });

  const first = await applyCadenceRecommendations({ audit, client });
  const secondAudit = buildCadenceAudit({
    config: baseConfig(),
    agents: Array.from(store.values()),
    usageSnapshots: [snapshot('anthropic-subscription', 45, '2026-06-21T00:00:00.000Z')],
    now,
  });
  const second = await applyCadenceRecommendations({ audit: secondAudit, client });

  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].verified.heartbeat.intervalSec, 28800);
  assert.equal(second.actions.length, 0);
  assert.equal(second.skipped[0].reason, 'heartbeat_already_matches_recommendation');
  assert.equal(patched.length, 1);
});
