import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('CLI resolves fixtureUsagePath relative to the config file, not the caller cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'paperclip-heartbeat-manager-cli-'));
  const bin = resolve('bin/paperclip-heartbeat-manager.js');
  const config = resolve('examples/heartbeat-manager.config.json');

  const { stdout } = await execFileAsync(process.execPath, [bin, 'decide', '--dry-run', '--config', config], {
    cwd,
  });

  const decision = JSON.parse(stdout);
  assert.equal(decision.dryRun, true);
  assert.equal(decision.providerPoolId, 'claude-main-isaac');
  assert.equal(decision.invoked, false);
});
