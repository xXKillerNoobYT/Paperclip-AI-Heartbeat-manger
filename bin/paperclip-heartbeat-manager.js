#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { readFixtureUsage } from '../src/fixture-provider.js';
import { decideDryRun } from '../src/scheduler.js';

async function main(argv) {
  const [command, ...args] = argv;
  if (command !== 'decide') {
    usageAndExit();
  }

  const configPath = valueAfter(args, '--config');
  if (!configPath) {
    throw new Error('missing --config');
  }
  const dryRun = args.includes('--dry-run');
  if (!dryRun) {
    throw new Error('real wake invocation is intentionally not wired in milestone 1; use --dry-run');
  }

  const configFile = resolve(configPath);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const usagePath = resolvePath(valueAfter(args, '--usage') ?? config.fixtureUsagePath, dirname(configFile));
  if (!usagePath) {
    throw new Error('missing --usage or config.fixtureUsagePath');
  }
  const usageSnapshots = await readFixtureUsage(usagePath);
  const now = valueAfter(args, '--now') ?? config.now ?? new Date().toISOString();

  const decision = decideDryRun({ config, usageSnapshots, now });
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function resolvePath(pathValue, baseDir) {
  if (!pathValue) return null;
  return isAbsolute(pathValue) ? pathValue : resolve(baseDir, pathValue);
}

function usageAndExit() {
  process.stderr.write('Usage: paperclip-heartbeat-manager decide --config <file> --dry-run [--usage <fixture>] [--now <iso>]\n');
  process.exit(2);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
