export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function parseDate(value, label) {
  if (!value) {
    throw new Error(`missing ${label}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid ${label}`);
  }
  return date;
}

export function hoursBefore(iso, hours) {
  return new Date(new Date(iso).getTime() - hours * 60 * 60 * 1000).toISOString();
}

function windowProgress({ now, resetAt, durationHours }) {
  const end = parseDate(resetAt, 'reset time');
  const current = parseDate(now, 'now');
  const windowMs = durationHours * 60 * 60 * 1000;
  const start = new Date(end.getTime() - windowMs);
  const elapsedMs = clamp(current.getTime() - start.getTime(), 0, windowMs);
  return elapsedMs / windowMs;
}

function telemetryAgeSec(snapshot, now) {
  const collectedAt = parseDate(snapshot.collectedAt, 'telemetry collectedAt');
  return (parseDate(now, 'now').getTime() - collectedAt.getTime()) / 1000;
}

export function evaluatePacing(snapshot, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const finalDayHours = options.finalDayHours ?? 24;
  const preFinalWeeklyUnderburnPct = options.preFinalWeeklyUnderburnPct ?? 5;
  const hardStopAtPct = options.hardStopAtPct ?? 98;
  const sessionHardStopPct = options.sessionHardStopPct ?? 90;
  const estimatedWakeCostPct = options.estimatedWakeCostPct ?? 2;
  const staleTelemetryMaxAgeSec = options.staleTelemetryMaxAgeSec ?? 300;

  try {
    if (!snapshot?.windows?.session_6h || !snapshot?.windows?.weekly) {
      return holdUnsafe('missing usage windows');
    }

    if (telemetryAgeSec(snapshot, now) > staleTelemetryMaxAgeSec) {
      return holdUnsafe('stale telemetry');
    }

    const sessionWindow = snapshot.windows.session_6h;
    const weeklyWindow = snapshot.windows.weekly;
    if (sessionWindow.resetAt == null || weeklyWindow.resetAt == null) {
      return holdUnsafe('missing reset time');
    }
    if (!Number.isFinite(sessionWindow.usagePct) || !Number.isFinite(weeklyWindow.usagePct)) {
      return holdUnsafe('missing usage percent');
    }

    const sessionReset = parseDate(sessionWindow.resetAt, 'session resetAt');
    const weeklyReset = parseDate(weeklyWindow.resetAt, 'weekly resetAt');
    const current = parseDate(now, 'now');
    const hoursRemaining = Math.max((weeklyReset.getTime() - current.getTime()) / 3_600_000, 0);
    const sessionProgress = windowProgress({ now, resetAt: sessionWindow.resetAt, durationHours: 6 });
    const weeklyProgress = windowProgress({ now, resetAt: weeklyWindow.resetAt, durationHours: 24 * 7 });

    const sessionAllowsSpend = sessionWindow.usagePct + estimatedWakeCostPct <= sessionHardStopPct;
    const session = {
      usagePct: sessionWindow.usagePct,
      resetAt: sessionWindow.resetAt,
      progress: sessionProgress,
      hardStopPct: sessionHardStopPct,
      estimatedWakeCostPct,
      allowsSpend: sessionAllowsSpend,
    };

    if (weeklyWindow.usagePct >= hardStopAtPct) {
      return {
        safe: false,
        decision: 'hold',
        reason: `weekly usage ${weeklyWindow.usagePct}% is at or over hard stop ${hardStopAtPct}%`,
        session,
        weekly: { usagePct: weeklyWindow.usagePct, hardStopAtPct, mode: hoursRemaining <= finalDayHours ? 'final_day' : 'pre_final_day' },
      };
    }

    let weekly;
    if (hoursRemaining <= finalDayHours) {
      const remainingTimeFraction = clamp(hoursRemaining / finalDayHours, 0, 1);
      const finalDayTargetPct = clamp(hardStopAtPct - hardStopAtPct * remainingTimeFraction, 0, hardStopAtPct);
      weekly = {
        usagePct: weeklyWindow.usagePct,
        resetAt: weeklyWindow.resetAt,
        progress: weeklyProgress,
        mode: 'final_day',
        hoursRemaining,
        hardStopAtPct,
        targetPct: finalDayTargetPct,
        allowsSpend: weeklyWindow.usagePct < hardStopAtPct,
        requestsSpend: weeklyWindow.usagePct < finalDayTargetPct,
      };
    } else {
      const optimalPct = 100 * weeklyProgress;
      const targetCeilingPct = Math.max(0, optimalPct - preFinalWeeklyUnderburnPct);
      const allowsSpend = weeklyWindow.usagePct < targetCeilingPct;
      weekly = {
        usagePct: weeklyWindow.usagePct,
        resetAt: weeklyWindow.resetAt,
        progress: weeklyProgress,
        mode: 'pre_final_day',
        optimalPct,
        targetCeilingPct,
        allowsSpend,
        requestsSpend: allowsSpend,
      };
    }

    if (!sessionAllowsSpend) {
      return { safe: true, decision: 'hold', reason: 'session window hard stop blocks wake', session, weekly };
    }
    if (!weekly.allowsSpend) {
      return { safe: true, decision: 'hold', reason: 'weekly usage is over target', session, weekly };
    }

    const reason = weekly.mode === 'final_day'
      ? 'final-day weekly ramp requests spending and session gate allows wake'
      : 'weekly below pre-final-day target and session gate allows wake';
    return { safe: true, decision: 'wake', reason, session, weekly };
  } catch (error) {
    return holdUnsafe(error.message);
  }
}

function holdUnsafe(reason) {
  return {
    safe: false,
    decision: 'hold',
    reason,
    session: null,
    weekly: null,
  };
}
