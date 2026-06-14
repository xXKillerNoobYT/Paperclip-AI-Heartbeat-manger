import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CONFIRMATION = 'I understand this mutates live Paperclip state';
const RUNNING_AGENT_STATUSES = new Set(['running', 'busy', 'working', 'in_progress']);
const ACTIVE_ISSUE_RUN_FIELDS = ['currentRunId', 'executionRunId', 'checkoutRunId'];
const IDEMPOTENCY_LOCK_STALE_MS = 5 * 60 * 1000;

export async function executeLiveDecision({
  decision,
  holdPlan = null,
  client,
  config = {},
  confirmation,
  now = new Date().toISOString(),
  decisionLogPath,
  idempotencyPath,
} = {}) {
  assertLiveEnabled({ config, confirmation });
  assertDurableLivePaths({ decisionLogPath, idempotencyPath });
  if (!client) throw new Error('executeLiveDecision requires a Paperclip client');

  const lock = await acquireIdempotencyLock(idempotencyPath, now);
  try {
    return await executeLiveDecisionWithLock({
      decision,
      holdPlan,
      client,
      config,
      now,
      decisionLogPath,
      idempotencyPath,
    });
  } finally {
    await releaseIdempotencyLock(lock);
  }
}

async function executeLiveDecisionWithLock({
  decision,
  holdPlan = null,
  client,
  config = {},
  now = new Date().toISOString(),
  decisionLogPath,
  idempotencyPath,
} = {}) {
  const idempotency = await readIdempotencyStore(idempotencyPath);
  const decisionId = liveDecisionId(decision, holdPlan, now);
  if (idempotency.decisions[decisionId]?.completed === true) {
    const result = {
      decisionId,
      createdAt: now,
      mode: 'live',
      duplicate: true,
      invoked: false,
      actions: [],
      skipped: [{ reason: 'duplicate_decision_id', decisionId }],
    };
    await appendDecisionLog(decisionLogPath, result);
    return result;
  }

  idempotency.decisions[decisionId] = {
    decisionId,
    startedAt: now,
    fencingToken: (idempotency.lastFencingToken ?? 0) + 1,
    completed: false,
  };
  idempotency.lastFencingToken = idempotency.decisions[decisionId].fencingToken;
  await writeIdempotencyStore(idempotencyPath, idempotency);

  const result = holdPlan
    ? await executeHoldPlan({ holdPlan, client, config, now, decisionId, fencingToken: idempotency.lastFencingToken })
    : await executeWakeDecision({ decision, client, config, now, decisionId, fencingToken: idempotency.lastFencingToken });

  idempotency.decisions[decisionId] = {
    ...idempotency.decisions[decisionId],
    completed: true,
    completedAt: now,
    resultSummary: summarizeResult(result),
  };
  await writeIdempotencyStore(idempotencyPath, idempotency);
  await appendDecisionLog(decisionLogPath, result);
  return result;
}

export function assertLiveEnabled({ config = {}, confirmation } = {}) {
  if (config.live?.enabled !== true) {
    throw new Error('live mode is disabled; set config.live.enabled=true to opt in');
  }
  const expected = config.live.confirmationText ?? DEFAULT_CONFIRMATION;
  if (confirmation !== expected) {
    throw new Error(`live mode confirmation mismatch; expected: ${expected}`);
  }
}

export function assertDurableLivePaths({ decisionLogPath, idempotencyPath } = {}) {
  if (typeof idempotencyPath !== 'string' || idempotencyPath.trim().length === 0) {
    throw new Error('live mode requires a non-empty idempotency store path');
  }
  if (typeof decisionLogPath !== 'string' || decisionLogPath.trim().length === 0) {
    throw new Error('live mode requires a non-empty decision log path');
  }
}

async function executeWakeDecision({ decision, client, config, now, decisionId, fencingToken }) {
  if (!decision || decision.type !== 'wake') {
    return {
      decisionId,
      createdAt: now,
      mode: 'live',
      invoked: false,
      actions: [],
      skipped: [{ reason: 'decision_is_not_wake', type: decision?.type ?? null }],
    };
  }

  const agent = await client.getAgent(decision.agentId);
  if (agentIsRunning(agent)) {
    return {
      decisionId,
      createdAt: now,
      mode: 'live',
      invoked: false,
      actions: [],
      skipped: [{ reason: 'agent_currently_running_preserved', agentId: decision.agentId, status: agent.status }],
    };
  }

  const body = {
    reason: liveReason(config, decision),
    triggerDetail: 'paperclip_heartbeat_manager_live_mode',
    forceFreshSession: config.live?.forceFreshSession === true,
    metadata: {
      decisionId,
      fencingToken,
      providerPoolId: decision.providerPoolId,
      selectedParticipantId: decision.selectedParticipantId,
    },
  };
  const response = await client.wakeAgent(decision.agentId, body);
  return {
    decisionId,
    createdAt: now,
    mode: 'live',
    invoked: true,
    actions: [{ action: 'wake_agent', agentId: decision.agentId, companyId: decision.companyId, response: compactWakeResponse(response) }],
    skipped: [],
  };
}

