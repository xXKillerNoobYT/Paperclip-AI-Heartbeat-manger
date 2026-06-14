const ACTIONABLE_STATUSES = new Set(['todo', 'backlog', 'in_progress']);

function toTime(value, fallback = 0) {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? fallback : time;
}

function isAfter(value, now) {
  return value && toTime(value) > toTime(now);
}

function hasActionableWork(participant) {
  if (participant.hasVisibleWork === true) return true;
  if (!Array.isArray(participant.assignedIssues)) return false;
  return participant.assignedIssues.some((issue) => ACTIONABLE_STATUSES.has(issue.status));
}

export function normalizeParticipant(participant) {
  const weight = participant.weight ?? 1;
  const rawDeficit = (participant.turnsExpected ?? 0) - (participant.turnsActual ?? 0);
  const maxDeficitCarry = participant.maxDeficitCarry ?? 3;
  return {
    ...participant,
    weight,
    deficitScore: Math.min(maxDeficitCarry, Math.max(0, rawDeficit)),
  };
}

export function selectParticipant(participants, context = {}) {
  const now = context.now ?? new Date().toISOString();
  const providerPoolId = context.providerPoolId;
  const previousSelectedParticipantId = context.previousSelectedParticipantId;
  const skipped = [];
  const eligible = [];

  for (const candidate of participants.map(normalizeParticipant)) {
    if (providerPoolId && candidate.providerPoolId !== providerPoolId) {
      skipped.push(skip(candidate, 'different_provider_pool'));
      continue;
    }
    if (!candidate.qualified) {
      skipped.push(skip(candidate, 'not_qualified'));
      continue;
    }
    if (candidate.role && candidate.role !== 'CEO' && !candidate.qualificationReason) {
      skipped.push(skip(candidate, 'missing_qualification_reason'));
      continue;
    }
    if (isAfter(candidate.offlineUntil, now)) {
      skipped.push(skip(candidate, 'offline'));
      continue;
    }
    if (isAfter(candidate.cooldownUntil, now)) {
      skipped.push(skip(candidate, 'cooldown'));
      continue;
    }
    const runsToday = candidate.runCountWindow?.daily ?? 0;
    if (candidate.maxRunsPerDay != null && runsToday >= candidate.maxRunsPerDay) {
      skipped.push(skip(candidate, 'max_runs_per_day'));
      continue;
    }
    if (!hasActionableWork(candidate)) {
      skipped.push(skip(candidate, 'no_visible_work'));
      continue;
    }
    eligible.push(candidate);
  }

  const rankings = eligible
    .map((candidate) => ({
      participantId: candidate.participantId,
      deficitScore: candidate.deficitScore,
      lastRunAt: candidate.lastRunAt ?? null,
      weight: candidate.weight,
    }))
    .sort(rankSort);

  let sorted = [...eligible].sort((a, b) => rankSort(
    { participantId: a.participantId, deficitScore: a.deficitScore, lastRunAt: a.lastRunAt ?? null, weight: a.weight },
    { participantId: b.participantId, deficitScore: b.deficitScore, lastRunAt: b.lastRunAt ?? null, weight: b.weight },
  ));

  if (previousSelectedParticipantId && sorted.length > 1) {
    const alternative = sorted.find((candidate) => candidate.participantId !== previousSelectedParticipantId && candidate.deficitScore > 0);
    if (alternative) {
      sorted = [alternative, ...sorted.filter((candidate) => candidate.participantId !== alternative.participantId)];
    }
  }

  const selected = sorted[0] ?? null;
  return {
    decision: selected ? 'selected' : 'hold',
    selected,
    rankings,
    skipped,
  };
}

function rankSort(a, b) {
  if (b.deficitScore !== a.deficitScore) return b.deficitScore - a.deficitScore;
  const aLast = toTime(a.lastRunAt, 0);
  const bLast = toTime(b.lastRunAt, 0);
  if (aLast !== bLast) return aLast - bLast;
  if ((b.weight ?? 1) !== (a.weight ?? 1)) return (b.weight ?? 1) - (a.weight ?? 1);
  return String(a.participantId).localeCompare(String(b.participantId));
}

function skip(candidate, reason) {
  return {
    participantId: candidate.participantId,
    reason,
  };
}

export { ACTIONABLE_STATUSES, hasActionableWork };
