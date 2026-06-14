import { evaluatePacing } from './pacing.js';
import { selectParticipant } from './fairness.js';

export function decideDryRun({ config, usageSnapshots, now = new Date().toISOString() }) {
  if (!config?.enabled) {
    return hold('plugin disabled', { dryRun: true });
  }

  const decisions = [];
  for (const pool of config.pools ?? []) {
    const snapshot = usageSnapshots.find((item) => item.providerPoolId === pool.poolId);
    if (!snapshot) {
      decisions.push(hold(`missing telemetry for pool ${pool.poolId}`, { providerPoolId: pool.poolId, dryRun: true }));
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

    const selection = selectParticipant(config.participants ?? [], {
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
    sessionUsagePct: snapshot.windows.session_6h?.usagePct ?? null,
    weeklyUsagePct: snapshot.windows.weekly?.usagePct ?? null,
    sessionResetAt: snapshot.windows.session_6h?.resetAt ?? null,
    weeklyResetAt: snapshot.windows.weekly?.resetAt ?? null,
  };
}

function makeDecisionId(now, poolId, participantId) {
  return `${now}:${poolId}:${participantId}`.replace(/[^a-zA-Z0-9_.:-]/g, '_');
}