async function executeHoldPlan({ holdPlan, client, config, now, decisionId, fencingToken }) {
  const actions = [];
  const skipped = [...(holdPlan.skippedIssues ?? []), ...(holdPlan.skippedAgents ?? [])];

  for (const action of holdPlan.issueActions ?? []) {
    const issue = await client.getIssue(action.identifier);
    if (issueHasRunningWork(issue)) {
      skipped.push({ identifier: action.identifier, reason: 'currently_running_preserved_at_execution' });
      continue;
    }
    if (action.action === 'hold_issue') {
      const comment = holdComment({ action, holdPlan, decisionId, fencingToken });
      await client.commentIssue(action.identifier, comment);
      const response = await client.updateIssue(action.identifier, { status: action.toStatus });
      actions.push({ ...action, response: compactIssue(response) });
      continue;
    }
    if (action.action === 'resume_issue') {
      const comment = releaseComment({ action, holdPlan, decisionId, fencingToken });
      await client.commentIssue(action.identifier, comment);
      const response = await client.updateIssue(action.identifier, { status: action.toStatus });
      actions.push({ ...action, response: compactIssue(response) });
    }
  }

  for (const action of holdPlan.agentActions ?? []) {
    const agent = await client.getAgent(action.agentId);
    if (agentIsRunning(agent)) {
      skipped.push({ agentId: action.agentId, reason: 'currently_running_preserved_at_execution' });
      continue;
    }
    if (action.action === 'disable_interval_heartbeat') {
      const heartbeat = { ...(agent.runtimeConfig?.heartbeat ?? {}), enabled: false };
      const response = await client.updateAgent(action.agentId, {
        runtimeConfig: { ...(agent.runtimeConfig ?? {}), heartbeat },
      });
      actions.push({ ...action, response: compactAgent(response) });
      continue;
    }
    if (action.action === 'restore_interval_heartbeat') {
      const heartbeat = { ...(agent.runtimeConfig?.heartbeat ?? {}), enabled: true };
      const response = await client.updateAgent(action.agentId, {
        runtimeConfig: { ...(agent.runtimeConfig ?? {}), heartbeat },
      });
      actions.push({ ...action, response: compactAgent(response) });
    }
  }

  return {
    decisionId,
    createdAt: now,
    mode: 'live',
    invoked: actions.length > 0,
    fencingToken,
    actions,
    skipped,
  };
}

function liveReason(config, decision) {
  return config.live?.reasonPrefix
    ? `${config.live.reasonPrefix}: ${decision.reason}`
    : `Heartbeat manager live wake: ${decision.reason}`;
}

function holdComment({ action, holdPlan, decisionId, fencingToken }) {
  return [
    'Heartbeat manager live hold applied.',
    `Decision: ${decisionId}`,
    `Fence: ${fencingToken}`,
    `Reason: ${action.reason}`,
    `Previous status: ${action.fromStatus}`,
    `Reset/release target: ${holdPlan.release?.resetAt ?? 'manual release or next reset window'}`,
    'Safety: active live runs are rechecked immediately before mutation and are not interrupted.',
  ].join('\n');
}

function releaseComment({ action, decisionId, fencingToken }) {
  return [
    'Heartbeat manager live hold released.',
    `Decision: ${decisionId}`,
    `Fence: ${fencingToken}`,
    `Reason: ${action.reason}`,
    `Restored status: ${action.toStatus}`,
  ].join('\n');
}

function agentIsRunning(agent) {
  return RUNNING_AGENT_STATUSES.has(String(agent?.status ?? '').toLowerCase()) || agent?.liveRunActive === true;
}

function issueHasRunningWork(issue) {
  if (issue?.liveRunActive === true) return true;
  if (Array.isArray(issue?.liveRuns) && issue.liveRuns.length > 0) return true;
  return ACTIVE_ISSUE_RUN_FIELDS.some((field) => Boolean(issue?.[field]));
}

function liveDecisionId(decision, holdPlan, now) {
  return (decision?.decisionId ?? holdPlan?.decisionId ?? `${now}:hold-plan`).replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

async function appendDecisionLog(decisionLogPath, entry) {
  await mkdir(path.dirname(decisionLogPath), { recursive: true });
  await writeFile(decisionLogPath, `${JSON.stringify(entry)}\n`, { flag: 'a' });
}

async function readIdempotencyStore(idempotencyPath) {
  try {
    const parsed = JSON.parse(await readFile(idempotencyPath, 'utf8'));
    return {
      schemaVersion: 1,
      lastFencingToken: parsed.lastFencingToken ?? 0,
      decisions: parsed.decisions ?? {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schemaVersion: 1, lastFencingToken: 0, decisions: {} };
  }
}

async function writeIdempotencyStore(idempotencyPath, store) {
  await mkdir(path.dirname(idempotencyPath), { recursive: true });
  const tempPath = `${idempotencyPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(tempPath, idempotencyPath);
}

async function acquireIdempotencyLock(idempotencyPath, now) {
  if (!idempotencyPath) return null;
  const lockPath = `${idempotencyPath}.lock`;
  await mkdir(path.dirname(idempotencyPath), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: now })}\n`, 'utf8');
      return { lockPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await removeStaleLock(lockPath);
      await sleep(20);
    }
  }
  throw new Error(`timed out waiting for live decision idempotency lock: ${lockPath}`);
}

async function removeStaleLock(lockPath) {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > IDEMPOTENCY_LOCK_STALE_MS) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function releaseIdempotencyLock(lock) {
  if (!lock) return;
  await rm(lock.lockPath, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactIssue(issue) {
  return issue ? { id: issue.id, identifier: issue.identifier, status: issue.status } : null;
}

function compactAgent(agent) {
  return agent ? { id: agent.id, name: agent.name, status: agent.status, heartbeat: agent.runtimeConfig?.heartbeat ?? null } : null;
}

function compactWakeResponse(response) {
  if (!response || typeof response !== 'object') return response ?? null;
  return {
    queued: response.queued ?? response.ok ?? null,
    runId: response.runId ?? response.heartbeatRunId ?? response.id ?? null,
    status: response.status ?? null,
    agentId: response.agentId ?? null,
  };
}

function summarizeResult(result) {
  return {
    actionCount: result.actions?.length ?? 0,
    skippedCount: result.skipped?.length ?? 0,
    invoked: result.invoked === true,
    duplicate: result.duplicate === true,
  };
}
