import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildHoldPlan } from '../src/hold-plan.js';
import { executeLiveDecision } from '../src/live-executor.js';

const now = '2026-06-15T12:00:00.000Z';
const config = {
  live: {
    enabled: true,
    confirmationText: 'APPROVE LIVE TEST',
    forceFreshSession: true,
    reasonPrefix: 'test live mode',
  },
};

async function withLivePaths(prefix, fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn({
      idempotencyPath: path.join(tmp, 'idempotency.json'),
      decisionLogPath: path.join(tmp, 'decisions.jsonl'),
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test('live mode fails closed unless enabled and confirmed', async () => {
  await assert.rejects(
    () => executeLiveDecision({
      decision: { type: 'wake', agentId: 'agent-1' },
      client: new MockPaperclipClient(),
      config: { live: { enabled: false, confirmationText: 'APPROVE LIVE TEST' } },
      confirmation: 'APPROVE LIVE TEST',
      now,
    }),
    /live mode is disabled/,
  );

  await assert.rejects(
    () => executeLiveDecision({
      decision: { type: 'wake', agentId: 'agent-1' },
      client: new MockPaperclipClient(),
      config,
      confirmation: 'wrong',
      now,
    }),
    /confirmation mismatch/,
  );
});

test('live wake invokes Paperclip only after rechecking that the selected agent is not running', async () => {
  await withLivePaths('heartbeat-live-wake-', async ({ idempotencyPath, decisionLogPath }) => {
    const client = new MockPaperclipClient({
      agents: {
        'agent-1': { id: 'agent-1', name: 'CEO', status: 'idle', runtimeConfig: { heartbeat: { enabled: false } } },
      },
    });

    const result = await executeLiveDecision({
      decision: {
        decisionId: 'decision-1',
        type: 'wake',
        reason: 'quota has room',
        agentId: 'agent-1',
        companyId: 'company-1',
        providerPoolId: 'pool-1',
        selectedParticipantId: 'participant-1',
      },
      client,
      config,
      confirmation: 'APPROVE LIVE TEST',
      now,
      idempotencyPath,
      decisionLogPath,
    });

    assert.equal(result.invoked, true);
    assert.deepEqual(client.calls.map((call) => call.method), ['getAgent', 'wakeAgent']);
    assert.equal(client.calls[1].agentId, 'agent-1');
    assert.equal(client.calls[1].body.forceFreshSession, true);
    assert.match(client.calls[1].body.metadata.decisionId, /^live:wake:/);
  });
});

test('live wake idempotency uses stable operation fingerprint instead of timestamp decision ids', async () => {
  await withLivePaths('heartbeat-live-stable-fingerprint-', async ({ idempotencyPath, decisionLogPath }) => {
    const client = new MockPaperclipClient({
      agents: {
        'agent-1': { id: 'agent-1', name: 'CEO', status: 'idle', runtimeConfig: { heartbeat: { enabled: false } } },
      },
    });

    const baseDecision = {
      type: 'wake',
      reason: 'quota has room',
      agentId: 'agent-1',
      companyId: 'company-1',
      providerPoolId: 'pool-1',
      selectedParticipantId: 'participant-1',
    };

    const first = await executeLiveDecision({
      decision: { ...baseDecision, decisionId: '2026-06-15T12:00:00.000Z:pool-1:participant-1' },
      client,
      config,
      confirmation: 'APPROVE LIVE TEST',
      now: '2026-06-15T12:00:00.000Z',
      idempotencyPath,
      decisionLogPath,
    });
    const duplicate = await executeLiveDecision({
      decision: { ...baseDecision, decisionId: '2026-06-15T12:00:01.000Z:pool-1:participant-1' },
      client,
      config,
      confirmation: 'APPROVE LIVE TEST',
      now: '2026-06-15T12:00:01.000Z',
      idempotencyPath,
      decisionLogPath,
    });

    assert.equal(first.invoked, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.invoked, false);
    assert.equal(client.calls.filter((call) => call.method === 'wakeAgent').length, 1);
    assert.equal(first.decisionId, duplicate.decisionId);
  });
});

test('live wake preserves a selected agent that became running before execution', async () => {
  await withLivePaths('heartbeat-live-running-', async ({ idempotencyPath, decisionLogPath }) => {
    const client = new MockPaperclipClient({
      agents: {
        'agent-1': { id: 'agent-1', name: 'CEO', status: 'running', runtimeConfig: { heartbeat: { enabled: false } } },
      },
    });

    const result = await executeLiveDecision({
      decision: { decisionId: 'decision-running', type: 'wake', reason: 'quota has room', agentId: 'agent-1' },
      client,
      config,
      confirmation: 'APPROVE LIVE TEST',
      now,
      idempotencyPath,
      decisionLogPath,
    });

    assert.equal(result.invoked, false);
    assert.equal(result.skipped[0].reason, 'agent_currently_running_preserved');
    assert.deepEqual(client.calls.map((call) => call.method), ['getAgent']);
  });
});

test('live hold plan patches issues/agents, writes comments, records idempotency, and skips duplicates', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'heartbeat-live-'));
  try {
    const idempotencyPath = path.join(tmp, 'idempotency.json');
    const decisionLogPath = path.join(tmp, 'decisions.jsonl');
    const client = new MockPaperclipClient({
      issues: {
        'WEI-1': { id: 'issue-1', identifier: 'WEI-1', status: 'todo' },
      },
      agents: {
        'agent-1': {
          id: 'agent-1',
          name: 'BackendCoder',
          status: 'idle',
          runtimeConfig: { heartbeat: { enabled: true, intervalSec: 7200, wakeOnDemand: true } },
        },
      },
    });
    const holdPlan = {
      decisionId: 'hold-decision-1',
      issueActions: [{ identifier: 'WEI-1', id: 'issue-1', action: 'hold_issue', fromStatus: 'todo', toStatus: 'blocked', reason: 'weekly hard stop' }],
      skippedIssues: [],
      agentActions: [{ agentId: 'agent-1', agentName: 'BackendCoder', action: 'disable_interval_heartbeat', reason: 'weekly hard stop' }],
      skippedAgents: [],
      release: { resetAt: '2026-06-16T00:00:00.000Z' },
    };

    const result = await executeLiveDecision({
      holdPlan,
      client,
      config,
      confirmation: 'APPROVE LIVE TEST',
      now,
      idempotencyPath,
      decisionLogPath,
    });

    assert.equal(result.invoked, true);
    assert.equal(client.issues['WEI-1'].status, 'blocked');
    assert.equal(client.agents['agent-1'].runtimeConfig.heartbeat.enabled, false);
    assert.deepEqual(client.calls.map((call) => call.method), [
      'getIssue',
      'commentIssue',
      'updateIssue',
      'getAgent',
      'updateAgent',
    ]);
    assert.match(client.comments['WEI-1'][0], /Decision: live:hold_plan:/);

    const duplicate = await executeLiveDecision({
      holdPlan,
      client,
      config,
      confirmation: 'APPROVE LIVE TEST',
      now,
      idempotencyPath,
      decisionLogPath,
    });

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.invoked, false);
    assert.equal(client.calls.length, 5);

    const idempotency = JSON.parse(await readFile(idempotencyPath, 'utf8'));
    assert.equal(idempotency.decisions[result.decisionId].completed, true);
    const logLines = (await readFile(decisionLogPath, 'utf8')).trim().split('\n');
    assert.equal(logLines.length, 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('concurrent live wake decisions fence the same decision id to one Paperclip mutation', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'heartbeat-live-concurrent-'));
  try {
    const idempotencyPath = path.join(tmp, 'idempotency.json');
    const decisionLogPath = path.join(tmp, 'decisions.jsonl');
    const client = new MockPaperclipClient({
      agents: {
        'agent-1': { id: 'agent-1', name: 'CEO', status: 'idle', runtimeConfig: { heartbeat: { enabled: false } } },
      },
      delayMethods: new Set(['wakeAgent']),
    });
    const decision = {
      decisionId: 'concurrent-decision-1',
      type: 'wake',
      reason: 'quota has room',
      agentId: 'agent-1',
      companyId: 'company-1',
      providerPoolId: 'pool-1',
      selectedParticipantId: 'participant-1',
    };

    const results = await Promise.all([
      executeLiveDecision({ decision, client, config, confirmation: 'APPROVE LIVE TEST', now, idempotencyPath, decisionLogPath }),
      executeLiveDecision({ decision, client, config, confirmation: 'APPROVE LIVE TEST', now, idempotencyPath, decisionLogPath }),
    ]);

    assert.equal(results.filter((result) => result.invoked).length, 1);
    assert.equal(results.filter((result) => result.duplicate).length, 1);
    assert.equal(client.calls.filter((call) => call.method === 'wakeAgent').length, 1);
    assert.ok(results.find((result) => result.invoked).actions[0].response);
    const logLines = (await readFile(decisionLogPath, 'utf8')).trim().split('\n');
    assert.equal(logLines.length, 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('live release plan restores only planned issue status and heartbeat settings', async () => {
  await withLivePaths('heartbeat-live-release-', async ({ idempotencyPath, decisionLogPath }) => {
    const client = new MockPaperclipClient({
      issues: {
        'WEI-7': { id: 'issue-7', identifier: 'WEI-7', status: 'blocked' },
      },
      agents: {
        'agent-7': {
          id: 'agent-7',
          name: 'Held Agent',
          status: 'idle',
          runtimeConfig: { heartbeat: { enabled: false, intervalSec: 7200, wakeOnDemand: true } },
        },
      },
    });

    const result = await executeLiveDecision({
      holdPlan: {
        decisionId: 'release-decision-1',
        issueActions: [{ identifier: 'WEI-7', id: 'issue-7', action: 'resume_issue', fromStatus: 'blocked', toStatus: 'todo', reason: 'weekly reset' }],
        skippedIssues: [],
        agentActions: [{ agentId: 'agent-7', agentName: 'Held Agent', action: 'restore_interval_heartbeat', reason: 'weekly reset' }],
        skippedAgents: [],
        release: { resetAt: now },
      },
      client,
      config,
      confirmation: 'APPROVE LIVE TEST',
      now,
      idempotencyPath,
      decisionLogPath,
    });

    assert.equal(result.invoked, true);
    assert.equal(client.issues['WEI-7'].status, 'todo');
    assert.equal(client.agents['agent-7'].runtimeConfig.heartbeat.enabled, true);
    assert.match(client.comments['WEI-7'][0], /hold released/);
  });
});

test('live hold persists hold state that a later release plan can consume', async () => {
  await withLivePaths('heartbeat-live-durable-hold-', async ({ idempotencyPath, decisionLogPath }) => {
    const client = new MockPaperclipClient({
      issues: {
        'WEI-9': { id: 'issue-9', identifier: 'WEI-9', status: 'todo' },
      },
      agents: {
        'agent-9': {
          id: 'agent-9',
          name: 'Held Agent',
          status: 'idle',
          runtimeConfig: { heartbeat: { enabled: true, intervalSec: 7200, wakeOnDemand: true } },
        },
      },
    });
    const holdPlan = buildHoldPlan({
      companyId: 'company-1',
      generatedAt: now,
      trigger: { state: 'hold', reason: 'weekly hard stop', resetAt: '2026-06-16T00:00:00.000Z' },
      issues: Object.values(client.issues),
      agents: Object.values(client.agents),
    });

    await executeLiveDecision({
      holdPlan,
      client,
      config,
      confirmation: 'APPROVE LIVE TEST',
      now,
      idempotencyPath,
      decisionLogPath,
    });

    assert.equal(client.issues['WEI-9'].status, 'blocked');
    assert.equal(client.issues['WEI-9'].holdState.source, 'heartbeat_manager_hold_plan');
    assert.equal(client.issues['WEI-9'].holdState.previousStatus, 'todo');
    assert.equal(client.agents['agent-9'].holdState.source, 'heartbeat_manager_hold_plan');
    assert.equal(client.agents['agent-9'].holdState.previousHeartbeatEnabled, true);

    const releasePlan = buildHoldPlan({
      companyId: 'company-1',
      generatedAt: '2026-06-16T00:00:00.000Z',
      trigger: { state: 'release', reason: 'weekly reset' },
      issues: Object.values(client.issues),
      agents: Object.values(client.agents),
    });

    assert.equal(releasePlan.issueActions[0].action, 'resume_issue');
    assert.equal(releasePlan.issueActions[0].toStatus, 'todo');
    assert.equal(releasePlan.agentActions[0].action, 'restore_interval_heartbeat');

    await executeLiveDecision({
      holdPlan: releasePlan,
      client,
      config,
      confirmation: 'APPROVE LIVE TEST',
      now: '2026-06-16T00:00:00.000Z',
      idempotencyPath,
      decisionLogPath,
    });

    assert.equal(client.issues['WEI-9'].status, 'todo');
    assert.equal(client.issues['WEI-9'].holdState, null);
    assert.equal(client.agents['agent-9'].runtimeConfig.heartbeat.enabled, true);
    assert.equal(client.agents['agent-9'].holdState, null);
  });
});

test('live hold execution surfaces Paperclip API failures instead of marking duplicate complete', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'heartbeat-live-failure-'));
  try {
    const idempotencyPath = path.join(tmp, 'idempotency.json');
    const decisionLogPath = path.join(tmp, 'decisions.jsonl');
    const client = new MockPaperclipClient({
      issues: {
        'WEI-FAIL': { id: 'issue-fail', identifier: 'WEI-FAIL', status: 'todo' },
      },
      failMethods: new Set(['updateIssue']),
    });

    await assert.rejects(
      () => executeLiveDecision({
        holdPlan: {
          decisionId: 'hold-failure-1',
          issueActions: [{ identifier: 'WEI-FAIL', id: 'issue-fail', action: 'hold_issue', fromStatus: 'todo', toStatus: 'blocked', reason: 'api failure check' }],
          skippedIssues: [],
          agentActions: [],
          skippedAgents: [],
          release: {},
        },
        client,
        config,
        confirmation: 'APPROVE LIVE TEST',
        now,
        idempotencyPath,
        decisionLogPath,
      }),
      /mock updateIssue failure/,
    );

    const idempotency = JSON.parse(await readFile(idempotencyPath, 'utf8'));
    const [storedDecision] = Object.values(idempotency.decisions);
    assert.match(storedDecision.decisionId, /^live:hold_plan:/);
    assert.equal(storedDecision.completed, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


test('live mode requires durable idempotency store path before Paperclip mutation', async () => {
  await withLivePaths('heartbeat-live-missing-idempotency-', async ({ decisionLogPath }) => {
    const client = new MockPaperclipClient({
      agents: {
        'agent-1': { id: 'agent-1', name: 'CEO', status: 'idle' },
      },
    });

    await assert.rejects(
      () => executeLiveDecision({
        decision: { decisionId: 'missing-idempotency', type: 'wake', reason: 'quota has room', agentId: 'agent-1' },
        client,
        config,
        confirmation: 'APPROVE LIVE TEST',
        now,
        decisionLogPath,
      }),
      /idempotency store path/,
    );

    assert.deepEqual(client.calls, []);
  });
});

test('live mode requires durable decision log path before Paperclip mutation', async () => {
  await withLivePaths('heartbeat-live-missing-decision-log-', async ({ idempotencyPath }) => {
    const client = new MockPaperclipClient({
      agents: {
        'agent-1': { id: 'agent-1', name: 'CEO', status: 'idle' },
      },
    });

    await assert.rejects(
      () => executeLiveDecision({
        decision: { decisionId: 'missing-decision-log', type: 'wake', reason: 'quota has room', agentId: 'agent-1' },
        client,
        config,
        confirmation: 'APPROVE LIVE TEST',
        now,
        idempotencyPath,
      }),
      /decision log path/,
    );

    assert.deepEqual(client.calls, []);
  });
});

class MockPaperclipClient {
  constructor({ issues = {}, agents = {}, failMethods = new Set(), delayMethods = new Set() } = {}) {
    this.issues = structuredClone(issues);
    this.agents = structuredClone(agents);
    this.failMethods = failMethods;
    this.delayMethods = delayMethods;
    this.comments = {};
    this.calls = [];
  }

  async getIssue(identifier) {
    this.calls.push({ method: 'getIssue', identifier });
    return structuredClone(this.issues[identifier]);
  }

  async updateIssue(identifier, body) {
    if (this.failMethods.has('updateIssue')) throw new Error('mock updateIssue failure');
    this.calls.push({ method: 'updateIssue', identifier, body });
    this.issues[identifier] = { ...this.issues[identifier], ...body };
    return structuredClone(this.issues[identifier]);
  }

  async commentIssue(identifier, body) {
    this.calls.push({ method: 'commentIssue', identifier, body });
    this.comments[identifier] ??= [];
    this.comments[identifier].push(typeof body === 'string' ? body : body.body);
    return { id: `comment-${this.comments[identifier].length}`, body: this.comments[identifier].at(-1) };
  }

  async getAgent(agentId) {
    this.calls.push({ method: 'getAgent', agentId });
    return structuredClone(this.agents[agentId]);
  }

  async updateAgent(agentId, body) {
    this.calls.push({ method: 'updateAgent', agentId, body });
    this.agents[agentId] = { ...this.agents[agentId], ...body };
    return structuredClone(this.agents[agentId]);
  }

  async wakeAgent(agentId, body) {
    if (this.delayMethods.has('wakeAgent')) await sleep(50);
    this.calls.push({ method: 'wakeAgent', agentId, body });
    return { queued: true, runId: 'run-1', agentId, body };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
