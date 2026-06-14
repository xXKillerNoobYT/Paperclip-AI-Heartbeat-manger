import { copyFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SUPPORTED_SCHEMA_VERSION = 1;
const DEFAULT_DECISION_LOG_LIMIT = 500;

export async function readSharedState(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  validateSchema(parsed);
  return parsed;
}

export async function writeSharedState(filePath, state, options = {}) {
  validateSchema(state);
  const decisionLogLimit = options.decisionLogLimit ?? DEFAULT_DECISION_LOG_LIMIT;
  const stateToWrite = {
    ...state,
    decisionLog: Array.isArray(state.decisionLog) ? state.decisionLog.slice(-decisionLogLimit) : [],
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(stateToWrite, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

export async function acquireLease(filePath, options = {}) {
  const ownerId = options.ownerId ?? `process-${process.pid}`;
  const now = options.now ?? new Date().toISOString();
  const ttlSec = options.ttlSec ?? 60;
  const nowTime = new Date(now).getTime();
  let state = await readSharedState(filePath);
  const lock = state.lock ?? { ownerId: null, token: null, acquiredAt: null, expiresAt: null, fencingToken: 0 };
  const lockExpiresAt = lock.expiresAt ? new Date(lock.expiresAt).getTime() : 0;
  const recovered = Boolean(lock.token && lockExpiresAt <= nowTime);

  if (lock.token && lockExpiresAt > nowTime) {
    return { acquired: false, reason: 'lock_held', state };
  }

  const token = randomUUID();
  const fencingToken = (lock.fencingToken ?? 0) + 1;
  state = {
    ...state,
    updatedAt: now,
    lock: {
      ownerId,
      token,
      acquiredAt: now,
      expiresAt: new Date(nowTime + ttlSec * 1000).toISOString(),
      fencingToken,
    },
  };
  await writeSharedState(filePath, state);

  const confirmed = await readSharedState(filePath);
  if (confirmed.lock?.ownerId !== ownerId || confirmed.lock?.token !== token || confirmed.lock?.fencingToken !== fencingToken) {
    return { acquired: false, reason: 'lock_conflict', state: confirmed };
  }

  return { acquired: true, recovered, ownerId, token, state: confirmed };
}

export async function releaseLease(filePath, lease) {
  const state = await readSharedState(filePath);
  if (state.lock?.ownerId !== lease.ownerId || state.lock?.token !== lease.token) {
    return false;
  }
  state.lock = {
    ownerId: null,
    token: null,
    acquiredAt: null,
    expiresAt: null,
    fencingToken: state.lock.fencingToken ?? 0,
  };
  await writeSharedState(filePath, state);
  return true;
}

export async function recoverCorruptState(filePath, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const safeTimestamp = now.replace(/[:.]/g, '-');
  const backupPath = `${filePath}.${safeTimestamp}.corrupt`;
  await copyFile(filePath, backupPath);
  return {
    safe: false,
    decision: 'hold',
    reason: 'corrupt_state_file',
    backupPath,
  };
}

function validateSchema(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('shared state must be an object');
  }
  if (state.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`unsupported schema version: ${state.schemaVersion}`);
  }
}
