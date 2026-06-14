import assert from 'node:assert/strict';
import test from 'node:test';

import { selectParticipant } from '../src/fairness.js';

const baseContext = {
  now: '2026-06-14T12:00:00.000Z',
  providerPoolId: 'claude-main',
};

function participant(overrides) {
  return {
    participantId: 'p',
    companyId: 'company',
    agentId: 'agent',
    providerPoolId: 'claude-main',
    qualified: true,
    qualificationReason: 'explicit test qualification',
    weight: 1,
    turnsActual: 0,
    turnsExpected: 1,
    maxDeficitCarry: 3,
    runCountWindow: { session_6h: 0, daily: 0, weekly: 0 },
    maxRunsPerDay: 10,
    minCooldownSec: 0,
    lastRunAt: null,
    offlineUntil: null,
    cooldownUntil: null,
    hasVisibleWork: true,
    ...overrides,
  };
}

test('equal weights alternate turns by avoiding same participant twice in a row', () => {
  const result = selectParticipant([
    participant({ participantId: 'alpha', turnsExpected: 2, turnsActual: 1, lastRunAt: '2026-06-14T11:50:00.000Z' }),
    participant({ participantId: 'bravo', turnsExpected: 2, turnsActual: 1, lastRunAt: '2026-06-14T11:55:00.000Z' }),
  ], { ...baseContext, previousSelectedParticipantId: 'alpha' });

  assert.equal(result.selected?.participantId, 'bravo');
  assert.equal(result.decision, 'selected');
});

test('weighted participants receive proportional priority through higher deficit', () => {
  const result = selectParticipant([
    participant({ participantId: 'low-weight', weight: 1, turnsExpected: 2, turnsActual: 2 }),
    participant({ participantId: 'high-weight', weight: 3, turnsExpected: 6, turnsActual: 2 }),
  ], baseContext);

  assert.equal(result.selected?.participantId, 'high-weight');
});

test('offline participant is skipped', () => {
  const result = selectParticipant([
    participant({ participantId: 'offline', turnsExpected: 9, turnsActual: 0, offlineUntil: '2026-06-14T12:30:00.000Z' }),
    participant({ participantId: 'online', turnsExpected: 1, turnsActual: 1 }),
  ], baseContext);

  assert.equal(result.selected?.participantId, 'online');
  assert.equal(result.skipped[0].reason, 'offline');
});

test('returning participant catch-up deficit is capped', () => {
  const result = selectParticipant([
    participant({ participantId: 'returning', turnsExpected: 100, turnsActual: 0, maxDeficitCarry: 3 }),
    participant({ participantId: 'steady', turnsExpected: 8, turnsActual: 6 }),
  ], baseContext);

  assert.equal(result.rankings.find((r) => r.participantId === 'returning').deficitScore, 3);
  assert.equal(result.selected?.participantId, 'returning');
});

test('cooldown blocks an otherwise highest-deficit participant', () => {
  const result = selectParticipant([
    participant({ participantId: 'cooling', turnsExpected: 10, turnsActual: 0, cooldownUntil: '2026-06-14T12:10:00.000Z' }),
    participant({ participantId: 'available', turnsExpected: 2, turnsActual: 1 }),
  ], baseContext);

  assert.equal(result.selected?.participantId, 'available');
  assert.equal(result.skipped.find((s) => s.participantId === 'cooling').reason, 'cooldown');
});

test('deterministic tie-break produces stable output by participant id', () => {
  const result = selectParticipant([
    participant({ participantId: 'zulu' }),
    participant({ participantId: 'alpha' }),
  ], baseContext);

  assert.equal(result.selected?.participantId, 'alpha');
});
