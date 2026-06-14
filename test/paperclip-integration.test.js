import assert from 'node:assert/strict';
import test from 'node:test';

import { PaperclipClient } from '../src/paperclip-client.js';
import { discoverPaperclipParticipants } from '../src/paperclip-discovery.js';
import { buildWindows, readPaperclipUsage } from '../src/paperclip-usage-provider.js';

test('PaperclipClient exposes company, agent, issue, and cost endpoints used by the plugin', async () => {
  const calls = [];
  const client = new PaperclipClient({
    baseUrl: 'http://paperclip.local/api',
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  await client.getCompany('company-1');
  await client.listCompanyAgents('company-1');
  await client.listCompanyIssues('company-1', { limit: 250, offset: 50 });
  await client.getCostsByAgentModel('company-1', {
    from: '2026-06-15T00:00:00.000Z',
    to: '2026-06-15T06:00:00.000Z',
  });

  assert.deepEqual(calls, [
    'http://paperclip.local/api/companies/company-1',
    'http://paperclip.local/api/companies/company-1/agents',
    'http://paperclip.local/api/companies/company-1/issues?limit=250&offset=50',
    'http://paperclip.local/api/companies/company-1/costs/by-agent-model?from=2026-06-15T00%3A00%3A00.000Z&to=2026-06-15T06%3A00%3A00.000Z',
  ]);
});

test('discoverPaperclipParticipants turns Paperclip agents and assigned issues into fair wake candidates', async () => {
  const client = {
    getCompany: async () => ({ name: 'Government Watchdog', issuePrefix: 'GOV' }),
    listCompanyAgents: async () => [
      {
        id: 'agent-ceo',
        name: 'CEO',
        status: 'idle',
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 7200, wakeOnDemand: true, cooldownSec: 30 } },
      },
      {
        id: 'agent-disabled',
        name: 'Worker',
        status: 'disabled',
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    ],
    listCompanyIssues: async () => [
      { id: 'issue-1', identifier: 'GOV-1', status: 'todo', priority: 'high', title: 'Do visible work', assigneeAgentId: 'agent-ceo' },
      { id: 'issue-2', identifier: 'GOV-2', status: 'done', priority: 'high', title: 'Closed work', assigneeAgentId: 'agent-ceo' },
    ],
  };

  const participants = await discoverPaperclipParticipants({
    client,
    companyIds: ['company-1'],
    providerPoolId: 'claude-main',
    now: '2026-06-15T12:00:00.000Z',
  });

  assert.equal(participants.length, 2);
  assert.equal(participants[0].participantId, 'GOV:CEO');
  assert.equal(participants[0].qualified, true);
  assert.equal(participants[0].hasVisibleWork, true);
  assert.deepEqual(participants[0].assignedIssues.map((issue) => issue.identifier), ['GOV-1']);
  assert.equal(participants[1].qualified, false);
  assert.equal(participants[1].offlineReason, 'Paperclip agent status is disabled');
});

test('readPaperclipUsage builds session and weekly snapshots from Paperclip cost rows', async () => {
  const requestedRanges = [];
  const client = {
    getCostsByAgentModel: async (_companyId, range) => {
      requestedRanges.push(range);
      return [
        { provider: 'anthropic', biller: 'claude', billingType: 'subscription_included', model: 'claude-opus', agentId: 'agent-ceo', inputTokens: 100, cachedInputTokens: 50, outputTokens: 50, costCents: 0, runCount: 1 },
        { provider: 'openai', biller: 'codex', billingType: 'subscription_included', model: 'gpt-5.5', agentId: 'agent-other', inputTokens: 999, cachedInputTokens: 0, outputTokens: 0, costCents: 0, runCount: 1 },
      ];
    },
  };

  const snapshots = await readPaperclipUsage({
    client,
    companyId: 'company-1',
    now: '2026-06-15T12:00:00.000Z',
    pools: [{
      poolId: 'claude-main',
      provider: 'anthropic',
      biller: 'claude',
      paperclipAgentIds: ['agent-ceo'],
      sessionQuotaTokens: 1000,
      weeklyQuotaTokens: 2000,
      weeklyResetAt: '2026-06-16T00:00:00.000Z',
    }],
  });

  assert.equal(requestedRanges.length, 2);
  assert.equal(requestedRanges[0].from, '2026-06-15T06:00:00.000Z');
  assert.equal(requestedRanges[1].from, '2026-06-08T12:00:00.000Z');
  assert.equal(snapshots[0].providerPoolId, 'claude-main');
  assert.equal(snapshots[0].windows.session_6h.totalTokens, 200);
  assert.equal(snapshots[0].windows.session_6h.usagePct, 20);
  assert.equal(snapshots[0].windows.weekly.totalTokens, 200);
  assert.equal(snapshots[0].windows.weekly.usagePct, 10);
  assert.equal(snapshots[0].windows.weekly.resetAt, '2026-06-16T00:00:00.000Z');
});

test('buildWindows uses configured weekly start when a provider reports the real reset window', () => {
  const windows = buildWindows({
    poolId: 'claude-main',
    usageWindows: {
      weekly: {
        from: '2026-06-12T00:00:00.000Z',
        resetAt: '2026-06-19T00:00:00.000Z',
        quotaTokens: 1000,
      },
    },
  }, '2026-06-15T12:00:00.000Z');

  assert.equal(windows[1].from, '2026-06-12T00:00:00.000Z');
  assert.equal(windows[1].resetAt, '2026-06-19T00:00:00.000Z');
});
