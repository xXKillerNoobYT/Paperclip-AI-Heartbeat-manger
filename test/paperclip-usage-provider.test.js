import assert from 'node:assert/strict';
import test from 'node:test';

import { PaperclipClient } from '../src/paperclip-client.js';
import { readPaperclipUsage, usageSnapshotForPool } from '../src/paperclip-usage-provider.js';

const now = '2026-06-15T12:00:00.000Z';

test('PaperclipClient exposes cost/quota endpoints used by the plugin', async () => {
  const seen = [];
  const client = new PaperclipClient({
    baseUrl: 'http://paperclip.local/api',
    fetchImpl: async (url) => {
      seen.push(url);
      return response([]);
    },
  });

  await client.getQuotaWindows('company-1');
  await client.getProviderCosts('company-1', { from: '2026-06-01T00:00:00.000Z' });
  await client.getWindowSpend('company-1');

  assert.deepEqual(seen, [
    'http://paperclip.local/api/companies/company-1/costs/quota-windows',
    'http://paperclip.local/api/companies/company-1/costs/by-provider?from=2026-06-01T00%3A00%3A00.000Z',
    'http://paperclip.local/api/companies/company-1/costs/window-spend',
  ]);
});

test('Paperclip quota windows are normalized into scheduler usage snapshots', async () => {
  const client = {
    async getQuotaWindows(companyId) {
      assert.equal(companyId, 'company-1');
      return [
        {
          provider: 'openai',
          source: 'codex-rpc',
          ok: true,
          windows: [
            { label: '5h limit', usedPercent: 85, resetsAt: '2026-06-15T15:00:00.000Z' },
            { label: 'Weekly limit', usedPercent: 67, resetsAt: '2026-06-18T02:06:09.000Z' },
          ],
        },
      ];
    },
  };

  const snapshots = await readPaperclipUsage({
    client,
    companyId: 'company-1',
    now,
    pools: [{ poolId: 'openai-main', provider: 'openai' }],
  });

  assert.deepEqual(snapshots, [
    {
      providerPoolId: 'openai-main',
      collectedAt: now,
      source: 'paperclip-costs/quota-windows',
      provider: 'openai',
      ok: true,
      paperclipSource: 'codex-rpc',
      windows: {
        session_6h: {
          usagePct: 85,
          resetAt: '2026-06-15T15:00:00.000Z',
          confidence: 'reported',
          label: '5h limit',
          valueLabel: null,
        },
        weekly: {
          usagePct: 67,
          resetAt: '2026-06-18T02:06:09.000Z',
          confidence: 'reported',
          label: 'Weekly limit',
          valueLabel: null,
        },
      },
    },
  ]);
});

test('Paperclip quota windows are preferred when a client also exposes by-agent-model costs', async () => {
  const calls = [];
  const client = {
    async getQuotaWindows(companyId) {
      calls.push(['quota', companyId]);
      return [
        {
          provider: 'openai',
          ok: true,
          windows: [
            { label: '5h limit', usedPercent: 42, resetsAt: '2026-06-15T15:00:00.000Z' },
            { label: 'Weekly limit', usedPercent: 21, resetsAt: '2026-06-18T02:06:09.000Z' },
          ],
        },
      ];
    },
    async getCostsByAgentModel() {
      calls.push(['by-agent-model']);
      throw new Error('quota windows should be preferred when available');
    },
  };

  const snapshots = await readPaperclipUsage({
    client,
    companyId: 'company-1',
    now,
    pools: [{ poolId: 'openai-main', provider: 'openai-codex' }],
  });

  assert.deepEqual(calls, [['quota', 'company-1']]);
  assert.equal(snapshots[0].source, 'paperclip-costs/quota-windows');
  assert.equal(snapshots[0].windows.weekly.usagePct, 21);
});

test('provider aliases match quota-window telemetry rows', () => {
  const openai = usageSnapshotForPool(
    { poolId: 'openai-main', provider: 'openai-codex' },
    [{ provider: 'openai', ok: true, windows: [{ label: 'Weekly limit', usedPercent: 33, resetsAt: '2026-06-18T02:06:09.000Z' }] }],
    now,
  );
  const anthropic = usageSnapshotForPool(
    { poolId: 'claude-main', provider: 'claude' },
    [{ provider: 'anthropic', ok: true, windows: [{ label: 'Weekly limit', usedPercent: 44, resetsAt: '2026-06-18T02:06:09.000Z' }] }],
    now,
  );

  assert.equal(openai.ok, true);
  assert.equal(openai.provider, 'openai');
  assert.equal(openai.windows.weekly.usagePct, 33);
  assert.equal(anthropic.ok, true);
  assert.equal(anthropic.provider, 'anthropic');
  assert.equal(anthropic.windows.weekly.usagePct, 44);
});

test('failed Paperclip quota polling becomes safe missing telemetry', () => {
  const snapshot = usageSnapshotForPool(
    { poolId: 'claude-main', provider: 'anthropic' },
    [{ provider: 'anthropic', ok: false, error: 'quota api returned 429', windows: [] }],
    now,
  );

  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.error, 'quota api returned 429');
  assert.equal(snapshot.windows.session_6h.confidence, 'missing');
  assert.equal(snapshot.windows.weekly.confidence, 'missing');
});

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}
