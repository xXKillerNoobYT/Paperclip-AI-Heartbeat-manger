import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHoldPlan } from '../src/hold-plan.js';

const generatedAt = '2026-06-15T12:00:00.000Z';

test('hold plan excludes closed, running, recovery, and already-blocked issues while preserving dry-run boundary', () => {
  const plan = buildHoldPlan({
    companyId: 'company-1',
    generatedAt,
    trigger: {
      state: 'hold',
      reason: 'OpenAI weekly usage hard stop reached',
      resetAt: '2026-06-16T00:00:00.000Z',
    },
    issues: [
      { id: 'issue-1', identifier: 'WEI-1', status: 'todo', priority: 'high', title: 'safe to hold' },
      { id: 'issue-1b', identifier: 'WEI-1B', status: 'in_progress', priority: 'high', title: 'assigned but not live-running' },
      { id: 'issue-2', identifier: 'WEI-2', status: 'done', priority: 'high', title: 'closed' },
      { id: 'issue-3', identifier: 'WEI-3', status: 'cancelled', priority: 'high', title: 'cancelled' },
      { id: 'issue-4', identifier: 'WEI-4', status: 'blocked', priority: 'medium', title: 'already blocked' },
      {
        id: 'issue-5',
        identifier: 'WEI-5',
        status: 'todo',
        priority: 'medium',
        title: 'recovery path',
        activeRecoveryAction: { cause: 'adapter_failed' },
      },
      {
        id: 'issue-6',
        identifier: 'WEI-6',
        status: 'in_progress',
        priority: 'critical',
        title: 'running agent work',
        liveRunActive: true,
      },
    ],
    agents: [
      {
        id: 'agent-idle',
        name: 'Idle heartbeat agent',
        status: 'idle',
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 7200, wakeOnDemand: true } },
      },
      {
        id: 'agent-running',
        name: 'Running agent',
        status: 'running',
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 7200, wakeOnDemand: true } },
      },
    ],
  });

  assert.equal(plan.mode, 'dry_run');
  assert.equal(plan.mutationsEnabled, false);
  assert.equal(plan.requiresOwnerApprovalForLiveMutation, true);
  assert.deepEqual(plan.policy.actionableStatuses, ['backlog', 'in_progress', 'todo']);
  assert.deepEqual(plan.issueActions, [
    {
      identifier: 'WEI-1',
      id: 'issue-1',
      action: 'hold_issue',
      fromStatus: 'todo',
      toStatus: 'blocked',
      reason: 'OpenAI weekly usage hard stop reached',
    },
    {
      identifier: 'WEI-1B',
      id: 'issue-1b',
      action: 'hold_issue',
      fromStatus: 'in_progress',
      toStatus: 'blocked',
      reason: 'OpenAI weekly usage hard stop reached',
    },
  ]);

  const skippedIssues = Object.fromEntries(plan.skippedIssues.map((item) => [item.identifier, item.reason]));
  assert.equal(skippedIssues['WEI-2'], 'closed_status_excluded');
  assert.equal(skippedIssues['WEI-3'], 'closed_status_excluded');
  assert.equal(skippedIssues['WEI-4'], 'already_blocked_preserved');
  assert.equal(skippedIssues['WEI-5'], 'active_recovery_action_preserved');
  assert.equal(skippedIssues['WEI-6'], 'currently_running_preserved');

  assert.deepEqual(plan.agentActions, [
    {
      agentId: 'agent-idle',
      agentName: 'Idle heartbeat agent',
      action: 'disable_interval_heartbeat',
      reason: 'OpenAI weekly usage hard stop reached',
    },
  ]);
  assert.deepEqual(plan.skippedAgents, [
    {
      agentId: 'agent-running',
      agentName: 'Running agent',
      reason: 'currently_running_preserved',
    },
  ]);
});

test('reset release plan resumes only hold-plan-managed issues and heartbeats', () => {
  const plan = buildHoldPlan({
    companyId: 'company-1',
    generatedAt,
    trigger: {
      state: 'release',
      reason: 'weekly/session usage window reset',
      resetAt: '2026-06-15T12:00:00.000Z',
    },
    issues: [
      {
        id: 'held-issue',
        identifier: 'WEI-7',
        status: 'blocked',
        priority: 'high',
        title: 'held by policy',
        holdState: { source: 'heartbeat_manager_hold_plan', previousStatus: 'todo' },
      },
      { id: 'blocked-other', identifier: 'WEI-8', status: 'blocked', priority: 'high', title: 'real blocker' },
      {
        id: 'done-held',
        identifier: 'WEI-9',
        status: 'done',
        priority: 'high',
        title: 'closed held work',
        holdState: { source: 'heartbeat_manager_hold_plan', previousStatus: 'todo' },
      },
    ],
    agents: [
      {
        id: 'held-agent',
        name: 'Held heartbeat agent',
        status: 'idle',
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        holdState: { source: 'heartbeat_manager_hold_plan', previousHeartbeatEnabled: true },
      },
      {
        id: 'unrelated-agent',
        name: 'Unrelated disabled agent',
        status: 'idle',
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      },
    ],
  });

  assert.equal(plan.release.eligible, true);
  assert.deepEqual(plan.issueActions, [
    {
      identifier: 'WEI-7',
      id: 'held-issue',
      action: 'resume_issue',
      fromStatus: 'blocked',
      toStatus: 'todo',
      reason: 'weekly/session usage window reset',
    },
  ]);

  const skippedIssues = Object.fromEntries(plan.skippedIssues.map((item) => [item.identifier, item.reason]));
  assert.equal(skippedIssues['WEI-8'], 'not_hold_plan_managed');
  assert.equal(skippedIssues['WEI-9'], 'closed_status_excluded');
  assert.deepEqual(plan.agentActions, [
    {
      agentId: 'held-agent',
      agentName: 'Held heartbeat agent',
      action: 'restore_interval_heartbeat',
      reason: 'weekly/session usage window reset',
    },
  ]);
  assert.deepEqual(plan.skippedAgents, [
    {
      agentId: 'unrelated-agent',
      agentName: 'Unrelated disabled agent',
      reason: 'not_hold_plan_managed',
    },
  ]);
});
