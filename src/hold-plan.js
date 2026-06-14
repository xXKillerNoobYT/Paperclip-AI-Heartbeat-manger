const CLOSED_STATUSES = new Set(['done', 'cancelled']);
const ACTIONABLE_STATUSES = new Set(['todo', 'backlog', 'in_progress']);
const RUNNING_AGENT_STATUSES = new Set(['running', 'busy', 'working', 'in_progress']);
const HOLD_STATES = new Set(['hold', 'over_limit', 'limited', 'exhausted']);
const RELEASE_STATES = new Set(['release', 'available', 'ok', 'under_limit', 'reset']);
const HOLD_SOURCE = 'heartbeat_manager_hold_plan';

export function buildHoldPlan({ companyId, generatedAt = new Date().toISOString(), trigger = {}, issues = [], agents = [] } = {}) {
  const state = normalizeState(trigger.state);
  const reason = trigger.reason ?? 'heartbeat manager hold policy';
  let issuePlan;
  let agentPlan;
  let releaseEligible = false;

  if (HOLD_STATES.has(state)) {
    issuePlan = planIssueHolds(issues, reason);
    agentPlan = planAgentHolds(agents, reason);
  } else if (RELEASE_STATES.has(state)) {
    issuePlan = planIssueReleases(issues, reason);
    agentPlan = planAgentReleases(agents, reason);
    releaseEligible = true;
  } else {
    issuePlan = {
      actions: [],
      skipped: issues.map((issue) => issueSkip(issue, 'hold_trigger_state_not_recognized')),
    };
    agentPlan = {
      actions: [],
      skipped: agents.map((agent) => agentSkip(agent, 'hold_trigger_state_not_recognized')),
    };
  }

  return {
    companyId,
    generatedAt,
    mode: 'dry_run',
    mutationsEnabled: false,
    requiresOwnerApprovalForLiveMutation: true,
    trigger,
    issueActions: issuePlan.actions,
    skippedIssues: issuePlan.skipped,
    agentActions: agentPlan.actions,
    skippedAgents: agentPlan.skipped,
    release: {
      eligible: releaseEligible,
      resetAt: trigger.resetAt ?? null,
      reason: trigger.reason ?? null,
    },
    policy: {
      holdSource: HOLD_SOURCE,
      closedStatusesExcluded: [...CLOSED_STATUSES].sort(),
      actionableStatuses: [...ACTIONABLE_STATUSES].sort(),
      alreadyBlockedIssuesPreserved: true,
      activeRecoveryActionsPreserved: true,
      runningIssuesPreserved: true,
      runningAgentsPreserved: true,
      liveMutationRequiresOwnerApproval: true,
    },
  };
}

export function holdSource() {
  return HOLD_SOURCE;
}

function planIssueHolds(issues, reason) {
  const actions = [];
  const skipped = [];

  for (const issue of issues) {
    const status = normalizeStatus(issue.status);
    if (CLOSED_STATUSES.has(status)) {
      skipped.push(issueSkip(issue, 'closed_status_excluded'));
      continue;
    }
    if (status === 'blocked') {
      skipped.push(issueSkip(issue, 'already_blocked_preserved'));
      continue;
    }
    if (issue.activeRecoveryAction) {
      skipped.push(issueSkip(issue, 'active_recovery_action_preserved'));
      continue;
    }
    if (issueHasRunningWork(issue)) {
      skipped.push(issueSkip(issue, 'currently_running_preserved'));
      continue;
    }
    if (!ACTIONABLE_STATUSES.has(status)) {
      skipped.push(issueSkip(issue, 'status_not_actionable_for_hold'));
      continue;
    }

    actions.push({
      identifier: issue.identifier,
      id: issue.id,
      action: 'hold_issue',
      fromStatus: status,
      toStatus: 'blocked',
      reason,
    });
  }

  return { actions, skipped };
}

function planIssueReleases(issues, reason) {
  const actions = [];
  const skipped = [];

  for (const issue of issues) {
    const status = normalizeStatus(issue.status);
    if (CLOSED_STATUSES.has(status)) {
      skipped.push(issueSkip(issue, 'closed_status_excluded'));
      continue;
    }
    if (!isHoldManaged(issue)) {
      skipped.push(issueSkip(issue, 'not_hold_plan_managed'));
      continue;
    }
    if (issueHasRunningWork(issue)) {
      skipped.push(issueSkip(issue, 'currently_running_preserved'));
      continue;
    }

    let toStatus = normalizeStatus(issue.holdState?.previousStatus ?? 'todo');
    if (CLOSED_STATUSES.has(toStatus) || toStatus === 'blocked') toStatus = 'todo';
    actions.push({
      identifier: issue.identifier,
      id: issue.id,
      action: 'resume_issue',
      fromStatus: status,
      toStatus,
      reason,
    });
  }

  return { actions, skipped };
}

function planAgentHolds(agents, reason) {
  const actions = [];
  const skipped = [];

  for (const agent of agents) {
    if (RUNNING_AGENT_STATUSES.has(normalizeStatus(agent.status)) || agent.liveRunActive === true) {
      skipped.push(agentSkip(agent, 'currently_running_preserved'));
      continue;
    }
    if (heartbeat(agent).enabled !== true) {
      skipped.push(agentSkip(agent, 'interval_heartbeat_already_disabled'));
      continue;
    }
    actions.push({
      agentId: agent.id,
      agentName: agent.name,
      action: 'disable_interval_heartbeat',
      reason,
    });
  }

  return { actions, skipped };
}

function planAgentReleases(agents, reason) {
  const actions = [];
  const skipped = [];

  for (const agent of agents) {
    if (RUNNING_AGENT_STATUSES.has(normalizeStatus(agent.status)) || agent.liveRunActive === true) {
      skipped.push(agentSkip(agent, 'currently_running_preserved'));
      continue;
    }
    if (!isHoldManaged(agent)) {
      skipped.push(agentSkip(agent, 'not_hold_plan_managed'));
      continue;
    }
    if (agent.holdState?.previousHeartbeatEnabled !== true) {
      skipped.push(agentSkip(agent, 'previous_heartbeat_not_enabled'));
      continue;
    }
    actions.push({
      agentId: agent.id,
      agentName: agent.name,
      action: 'restore_interval_heartbeat',
      reason,
    });
  }

  return { actions, skipped };
}

function issueSkip(issue, reason) {
  return { identifier: issue.identifier, id: issue.id, reason };
}

function agentSkip(agent, reason) {
  return { agentId: agent.id, agentName: agent.name, reason };
}

function normalizeState(state) {
  return String(state ?? '').toLowerCase();
}

function normalizeStatus(status) {
  return String(status ?? '').toLowerCase();
}

function isHoldManaged(item) {
  return item.holdState?.source === HOLD_SOURCE;
}

function heartbeat(agent) {
  return agent.runtimeConfig?.heartbeat ?? {};
}

function issueHasRunningWork(issue) {
  if (issue.liveRunActive === true) return true;
  if (issue.currentRunId || issue.executionRunId || issue.checkoutRunId) return true;
  if (Array.isArray(issue.liveRuns) && issue.liveRuns.length > 0) return true;
  return false;
}
