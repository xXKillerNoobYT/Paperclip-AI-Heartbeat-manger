import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverPaperclipParticipants } from '../src/paperclip-discovery.js';

const now = '2026-06-15T12:00:00.000Z';

class FakeClient {
  async getCompany(companyId) {
    assert.equal(companyId, 'company-1');
    return { id: companyId, name: 'Demo Company', issuePrefix: 'DEM' };
  }

  async listCompanyAgents(companyId) {
    assert.equal(companyId, 'company-1');
    return [
      {
        id: 'agent-ceo',
        name: 'CEO',
        role: 'general',
        status: 'idle',
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 7200 } },
      },
      {
        id: 'agent-worker',
        name: 'BackendCoder',
        role: 'coder',
        status: 'error',
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      },
      {
        id: 'agent-disabled',
        name: 'DisabledAgent',
        role: 'qa',
        status: 'disabled',
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    ];
  }

  async listCompanyIssues(companyId, options) {
    assert.equal(companyId, 'company-1');
    assert.equal(options.limit, 500);
    return [
      { id: 'issue-1', identifier: 'DEM-1', title: 'Do it', status: 'todo', priority: 'high', assigneeAgentId: 'agent-ceo' },
      { id: 'issue-2', identifier: 'DEM-2', title: 'Not actionable', status: 'blocked', priority: 'medium', assigneeAgentId: 'agent-ceo' },
      { id: 'issue-3', identifier: 'DEM-3', title: 'Worker item', status: 'in_progress', priority: 'medium', assigneeAgentId: 'agent-worker' },
    ];
  }
}

test('discovers wake-capable Paperclip agents and assigned actionable issues', async () => {
  const participants = await discoverPaperclipParticipants({
    client: new FakeClient(),
    companyIds: ['company-1'],
    providerPoolId: 'codex-main',
    now,
  });

  const ceo = participants.find((participant) => participant.agentId === 'agent-ceo');
  assert.equal(ceo.participantId, 'DEM:CEO');
  assert.equal(ceo.role, 'CEO');
  assert.equal(ceo.providerPoolId, 'codex-main');
  assert.equal(ceo.qualified, true);
  assert.equal(ceo.hasVisibleWork, true);
  assert.deepEqual(ceo.assignedIssues.map((issue) => issue.identifier), ['DEM-1']);
  assert.equal(ceo.weight, 2);

  const worker = participants.find((participant) => participant.agentId === 'agent-worker');
  assert.equal(worker.qualified, true);
  assert.equal(worker.hasVisibleWork, true);
  assert.equal(worker.assignedIssues[0].identifier, 'DEM-3');
  assert.equal(worker.offlineReason, 'Paperclip agent status is error');
  assert.equal(worker.offlineUntil, '2026-06-15T13:00:00.000Z');

  const disabled = participants.find((participant) => participant.agentId === 'agent-disabled');
  assert.equal(disabled.qualified, false);
  assert.equal(disabled.hasVisibleWork, false);
});
