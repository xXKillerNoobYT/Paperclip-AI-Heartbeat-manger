const DEFAULT_RECHECK_MINUTES = 15;

export function buildOperatorReport({
  config,
  usageSnapshots = [],
  decisions = [],
  sourceDiagnostics = [],
  now = new Date().toISOString(),
} = {}) {
  const decisionList = Array.isArray(decisions) ? decisions : [decisions].filter(Boolean);
  const pools = config?.pools ?? [];
  const participants = config?.participants ?? [];
  const providerPools = pools.map((pool) => summarizePool(pool, usageSnapshots, decisionList, now));
  const nextWake = summarizeNextWake(decisionList, participants, providerPools);
  const heldWork = summarizeHeldWork(decisionList, participants, providerPools);
  const upcomingRelease = summarizeUpcomingRelease({ providerPools, heldWork, now });

  return {
    generatedAt: now,
    plainEnglishSummary: summarizePlainEnglish(nextWake, heldWork, providerPools, sourceDiagnostics),
    providerPools,
    nextWake,
    heldWork,
    upcomingRelease,
    sourceDiagnostics,
  };
}

export function renderOperatorDashboardHtml(report) {
  const title = 'Paperclip heartbeat manager operator dashboard';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="data:,">
  <style>
    :root { color-scheme: light dark; --bg:#0f172a; --panel:#111827; --text:#f8fafc; --muted:#cbd5e1; --ok:#34d399; --warn:#fbbf24; --bad:#fb7185; --line:#334155; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); line-height: 1.45; }
    main { width: min(1180px, 100%); margin: 0 auto; padding: 24px; }
    header, section { background: rgba(17, 24, 39, 0.9); border: 1px solid var(--line); border-radius: 18px; padding: 20px; margin-bottom: 16px; }
    h1, h2, h3 { margin-top: 0; }
    .summary { font-size: 1.1rem; color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .card { border: 1px solid var(--line); border-radius: 14px; padding: 16px; background: rgba(15, 23, 42, 0.72); }
    dl { display: grid; grid-template-columns: minmax(120px, 42%) 1fr; gap: 8px 12px; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; font-weight: 650; overflow-wrap: anywhere; }
    .status { display: inline-block; border-radius: 999px; padding: 4px 10px; font-weight: 700; }
    .under_budget, .final_day_ramp { background: rgba(52, 211, 153, .16); color: var(--ok); }
    .over_budget, .missing_telemetry { background: rgba(251, 191, 36, .16); color: var(--warn); }
    .hard_stop_risk { background: rgba(251, 113, 133, .16); color: var(--bad); }
    table { width: 100%; border-collapse: collapse; min-width: 620px; }
    th, td { border-bottom: 1px solid var(--line); text-align: left; padding: 10px; vertical-align: top; }
    th { color: var(--muted); }
    .table-wrap { overflow-x: auto; }
    @media (max-width: 640px) { main { padding: 12px; } header, section { padding: 14px; } dl { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main aria-labelledby="dashboard-title">
  <header>
    <h1 id="dashboard-title">${escapeHtml(title)}</h1>
    <p class="summary" role="status" aria-live="polite">${escapeHtml(report.plainEnglishSummary)}</p>
    <p><strong>Generated:</strong> <time datetime="${escapeHtml(report.generatedAt)}">${escapeHtml(report.generatedAt)}</time></p>
    <p><strong>Desktop/tablet/mobile verification floor:</strong> review this static dashboard at desktop 1440×900, tablet 768×1024, and mobile 390×844; confirm status text and horizontal table scrolling remain usable.</p>
  </header>

  <section aria-labelledby="next-wake-title">
    <h2 id="next-wake-title">Next wake / hold decision</h2>
    ${renderNextWake(report.nextWake, report.upcomingRelease)}
  </section>

  <section aria-labelledby="pools-title">
    <h2 id="pools-title">Provider pools and reset timers</h2>
    <div class="grid">
      ${report.providerPools.map(renderPoolCard).join('\n')}
    </div>
  </section>

  <section aria-labelledby="held-title">
    <h2 id="held-title">Held or skipped work</h2>
    ${renderHeldWork(report.heldWork)}
  </section>

  <section aria-labelledby="diagnostics-title">
    <h2 id="diagnostics-title">Telemetry diagnostics</h2>
    ${renderDiagnostics(report.sourceDiagnostics)}
  </section>
</main>
</body>
</html>`;
}

function summarizePool(pool, usageSnapshots, decisions, now) {
  const snapshot = usageSnapshots.find((item) => item.providerPoolId === pool.poolId);
  const decision = decisions.find((item) => item.providerPoolId === pool.poolId);
  if (!snapshot) {
    return {
      poolId: pool.poolId,
      provider: pool.provider,
      sessionUsagePct: null,
      weeklyUsagePct: null,
      sessionResetAt: null,
      weeklyResetAt: null,
      hoursUntilSessionReset: null,
      hoursUntilWeeklyReset: null,
      hardStopAtPct: pool.hardStopAtPct ?? null,
      posture: 'missing_telemetry',
      optimalWeeklyUsagePct: null,
      actualVsOptimalPct: null,
      safetyMarginPct: null,
      statusLabel: 'Held: provider telemetry is missing or unavailable.',
    };
  }

  const session = snapshot.windows?.session_6h ?? {};
  const weekly = snapshot.windows?.weekly ?? {};
  const hoursUntilSessionReset = hoursUntil(now, session.resetAt);
  const hoursUntilWeeklyReset = hoursUntil(now, weekly.resetAt);
  const optimalWeeklyUsagePct = optimalWeeklyUsage(hoursUntilWeeklyReset);
  const actualVsOptimalPct = numberOrNull(weekly.usagePct) == null || optimalWeeklyUsagePct == null
    ? null
    : roundOne(Number(weekly.usagePct) - optimalWeeklyUsagePct);
  const hardStopAtPct = pool.hardStopAtPct ?? 100;
  const highestUsagePct = Math.max(Number(session.usagePct ?? 0), Number(weekly.usagePct ?? 0));
  const safetyMarginPct = numberOrNull(highestUsagePct) == null ? null : roundOne(hardStopAtPct - highestUsagePct);
  const posture = poolPosture({ session, weekly, hardStopAtPct, actualVsOptimalPct, decision });

  return {
    poolId: pool.poolId,
    provider: pool.provider,
    sessionUsagePct: numberOrNull(session.usagePct),
    weeklyUsagePct: numberOrNull(weekly.usagePct),
    sessionResetAt: session.resetAt ?? null,
    weeklyResetAt: weekly.resetAt ?? null,
    hoursUntilSessionReset,
    hoursUntilWeeklyReset,
    hardStopAtPct,
    posture,
    optimalWeeklyUsagePct,
    actualVsOptimalPct,
    safetyMarginPct,
    statusLabel: statusLabelFor(posture),
  };
}

function summarizeNextWake(decisions, participants, providerPools) {
  const wake = decisions.find((decision) => decision.type === 'wake');
  if (!wake) return null;
  const participant = participants.find((item) => item.participantId === wake.selectedParticipantId);
  const pool = providerPools.find((item) => item.poolId === wake.providerPoolId);
  return {
    providerPoolId: wake.providerPoolId,
    provider: pool?.provider ?? null,
    selectedParticipantId: wake.selectedParticipantId,
    companyId: wake.companyId ?? participant?.companyId ?? null,
    agentId: wake.agentId ?? participant?.agentId ?? null,
    reason: wake.reason,
    weeklyMode: wake.weeklyMode ?? null,
    expectedCost: wake.expectedCost ?? null,
    releaseAt: new Date().toISOString(),
  };
}

function summarizeHeldWork(decisions, participants, providerPools) {
  const held = [];
  for (const decision of decisions) {
    if (decision.type === 'hold') {
      held.push({
        providerPoolId: decision.providerPoolId ?? null,
        participantId: null,
        reason: decision.reason,
        status: 'held',
      });
    }
    for (const skipped of decision.skipped ?? []) {
      const participant = participants.find((item) => item.participantId === skipped.participantId);
      held.push({
        providerPoolId: participant?.providerPoolId ?? decision.providerPoolId ?? null,
        participantId: skipped.participantId,
        companyId: participant?.companyId ?? null,
        agentId: participant?.agentId ?? null,
        reason: skipped.reason,
        status: 'skipped',
      });
    }
  }
  if (held.length === 0) {
    for (const pool of providerPools.filter((item) => item.posture === 'missing_telemetry' || item.posture === 'hard_stop_risk')) {
      held.push({ providerPoolId: pool.poolId, participantId: null, reason: pool.statusLabel, status: 'held' });
    }
  }
  return held;
}

function summarizeUpcomingRelease({ providerPools, heldWork, now }) {
  const resetCandidates = providerPools
    .flatMap((pool) => [pool.sessionResetAt, pool.weeklyResetAt])
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((time) => Number.isFinite(time) && time > new Date(now).getTime())
    .sort((a, b) => a - b);
  const recheckAt = new Date(new Date(now).getTime() + DEFAULT_RECHECK_MINUTES * 60 * 1000).toISOString();
  return {
    releaseAt: heldWork.length > 0 ? recheckAt : (resetCandidates[0] ? new Date(resetCandidates[0]).toISOString() : recheckAt),
    reason: heldWork.length > 0 ? 'Held work should be rechecked after telemetry/eligibility cooldown.' : 'Next provider reset is the next natural scheduling checkpoint.',
  };
}

function summarizePlainEnglish(nextWake, heldWork, providerPools, sourceDiagnostics) {
  const diagnosticFailure = sourceDiagnostics.find((item) => item.ok === false);
  if (nextWake) {
    return `Next safe wake is ${nextWake.selectedParticipantId} on ${nextWake.providerPoolId}: ${nextWake.reason}`;
  }
  if (heldWork.length > 0) {
    return `No wake selected. Current hold reason: ${heldWork[0].reason}`;
  }
  if (diagnosticFailure) {
    return `No wake selected because telemetry failed: ${diagnosticFailure.reason}`;
  }
  const risky = providerPools.find((pool) => pool.posture === 'hard_stop_risk');
  if (risky) return `No wake selected because ${risky.poolId} is near a provider hard stop.`;
  return 'No wake selected; no actionable provider pool decision was available.';
}

function poolPosture({ session, weekly, hardStopAtPct, actualVsOptimalPct, decision }) {
  if (Number(session.usagePct) >= hardStopAtPct || Number(weekly.usagePct) >= hardStopAtPct) return 'hard_stop_risk';
  if (String(decision?.weeklyMode ?? '').startsWith('final_day')) return 'final_day_ramp';
  if (actualVsOptimalPct == null) return 'missing_telemetry';
  if (actualVsOptimalPct > 5) return 'over_budget';
  return 'under_budget';
}

function statusLabelFor(posture) {
  switch (posture) {
    case 'hard_stop_risk': return 'Held: usage is at or near the provider hard stop.';
    case 'over_budget': return 'Over budget: slow or hold wakes until usage catches the target line.';
    case 'final_day_ramp': return 'Final-day ramp: safe to spend remaining weekly capacity before reset.';
    case 'missing_telemetry': return 'Held: provider telemetry is missing or unavailable.';
    default: return 'Under budget: safe capacity remains before reset.';
  }
}

function renderNextWake(nextWake, upcomingRelease) {
  if (!nextWake) {
    return `<div class="card" role="status" aria-label="Current wake decision status">
      <p><span class="status over_budget">Hold</span></p>
      <p>No agent wake selected. Next recheck/release target: <time datetime="${escapeHtml(upcomingRelease.releaseAt)}">${escapeHtml(upcomingRelease.releaseAt)}</time>.</p>
      <p>${escapeHtml(upcomingRelease.reason)}</p>
    </div>`;
  }
  return `<div class="card" role="status" aria-label="Current wake decision status">
    <p><span class="status final_day_ramp">Wake candidate selected</span></p>
    <dl>
      <dt>Participant</dt><dd>${escapeHtml(nextWake.selectedParticipantId)}</dd>
      <dt>Company</dt><dd>${escapeHtml(nextWake.companyId)}</dd>
      <dt>Agent</dt><dd>${escapeHtml(nextWake.agentId)}</dd>
      <dt>Provider pool</dt><dd>${escapeHtml(nextWake.providerPoolId)}</dd>
      <dt>Reason</dt><dd>${escapeHtml(nextWake.reason)}</dd>
      <dt>Weekly mode</dt><dd>${escapeHtml(nextWake.weeklyMode)}</dd>
    </dl>
  </div>`;
}

function renderPoolCard(pool) {
  return `<article class="card" aria-label="Provider pool ${escapeHtml(pool.poolId)} status">
    <h3>${escapeHtml(pool.poolId)}</h3>
    <p><span class="status ${escapeHtml(pool.posture)}">${escapeHtml(pool.statusLabel)}</span></p>
    <dl>
      <dt>Provider</dt><dd>${escapeHtml(pool.provider)}</dd>
      <dt>Session usage</dt><dd>${formatPercent(pool.sessionUsagePct)}</dd>
      <dt>Weekly usage</dt><dd>${formatPercent(pool.weeklyUsagePct)}</dd>
      <dt>Optimal weekly usage</dt><dd>${formatPercent(pool.optimalWeeklyUsagePct)}</dd>
      <dt>Actual vs optimal</dt><dd>${formatSignedPercent(pool.actualVsOptimalPct)}</dd>
      <dt>Safety margin</dt><dd>${formatPercent(pool.safetyMarginPct)}</dd>
      <dt>Session reset</dt><dd>${formatTime(pool.sessionResetAt, pool.hoursUntilSessionReset)}</dd>
      <dt>Weekly reset</dt><dd>${formatTime(pool.weeklyResetAt, pool.hoursUntilWeeklyReset)}</dd>
    </dl>
  </article>`;
}

function renderHeldWork(heldWork) {
  if (!heldWork.length) return '<p role="status">No held or skipped work in this decision.</p>';
  return `<div class="table-wrap"><table aria-label="Held or skipped work reasons">
    <thead><tr><th>Pool</th><th>Participant</th><th>Status</th><th>Reason</th></tr></thead>
    <tbody>${heldWork.map((item) => `<tr><td>${escapeHtml(item.providerPoolId)}</td><td>${escapeHtml(item.participantId ?? 'pool-level')}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function renderDiagnostics(diagnostics) {
  if (!diagnostics.length) return '<p>No telemetry diagnostics were reported.</p>';
  return `<div class="table-wrap"><table aria-label="Telemetry diagnostics">
    <thead><tr><th>Source</th><th>Status</th><th>Provider/company</th><th>Reason</th></tr></thead>
    <tbody>${diagnostics.map((item) => `<tr><td>${escapeHtml(item.source)}</td><td>${escapeHtml(item.ok ? 'ok' : 'failed')}</td><td>${escapeHtml(item.provider ?? item.companyId ?? '')}</td><td>${escapeHtml(item.reason ?? item.status ?? '')}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function optimalWeeklyUsage(hoursUntilWeeklyReset) {
  if (hoursUntilWeeklyReset == null) return null;
  if (hoursUntilWeeklyReset <= 24) return roundOne(Math.max(0, Math.min(100, 100 - (hoursUntilWeeklyReset / 24) * 100)));
  return 95;
}

function hoursUntil(now, value) {
  if (!value) return null;
  const diff = new Date(value).getTime() - new Date(now).getTime();
  if (!Number.isFinite(diff)) return null;
  return roundOne(diff / 36e5);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function formatPercent(value) {
  return value == null ? 'unknown' : `${value}%`;
}

function formatSignedPercent(value) {
  if (value == null) return 'unknown';
  return `${value > 0 ? '+' : ''}${value}%`;
}

function formatTime(value, hours) {
  if (!value) return 'unknown';
  return `${value}${hours == null ? '' : ` (${hours}h)`}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
