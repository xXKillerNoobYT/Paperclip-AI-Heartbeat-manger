#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { decideDryRun } from '../src/scheduler.js';
import { readUsageInputs } from '../src/usage-provider.js';
import { buildOperatorReport, renderOperatorDashboardHtml } from '../src/operator-report.js';
import { buildHoldPlan } from '../src/hold-plan.js';
import { PaperclipClient } from '../src/paperclip-client.js';
import { executeLiveDecision } from '../src/live-executor.js';

async function main(argv) {
  const [command, ...args] = argv;
  if (!['decide', 'report', 'hold-plan'].includes(command)) {
    usageAndExit();
  }

  const configPath = valueAfter(args, '--config');
  if (!configPath) {
    throw new Error('missing --config');
  }
  const live = args.includes('--live');
  const dryRun = args.includes('--dry-run') || !live;
  if (live && args.includes('--dry-run')) {
    throw new Error('choose either --dry-run or --live, not both');
  }
  if (!dryRun && !live) {
    throw new Error('choose --dry-run or explicit --live');
  }

  const configFile = resolve(configPath);
  const configDir = dirname(configFile);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const sourceType = valueAfter(args, '--usage-source');
  const paperclipBaseUrl = valueAfter(args, '--paperclip-base-url');
  if (sourceType || paperclipBaseUrl) {
    config.usageSource = {
      ...(config.usageSource ?? {}),
      ...(sourceType ? { type: sourceType } : {}),
      ...(paperclipBaseUrl ? { baseUrl: paperclipBaseUrl } : {}),
    };
  }
  const usagePath = resolvePath(valueAfter(args, '--usage') ?? config.fixtureUsagePath ?? config.usageSource?.fixtureUsagePath, configDir);
  if ((config.usageSource?.type ?? 'fixture') !== 'paperclip' && !usagePath) {
    throw new Error('missing --usage or config.fixtureUsagePath');
  }
  const now = valueAfter(args, '--now') ?? config.now ?? new Date().toISOString();

  if (command === 'hold-plan') {
    const snapshotPath = resolvePath(valueAfter(args, '--hold-snapshot'), process.cwd());
    if (!snapshotPath) {
      throw new Error('hold-plan requires --hold-snapshot <file>');
    }
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const plan = buildHoldPlan({
      companyId: snapshot.companyId ?? config.scope?.companyIds?.[0],
      generatedAt: now,
      trigger: snapshot.trigger ?? config.holdPolicy?.trigger ?? {},
      issues: snapshot.issues ?? [],
      agents: snapshot.agents ?? [],
    });
    if (live) {
      const result = await executeLiveDecision({
        holdPlan: plan,
        client: new PaperclipClient({ baseUrl: requiredPaperclipBaseUrl(config, args), dryRun: false }),
        config,
        confirmation: valueAfter(args, '--confirm-live'),
        now,
        decisionLogPath: valueAfter(args, '--decision-log') ?? config.live?.decisionLogPath,
        idempotencyPath: valueAfter(args, '--idempotency-store') ?? config.live?.idempotencyStorePath,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  const { usageSnapshots, costLimits, sourceDiagnostics } = await readUsageInputs(config, { usagePath, now });
  const decision = decideDryRun({ config, usageSnapshots, costLimits, sourceDiagnostics, now });

  if (command === 'decide') {
    if (live) {
      const result = await executeLiveDecision({
        decision,
        client: new PaperclipClient({ baseUrl: requiredPaperclipBaseUrl(config, args), dryRun: false }),
        config,
        confirmation: valueAfter(args, '--confirm-live'),
        now,
        decisionLogPath: valueAfter(args, '--decision-log') ?? config.live?.decisionLogPath,
        idempotencyPath: valueAfter(args, '--idempotency-store') ?? config.live?.idempotencyStorePath,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return;
  }

  const report = buildOperatorReport({ config, usageSnapshots, decisions: [decision], sourceDiagnostics, now });
  const format = valueAfter(args, '--format') ?? 'html';
  const outputPath = valueAfter(args, '--output');
  const body = format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderOperatorDashboardHtml(report);

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, body, 'utf8');
    process.stdout.write(`${outputPath}\n`);
    return;
  }

  process.stdout.write(body);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function requiredPaperclipBaseUrl(config, args) {
  const baseUrl = valueAfter(args, '--paperclip-base-url') ?? config.usageSource?.baseUrl ?? config.live?.paperclipBaseUrl;
  if (!baseUrl) {
    throw new Error('live mode requires --paperclip-base-url or config.live.paperclipBaseUrl');
  }
  return baseUrl;
}

function resolvePath(pathValue, baseDir) {
  if (!pathValue) return null;
  return isAbsolute(pathValue) ? pathValue : resolve(baseDir, pathValue);
}

function usageAndExit() {
  process.stderr.write('Usage: paperclip-heartbeat-manager <decide|report|hold-plan> --config <file> (--dry-run|--live --confirm-live <text>) [--usage <fixture>] [--usage-source fixture|paperclip] [--paperclip-base-url <api>] [--hold-snapshot <file>] [--now <iso>] [--output <file>] [--format html|json] [--decision-log <jsonl>] [--idempotency-store <json>]\n');
  process.exit(2);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
