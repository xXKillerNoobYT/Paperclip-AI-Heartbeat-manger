import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePacing, hoursBefore } from '../src/pacing.js';

const weeklyReset = '2026-06-16T00:00:00.000Z';

function usage({ now, sessionUsagePct = 10, weeklyUsagePct = 10, sessionResetAt = hoursBefore(weeklyReset, -1), weeklyResetAt = weeklyReset, collectedAt = now } = {}) {
  return {
    providerPoolId: 'claude-main',
    collectedAt,
    windows: {
      session_6h: {
        usagePct: sessionUsagePct,
        resetAt: sessionResetAt,
        confidence: 'reported',
      },
      weekly: {
        usagePct: weeklyUsagePct,
        resetAt: weeklyResetAt,
        confidence: 'reported',
      },
    },
  };
}

test('weekly usage enters final-day mode when reset is less than 24 hours away', () => {
  const now = '2026-06-15T06:00:00.000Z';
  const result = evaluatePacing(usage({ now, weeklyUsagePct: 18 }), { now });

  assert.equal(result.safe, true);
  assert.equal(result.weekly.mode, 'final_day');
  assert.equal(result.weekly.requestsSpend, true);
  assert.match(result.reason, /final-day/i);
});

test('pre-final-day weekly target clamps optimal minus safety margin at zero', () => {
  const now = '2026-06-09T02:00:00.000Z';
  const result = evaluatePacing(usage({ now, weeklyUsagePct: 0, weeklyResetAt: '2026-06-16T00:00:00.000Z' }), { now });

  assert.equal(result.weekly.mode, 'pre_final_day');
  assert.equal(result.weekly.targetCeilingPct, 0);
  assert.equal(result.weekly.allowsSpend, false);
  assert.equal(result.decision, 'hold');
});

test('pre-final-day over-target usage suppresses wakes', () => {
  const now = '2026-06-12T12:00:00.000Z';
  const result = evaluatePacing(usage({ now, weeklyUsagePct: 80 }), { now, estimatedWakeCostPct: 2 });

  assert.equal(result.safe, true);
  assert.equal(result.weekly.mode, 'pre_final_day');
  assert.equal(result.weekly.allowsSpend, false);
  assert.equal(result.decision, 'hold');
  assert.match(result.reason, /weekly.*over target/i);
});

test('session hard stop blocks wakes even when weekly final-day wants spending', () => {
  const now = '2026-06-15T12:00:00.000Z';
  const result = evaluatePacing(usage({ now, sessionUsagePct: 89, weeklyUsagePct: 30 }), {
    now,
    estimatedWakeCostPct: 2,
    sessionHardStopPct: 90,
  });

  assert.equal(result.weekly.requestsSpend, true);
  assert.equal(result.session.allowsSpend, false);
  assert.equal(result.decision, 'hold');
  assert.match(result.reason, /session.*hard stop/i);
});

test('missing reset time enters safe hold', () => {
  const now = '2026-06-15T12:00:00.000Z';
  const snapshot = usage({ now });
  delete snapshot.windows.weekly.resetAt;

  const result = evaluatePacing(snapshot, { now });

  assert.equal(result.safe, false);
  assert.equal(result.decision, 'hold');
  assert.match(result.reason, /missing.*reset/i);
});

test('stale telemetry enters safe hold', () => {
  const now = '2026-06-15T12:00:00.000Z';
  const result = evaluatePacing(usage({ now, collectedAt: '2026-06-15T11:00:00.000Z' }), {
    now,
    staleTelemetryMaxAgeSec: 300,
  });

  assert.equal(result.safe, false);
  assert.equal(result.decision, 'hold');
  assert.match(result.reason, /stale telemetry/i);
});
