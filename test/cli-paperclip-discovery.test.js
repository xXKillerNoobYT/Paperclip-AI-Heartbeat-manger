import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';

const cliPath = new URL('../bin/paperclip-heartbeat-manager.js', import.meta.url).pathname;

test('CLI can discover Paperclip participants from live company agents and issues', async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/companies/company-1') {
      res.end(JSON.stringify({ id: 'company-1', name: 'Government Watchdog', issuePrefix: 'GOV' }));
      return;
    }
    if (req.url === '/api/companies/company-1/agents') {
      res.end(JSON.stringify([
        { id: 'agent-ceo', name: 'CEO', status: 'idle', runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, cooldownSec: 1 } } },
      ]));
      return;
    }
    if (req.url === '/api/companies/company-1/issues?limit=500&offset=0') {
      res.end(JSON.stringify([
        { id: 'issue-1', identifier: 'GOV-1', title: 'Visible work', status: 'todo', priority: 'high', assigneeAgentId: 'agent-ceo' },
      ]));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found', url: req.url }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const dir = await mkdtemp(join(tmpdir(), 'paperclip-cli-discovery-'));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const usagePath = join(dir, 'usage.json');
    const configPath = join(dir, 'config.json');
    await writeFile(usagePath, JSON.stringify({
      usageSnapshots: [{
        providerPoolId: 'claude-main',
        collectedAt: '2026-06-15T12:00:00.000Z',
        windows: {
          session_6h: { usagePct: 1, resetAt: '2026-06-15T18:00:00.000Z' },
          weekly: { usagePct: 1, resetAt: '2026-06-16T00:00:00.000Z' },
        },
      }],
    }));
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      fixtureUsagePath: usagePath,
      pools: [{ poolId: 'claude-main', provider: 'anthropic', hardStopAtPct: 98, staleTelemetryMaxAgeSec: 999999 }],
      paperclip: { baseUrl, companyIds: ['company-1'] },
    }));

    const result = await runCli(['decide', '--config', configPath, '--dry-run', '--discover-paperclip-participants', '--now', '2026-06-15T12:00:00.000Z']);

    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.type, 'wake');
    assert.equal(decision.selectedParticipantId, 'GOV:CEO');
    assert.equal(decision.companyId, 'company-1');
    assert.equal(decision.agentId, 'agent-ceo');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
