import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOperatorReport, renderOperatorDashboardHtml } from '../src/operator-report.js';

const now = '2026-06-15T12:00:00.000Z';
const config = {
  pools: [
    { poolId: 'claude-main', provider: 'claude', hardStopAtPct: 98 },
    { poolId: 'openai-main', provider: 'openai', hardStopAtPct: 95 },
  ],
  participants: [
    { participantId: 'gov-ceo', companyId: 'gov', agentId: 'agent-ceo', providerPoolId: 'claude-main' },
    { participantId: 'wei-ceo', companyId: 'wei', agentId: 'agent-wei', providerPoolId: 'openai-main' },
  ],
};

const snapshots = [
  {
    providerPoolId: 'claude-main',
    provider: 'claude',
    collectedAt: now,
    windows: {
      session_6h: { usagePct: 12, resetAt: '2026-06-15T18:00:00.000Z', confidence: 'reported' },
      weekly: { usagePct: 40, resetAt: '2026-06-16T00:00:00.000Z', confidence: 'reported' },
    },
  },
  {
    providerPoolId: 'openai-main',
    provider: 'openai',
    collectedAt: now,
    windows: {
      session_6h: { usagePct: 91, resetAt: '2026-06-15T18:00:00.000Z', confidence: 'reported' },
      weekly: { usagePct: 99, resetAt: '2026-06-22T00:00:00.000Z', confidence: 'reported' },
    },
  },
];

const wakeDecision = {
  type: 'wake',
  reason: 'dry-run only: final-day ramp permits wake',
  providerPoolId: 'claude-main',
  selectedParticipantId: 'gov-ceo',
  companyId: 'gov',
  agentId: 'agent-ceo',
  weeklyMode: 'final_day_ramp',
  windowSnapshot: { sessionUsagePct: 12, weeklyUsagePct: 40, sessionResetAt: '2026-06-15T18:00:00.000Z', weeklyResetAt: '2026-06-16T00:00:00.000Z' },
  expectedCost: { sessionPct: 2, weeklyPct: null },
  skipped: [{ participantId: 'wei-ceo', reason: 'different_provider_pool' }],
  fairnessRanking: [{ participantId: 'gov-ceo', deficitScore: 1, weight: 1, lastRunAt: null }],
};

test('operator report summarizes pools, reset timers, burn posture, holds, and next wake choice', () => {
  const report = buildOperatorReport({ config, usageSnapshots: snapshots, decisions: [wakeDecision], now });

  assert.equal(report.generatedAt, now);
  assert.equal(report.providerPools.length, 2);
  assert.deepEqual(report.providerPools[0], {
    poolId: 'claude-main',
    provider: 'claude',
    sessionUsagePct: 12,
    weeklyUsagePct: 40,
    sessionResetAt: '2026-06-15T18:00:00.000Z',
    weeklyResetAt: '2026-06-16T00:00:00.000Z',
    hoursUntilSessionReset: 6,
    hoursUntilWeeklyReset: 12,
    hardStopAtPct: 98,
    posture: 'final_day_ramp',
    optimalWeeklyUsagePct: 50,
    actualVsOptimalPct: -10,
    safetyMarginPct: 58,
    statusLabel: 'Final-day ramp: safe to spend remaining weekly capacity before reset.',
  });
  assert.equal(report.providerPools[1].posture, 'hard_stop_risk');
  assert.equal(report.nextWake.selectedParticipantId, 'gov-ceo');
  assert.equal(report.heldWork[0].participantId, 'wei-ceo');
  assert.match(report.plainEnglishSummary, /final-day ramp permits wake/i);
});

test('operator report marks missing telemetry as held work with a release/resume time', () => {
  const report = buildOperatorReport({
    config,
    usageSnapshots: [],
    decisions: [{ type: 'hold', providerPoolId: 'claude-main', reason: 'missing telemetry for pool claude-main', skipped: [] }],
    sourceDiagnostics: [{ source: 'paperclip_quota_windows', ok: false, provider: 'anthropic', reason: 'quota endpoint unavailable' }],
    now,
  });

  assert.equal(report.providerPools[0].posture, 'missing_telemetry');
  assert.equal(report.providerPools[0].statusLabel, 'Held: provider telemetry is missing or unavailable.');
  assert.equal(report.heldWork[0].reason, 'missing telemetry for pool claude-main');
  assert.equal(report.upcomingRelease.releaseAt, '2026-06-15T12:15:00.000Z');
});

test('operator dashboard HTML is browser-reviewable and exposes accessible status text', () => {
  const report = buildOperatorReport({ config, usageSnapshots: snapshots, decisions: [wakeDecision], now });
  const html = renderOperatorDashboardHtml(report);

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<main aria-labelledby="dashboard-title">/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="Provider pool claude-main status"/);
  assert.match(html, /Desktop\/tablet\/mobile verification floor/);
  assert.match(html, /final-day ramp permits wake/);
});
