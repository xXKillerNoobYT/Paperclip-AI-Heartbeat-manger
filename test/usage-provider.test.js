import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCompanyCostLimit, mapQuotaWindowsToSnapshots, readUsageInputs } from '../src/usage-provider.js';

const now = '2026-06-15T12:00:00.000Z';

test('maps Paperclip quota windows into scheduler usage snapshots', () => {
  const snapshots = mapQuotaWindowsToSnapshots([
    { poolId: 'openai-main', provider: 'openai' },
  ], [
    {
      provider: 'openai',
      source: 'codex-rpc',
      ok: true,
      windows: [
        { label: '5h limit', usedPercent: 79, resetsAt: '2026-06-15T17:00:00.000Z' },
        { label: 'Weekly limit', usedPercent: 84, resetsAt: '2026-06-18T02:02:15.000Z' },
        { label: 'Credits', usedPercent: null, resetsAt: null, valueLabel: '$0.00 remaining' },
      ],
    },
  ], now);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].providerPoolId, 'openai-main');
  assert.equal(snapshots[0].windows.session_6h.usagePct, 79);
  assert.equal(snapshots[0].windows.weekly.usagePct, 84);
  assert.equal(snapshots[0].windows.weekly.source, 'paperclip_quota_windows');
});

test('maps provider aliases such as claude to Paperclip anthropic quota telemetry', () => {
  const snapshots = mapQuotaWindowsToSnapshots([
    { poolId: 'claude-main', provider: 'claude' },
  ], [
    {
      provider: 'anthropic',
      ok: true,
      windows: [
        { label: 'Current Session', usedPercent: 12, resetsAt: '2026-06-15T17:00:00.000Z' },
        { label: 'Weekly Limit', usedPercent: 20, resetsAt: '2026-06-18T02:02:15.000Z' },
      ],
    },
  ], now);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].providerPoolId, 'claude-main');
  assert.equal(snapshots[0].windows.session_6h.usagePct, 12);
});

test('company cost limit holds at monthly hard stop and allows zero-budget monitoring mode', () => {
  assert.equal(evaluateCompanyCostLimit({ ok: true, spendCents: 1000, budgetCents: 1000, activeIncidentCount: 0 }).decision, 'hold');
  assert.equal(evaluateCompanyCostLimit({ ok: true, spendCents: 1000, budgetCents: 0, activeIncidentCount: 0 }).decision, 'allow');
});

test('company cost limit holds when estimated wake would cross budget', () => {
  const result = evaluateCompanyCostLimit({ ok: true, spendCents: 950, budgetCents: 1000, activeIncidentCount: 0 }, { estimatedCostCents: 75 });

  assert.equal(result.decision, 'hold');
  assert.match(result.reason, /estimated wake cost/i);
});

test('Paperclip source reads quota and budget endpoints through adapter contract', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith('/costs/quota-windows')) {
      return jsonResponse([
        {
          provider: 'openai',
          source: 'codex-rpc',
          ok: true,
          windows: [
            { label: '5h limit', usedPercent: 20, resetsAt: '2026-06-15T17:00:00.000Z' },
            { label: 'Weekly limit', usedPercent: 25, resetsAt: '2026-06-18T02:02:15.000Z' },
          ],
        },
      ]);
    }
    if (url.endsWith('/costs/summary')) {
      return jsonResponse({ companyId: 'company-a', spendCents: 250, budgetCents: 1000, utilizationPercent: 25 });
    }
    if (url.endsWith('/budgets/overview')) {
      return jsonResponse({ policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0 });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await readUsageInputs({
    enabled: true,
    usageSource: { type: 'paperclip', baseUrl: 'http://paperclip.test/api', companyIds: ['company-a'] },
    pools: [{ poolId: 'openai-main', provider: 'openai' }],
    participants: [{ participantId: 'agent-a', companyId: 'company-a', providerPoolId: 'openai-main' }],
  }, { now, fetchImpl });

  assert.equal(result.usageSnapshots[0].windows.weekly.usagePct, 25);
  assert.equal(result.costLimits['company-a'].budgetCents, 1000);
  assert.equal(result.sourceDiagnostics.some((item) => item.source === 'paperclip_quota_windows' && item.ok), true);
  assert.equal(requested.length, 3);
});

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}
