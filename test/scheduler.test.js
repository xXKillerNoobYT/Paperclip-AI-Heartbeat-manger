import assert from 'node:assert/strict';
import test from 'node:test';

import { decideDryRun } from '../src/scheduler.js';

const now = '2026-06-15T12:00:00.000Z';
const config = {
  enabled: true,
  pools: [{ poolId: 'claude-main', provider: 'claude', hardStopAtPct: 98, staleTelemetryMaxAgeSec: 300 }],
  participants: [
    {
      participantId: 'gov-ceo',
      companyId: 'gov',
      agentId: 'agent-ceo',
      providerPoolId: 'claude-main',
      qualified: true,
      qualificationReason: 'CEO is explicitly plugin-qualified for GOV dry run',
      weight: 1,
      hasVisibleWork: true,
      turnsExpected: 1,
      turnsActual: 0,
      runCountWindow: { session_6h: 0, weekly: 0, daily: 0 },
    },
  ],
};
const snapshot = {
  providerPoolId: 'claude-main',
  collectedAt: now,
  windows: {
    session_6h: { usagePct: 10, resetAt: '2026-06-15T14:00:00.000Z', confidence: 'reported' },
    weekly: { usagePct: 20, resetAt: '2026-06-16T00:00:00.000Z', confidence: 'reported' },
  },
};

test('dry-run decision selects eligible participant and records evidence without invoking wake', () => {
  const decision = decideDryRun({ config, usageSnapshots: [snapshot], now });

  assert.equal(decision.type, 'wake');
  assert.equal(decision.dryRun, true);
  assert.equal(decision.invoked, false);
  assert.equal(decision.selectedParticipantId, 'gov-ceo');
  assert.equal(decision.providerPoolId, 'claude-main');
  assert.equal(decision.windowSnapshot.weeklyUsagePct, 20);
  assert.match(decision.reason, /dry-run/i);
});

test('blocked done and cancelled issue statuses are not actionable work', () => {
  const noWork = structuredClone(config);
  noWork.participants[0].hasVisibleWork = false;
  noWork.participants[0].assignedIssues = [
    { identifier: 'GOV-1', status: 'blocked' },
    { identifier: 'GOV-2', status: 'done' },
    { identifier: 'GOV-3', status: 'cancelled' },
  ];

  const decision = decideDryRun({ config: noWork, usageSnapshots: [snapshot], now });

  assert.equal(decision.type, 'hold');
  assert.match(decision.reason, /no eligible participant/i);
  assert.equal(decision.skipped[0].reason, 'no_visible_work');
});

test('non-CEO agent requires explicit qualification reason', () => {
  const badConfig = structuredClone(config);
  badConfig.participants[0].participantId = 'worker';
  badConfig.participants[0].role = 'BackendCoder';
  delete badConfig.participants[0].qualificationReason;

  const decision = decideDryRun({ config: badConfig, usageSnapshots: [snapshot], now });

  assert.equal(decision.type, 'hold');
  assert.match(decision.reason, /no eligible participant/i);
  assert.equal(decision.skipped[0].reason, 'missing_qualification_reason');
});

test('quota safety boundary holds when provider usage is above hard stop', () => {
  const highUsage = structuredClone(snapshot);
  highUsage.windows.weekly.usagePct = 99;

  const decision = decideDryRun({ config, usageSnapshots: [highUsage], now });

  assert.equal(decision.type, 'hold');
  assert.match(decision.reason, /hard stop|over/i);
});

test('missing required company cost-limit telemetry holds instead of waking', () => {
  const requireCostLimits = structuredClone(config);
  requireCostLimits.pools[0].requireCompanyCostLimit = true;

  const decision = decideDryRun({ config: requireCostLimits, usageSnapshots: [snapshot], now });

  assert.equal(decision.type, 'hold');
  assert.match(decision.reason, /no eligible participant/i);
  assert.equal(decision.skipped[0].reason, 'missing company cost limit telemetry');
});

test('company budget hard stop removes participant from wake selection', () => {
  const decision = decideDryRun({
    config,
    usageSnapshots: [snapshot],
    costLimits: {
      gov: { ok: true, companyId: 'gov', spendCents: 1000, budgetCents: 1000, activeIncidentCount: 0 },
    },
    now,
  });

  assert.equal(decision.type, 'hold');
  assert.match(decision.reason, /no eligible participant/i);
  assert.equal(decision.skipped[0].reason, 'company monthly budget hard stop blocks wake');
});

test('provider diagnostics match configured provider aliases before generic missing-telemetry hold', () => {
  const claudeConfig = structuredClone(config);
  claudeConfig.pools[0].provider = 'claude';

  const decision = decideDryRun({
    config: claudeConfig,
    usageSnapshots: [],
    sourceDiagnostics: [
      {
        source: 'paperclip_quota_windows',
        ok: false,
        provider: 'anthropic',
        reason: 'quota polling failed',
      },
    ],
    now,
  });

  assert.equal(decision.type, 'hold');
  assert.match(decision.reason, /provider telemetry unavailable for claude: quota polling failed/);
});
