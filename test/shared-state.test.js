import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireLease, readSharedState, recoverCorruptState, releaseLease, writeSharedState } from '../src/shared-state.js';

async function tempStatePath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'heartbeat-manager-state-'));
  return { dir, file: path.join(dir, 'state.json') };
}

function state(overrides = {}) {
  return {
    schemaVersion: 1,
    stateId: 'claude-main',
    updatedAt: '2026-06-14T12:00:00.000Z',
    updatedBy: { computerId: 'test-mac', companyId: 'company', processId: 'test' },
    lock: { ownerId: null, token: null, acquiredAt: null, expiresAt: null, fencingToken: 0 },
    providerPool: { poolId: 'claude-main', provider: 'claude', accountAlias: 'primary', timezone: 'UTC' },
    windows: {},
    participants: {},
    decisionLog: [],
    ...overrides,
  };
}

test('shared state writes valid JSON atomically', async () => {
  const { dir, file } = await tempStatePath();
  try {
    await writeSharedState(file, state({ stateId: 'old' }));
    await writeSharedState(file, state({ stateId: 'new', decisionLog: [{ decisionId: 'd1' }] }));

    const parsed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(parsed.stateId, 'new');
    assert.equal(parsed.decisionLog.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stale lock can be recovered and increments fencing token', async () => {
  const { dir, file } = await tempStatePath();
  try {
    await writeSharedState(file, state({ lock: { ownerId: 'old', token: 'old-token', acquiredAt: '2026-06-14T11:00:00.000Z', expiresAt: '2026-06-14T11:01:00.000Z', fencingToken: 7 } }));
    const lease = await acquireLease(file, { ownerId: 'new-owner', now: '2026-06-14T12:00:00.000Z', ttlSec: 60 });

    assert.equal(lease.acquired, true);
    assert.equal(lease.recovered, true);
    assert.equal(lease.state.lock.ownerId, 'new-owner');
    assert.equal(lease.state.lock.fencingToken, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('active lock causes hold', async () => {
  const { dir, file } = await tempStatePath();
  try {
    await writeSharedState(file, state({ lock: { ownerId: 'active', token: 'token', acquiredAt: '2026-06-14T11:59:00.000Z', expiresAt: '2026-06-14T12:05:00.000Z', fencingToken: 1 } }));
    const lease = await acquireLease(file, { ownerId: 'new-owner', now: '2026-06-14T12:00:00.000Z', ttlSec: 60 });

    assert.equal(lease.acquired, false);
    assert.equal(lease.reason, 'lock_held');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt JSON is backed up and safe hold is returned', async () => {
  const { dir, file } = await tempStatePath();
  try {
    await writeFile(file, '{bad json', 'utf8');
    const result = await recoverCorruptState(file, { now: '2026-06-14T12:00:00.000Z' });

    assert.equal(result.safe, false);
    assert.equal(result.reason, 'corrupt_state_file');
    await stat(result.backupPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unknown schema major version is rejected', async () => {
  const { dir, file } = await tempStatePath();
  try {
    await writeFile(file, `${JSON.stringify(state({ schemaVersion: 2 }))}\n`, 'utf8');
    await assert.rejects(() => readSharedState(file), /unsupported schema/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release lease clears only matching token', async () => {
  const { dir, file } = await tempStatePath();
  try {
    await writeSharedState(file, state({ lock: { ownerId: 'owner', token: 'token-a', acquiredAt: '2026-06-14T12:00:00.000Z', expiresAt: '2026-06-14T12:01:00.000Z', fencingToken: 2 } }));
    assert.equal(await releaseLease(file, { ownerId: 'owner', token: 'wrong' }), false);
    assert.equal((await readSharedState(file)).lock.token, 'token-a');
    assert.equal(await releaseLease(file, { ownerId: 'owner', token: 'token-a' }), true);
    assert.equal((await readSharedState(file)).lock.token, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
