const ACTIONABLE_STATUSES = new Set(['todo', 'backlog', 'in_progress']);
const OFFLINE_AGENT_STATUSES = new Set(['error', 'disabled', 'paused']);

export async function discoverPaperclipParticipants({
  client,
  companyIds,
  providerPoolId,
  issueLimit = 500,
  defaultMaxRunsPerDay = 12,
  defaultCooldownSec = 900,
  now = new Date().toISOString(),
}) {
  if (!client) throw new Error('discoverPaperclipParticipants requires client');
  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    throw new Error('discoverPaperclipParticipants requires at least one companyId');
  }
  if (!providerPoolId) throw new Error('discoverPaperclipParticipants requires providerPoolId');

  const participants = [];
  for (const companyId of companyIds) {
    const [company, agents, issues] = await Promise.all([
      client.getCompany(companyId),
      client.listCompanyAgents(companyId),
      client.listCompanyIssues(companyId, { limit: issueLimit }),
    ]);

    const issuesByAssignee = groupActionableIssuesByAssignee(issues);
    for (const agent of agents) {
      const heartbeat = agent.runtimeConfig?.heartbeat ?? {};
      const assignedIssues = issuesByAssignee.get(agent.id) ?? [];
      const role = normalizeRole(agent);
      const qualified = isWakeQualified(agent, heartbeat);
      const participant = {
        participantId: `${company.issuePrefix ?? companyId}:${agent.name ?? agent.id}`,
        companyId,
        companyName: company.name ?? null,
        companyIssuePrefix: company.issuePrefix ?? null,
        agentId: agent.id,
        agentName: agent.name ?? null,
        role,
        providerPoolId,
        qualified,
        qualificationReason: qualified
          ? qualificationReason(agent, heartbeat)
          : 'Paperclip runtime config does not allow heartbeat wake-on-demand or interval wake.',
        hasVisibleWork: assignedIssues.length > 0,
        assignedIssues,
        weight: role === 'CEO' ? 2 : 1,
        minCooldownSec: heartbeat.cooldownSec ?? defaultCooldownSec,
        maxRunsPerDay: defaultMaxRunsPerDay,
        turnsExpected: assignedIssues.length > 0 ? 1 : 0,
        turnsActual: 0,
        maxDeficitCarry: 3,
        runCountWindow: { session_6h: 0, daily: 0, weekly: 0 },
      };

      if (OFFLINE_AGENT_STATUSES.has(String(agent.status ?? '').toLowerCase())) {
        participant.offlineUntil = oneHourFrom(now);
        participant.offlineReason = `Paperclip agent status is ${agent.status}`;
      }

      participants.push(participant);
    }
  }

  return participants;
}

function groupActionableIssuesByAssignee(issues) {
  const grouped = new Map();
  for (const issue of issues ?? []) {
    if (!ACTIONABLE_STATUSES.has(issue.status)) continue;
    const assignee = issue.assigneeAgentId;
    if (!assignee) continue;
    const list = grouped.get(assignee) ?? [];
    list.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
    });
    grouped.set(assignee, list);
  }
  return grouped;
}

function normalizeRole(agent) {
  if (String(agent.name ?? '').toLowerCase() === 'ceo') return 'CEO';
  if (String(agent.role ?? '').toLowerCase() === 'ceo') return 'CEO';
  return agent.role ?? agent.name ?? 'agent';
}

function isWakeQualified(agent, heartbeat) {
  if (String(agent.status ?? '').toLowerCase() === 'disabled') return false;
  return heartbeat.wakeOnDemand === true || heartbeat.enabled === true;
}

function qualificationReason(agent, heartbeat) {
  const modes = [];
  if (heartbeat.enabled) modes.push(`interval ${heartbeat.intervalSec ?? 'configured'}s`);
  if (heartbeat.wakeOnDemand) modes.push('wake-on-demand');
  return `Discovered from Paperclip agent runtimeConfig (${modes.join(', ') || 'wake-capable'}).`;
}

function oneHourFrom(now) {
  return new Date(new Date(now).getTime() + 60 * 60 * 1000).toISOString();
}
