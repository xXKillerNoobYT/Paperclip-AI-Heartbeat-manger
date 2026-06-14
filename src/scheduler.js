import { evaluatePacing } from './pacing.js';
import { selectParticipant } from './fairness.js';
import { evaluateCompanyCostLimit } from './usage-provider.js';

export function decideDryRun({ config, usageSnapshots, costLimits = {}, sourceDiagnostics = [], now = new Date().toISOString() }) {
  if (!config?.enabled) {
    return hold('plugin disabled', { dryRun: true });
  }

  const decisions = [];
  for (const pool of config.pools ?? []) {
    const telemetryDiagnostic = providerTelemetryDiagnostic(sourceDiagnostics, pool.provider);
    if (telemetryDiagnostic) {
      decisions.push(hold(`provider telemetry unavailable for ${pool.provider}: ${telemetryDiagnostic.reason}`, {
        providerPoolId: pool.poolId,
        dryRun: true,
        sourceDiagnostics,
      }));
      continue;
    }

    const snapshot = usageSnapshots.find((item) => item.providerPoolId === pool.poolId);
    if (!snapshot) {
      decisions.push(hold(`missing telemetry for pool ${pool.poolId}`, { providerPoolId: pool.poolId, dryRun: true }));
      continue;
    }

    const snapshotBudgetGate = evaluateSnapshotCompanyBudget(snapshot.companyBudget);
    if (snapshotBudgetGate.decision === 'hold') {
      decisions.push(hold(snapshotBudgetGate.reason, {
        providerPoolId: pool.poolId,
        dryRun: true,
        companyBudget: snapshotBudgetGate.companyBudget,
        windowSnapshot: windowSnapshot(snapshot),
      }));
      continue;
    }

    const pacing = evaluatePacing(snapshot, {
      now,
      finalDayHours: pool.finalDayHours,
      preFinalWeeklyUnderburnPct: pool.preFinalWeeklyUnderburnPct,
      hardStopAtPct: pool.hardStopAtPct,
      staleTelemetryMaxAgeSec: pool.staleTelemetryMaxAgeSec,
      sessionHardStopPct: pool.sessionHardStopPct,
      estimatedWakeCostPct: pool.estimatedWakeCostPct,
    });

    if (pacing.decision !== 'wake') {
      decisions.push(hold(pacing.reason, {
        providerPoolId: pool.poolId,
        dryRun: true,
        pacing,
        windowSnapshot: windowSnapshot(snapshot),
      }));
      continue;
    }

    const participants = (config.participants ?? []).map((participant) => ({
      ...participant,
      costLimitStatus: costLimitStatusFor(participant, pool, costLimits),
    }));
    const selection = selectParticipant(participants, {
      now,
      providerPoolId: pool.poolId,
      previousSelectedParticipantId: config.previousSelectedParticipantId,
    });

    if (!selection.selected) {
      decisions.push(hold('no eligible participant', {
        providerPoolId: pool.poolId,
        dryRun: true,
        pacing,
        rankings: selection.rankings,
        skipped: selection.skipped,
        windowSnapshot: windowSnapshot(snapshot),
      }));
      continue;
    }

    decisions.push({
      decisionId: makeDecisionId(now, pool.poolId, selection.selected.participantId),
      createdAt: now,
      type: 'wake',
      dryRun: true,
      invoked: false,
      providerPoolId: pool.poolId,
      selectedParticipantId: selection.selected.participantId,
      companyId: selection.selected.companyId,
      agentId: selection.selected.agentId,
      reason: `dry-run only: ${pacing.reason}`,
      windowSnapshot: windowSnapshot(snapshot),
      costLimit: selection.selected.costLimitStatus?.limit ?? null,
      weeklyMode: pacing.weekly.mode,
      fairnessRanking: selection.rankings,
      skipped: selection.skipped,
      expectedCost: {
        sessionPct: pool.estimatedWakeCostPct ?? 2,
        weeklyPct: pool.estimatedWeeklyWakeCostPct ?? null,
      },
    });
  }

  const wake = decisions.find((decision) => decision.type === 'wake');
  return wake ?? decisions[0] ?? hold('no configured provider pools', { dryRun: true });
}

function costLimitStatusFor(participant, pool, costLimits) {
  const limit = participant.companyId ? costLimits[participant.companyId] : null;
  if (!limit && (pool.requireCompanyCostLimit || participant.requireCompanyCostLimit)) {
    return { decision: 'hold', reason: 'missing company cost limit telemetry', limit: null };
  }
  if (!limit) return { decision: 'allow', reason: 'company cost limit not configured', limit: null };
  return evaluateCompanyCostLimit(limit, {
    estimatedCostCents: participant.estimatedWakeCostCents ?? pool.estimatedWakeCostCents ?? 0,
  });
}

function providerTelemetryDiagnostic(sourceDiagnostics, provider) {
  return sourceDiagnostics.find((item) => (
    item.ok === false
    && item.source === 'paperclip_quota_windows'
    && normalizeProvider(item.provider) === normalizeProvider(provider)
  ));
}

function normalizeProvider(provider) {
  if (provider === 'claude') return 'anthropic';
  if (provider === 'codex' || provider === 'openai-codex') return 'openai';
  return String(provider ?? '').toLowerCase();
}

function hold(reason, extra = {}) {
  return {
    decisionId: makeDecisionId(new Date().toISOString(), extra.providerPoolId ?? 'none', 'hold'),
    createdAt: new Date().toISOString(),
    type: 'hold',
    dryRun: extra.dryRun ?? true,
    invoked: false,
    reason,
    skipped: [],
    ...extra,
  };
}

function windowSnapshot(snapshot) {
  return {
    sessionUsagePct: snapshot.windows?.session_6h?.usagePct ?? null,
    weeklyUsagePct: snapshot.windows?.weekly?.usagePct ?? null,
    sessionResetAt: snapshot.windows?.session_6h?.resetAt ?? null,
    weeklyResetAt: snapshot.windows?.weekly?.resetAt ?? null,
  };
}

function evaluateSnapshotCompanyBudget(companyBudget) {
  if (!companyBudget) return { decision: 'allow', reason: 'no snapshot budget gate', companyBudget: null };
  if (companyBudget.status === 'hard_stop') {
    return { decision: 'hold', reason: 'Paperclip company budget hard stop is active', companyBudget };
  }
  if ((companyBudget.activeIncidentCount ?? 0) > 0) {
    return { decision: 'hold', reason: 'Paperclip company budget incident is active', companyBudget };
  }
  return { decision: 'allow', reason: 'snapshot company budget allows wake', companyBudget };
}

function makeDecisionId(now, poolId, participantId) {
  return `${now}:${poolId}:${participantId}`.replace(/[^a-zA-Z0-9_.:-]/g, '_');
}
