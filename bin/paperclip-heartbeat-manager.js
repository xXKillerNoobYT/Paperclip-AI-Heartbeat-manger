#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { buildHoldPlan } from '../src/hold-plan.js';
import { executeLiveDecision } from '../src/live-executor.js';
import { buildOperatorReport, renderOperatorDashboardHtml } from '../src/operator-report.js';
import { PaperclipClient } from '../src/paperclip-client.js';
import { discoverPaperclipParticipants } from '../src/paperclip-discovery.js';
import { decideDryRun } from '../src/scheduler.js';
import { buildPluginSettings } from '../src/settings.js';
import { readUsageInputs } from '../src/usage-provider.js';

async function main(argv) {
  const [command, ...args] = argv;
  if (!['decide', 'report', 'hold-plan', 'settings'].includes(command)) {
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
  config.usageSource = usageSourceFrom(args, config);
  const baseUrl = valueAfter(args, '--paperclip-base-url');
  if (baseUrl) {
    config.paperclip = { ...(config.paperclip ?? {}), baseUrl };
  }

  if (command === 'settings') {
    process.stdout.write(`${JSON.stringify(buildPluginSettings(config, { configDir }), null, 2)}\n`);
    return;
  }

  const usagePath = resolvePath(
    valueAfter(args, '--usage') ?? config.fixtureUsagePath ?? config.usageSource.fixtureUsagePath,
    configDir,
  );
  if (config.usageSource.type !== 'paperclip' && !usagePath) {
    throw new Error('missing --usage or config.fixtureUsagePath');
  }

  const now = valueAfter(args, '--now') ?? config.now ?? new Date().toISOString();
  const paperclipClient = makePaperclipClient({ args, config, dryRun });
  const participants = await loadParticipants({ args, config, now, paperclipClient });
  const configWithParticipants = { ...config, participants };

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
        decisionLogPath: resolvePath(valueAfter(args, '--decision-log') ?? config.live?.decisionLogPath, configDir),
        idempotencyPath: resolvePath(valueAfter(args, '--idempotency-store') ?? config.live?.idempotencyStorePath, configDir),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  const { usageSnapshots, costLimits, sourceDiagnostics } = await readUsageInputs(configWithParticipants, { usagePath, now });
  const decision = decideDryRun({ config: configWithParticipants, usageSnapshots, costLimits, sourceDiagnostics, now });

  if (command === 'decide') {
    if (live) {
      const result = await executeLiveDecision({
        decision,
        client: new PaperclipClient({ baseUrl: requiredPaperclipBaseUrl(config, args), dryRun: false }),
        config,
        confirmation: valueAfter(args, '--confirm-live'),
        now,
        decisionLogPath: resolvePath(valueAfter(args, '--decision-log') ?? config.live?.decisionLogPath, configDir),
        idempotencyPath: resolvePath(valueAfter(args, '--idempotency-store') ?? config.live?.idempotencyStorePath, configDir),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return;
  }

  const report = buildOperatorReport({
    config: configWithParticipants,
    usageSnapshots,
    decisions: [decision],
    sourceDiagnostics,
    now,
  });
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
  const baseUrl = paperclipBaseUrl(args, config);
  if (!baseUrl) {
    throw new Error('live mode requires --paperclip-base-url or config.live.paperclipBaseUrl');
  }
  return baseUrl;
}

function usageSourceFrom(args, config) {
  const configured = normalizeUsageSource(config.usageSource);
  const sourceType = valueAfter(args, '--usage-source');
  const baseUrl = valueAfter(args, '--paperclip-base-url');
  return {
    ...configured,
    ...(sourceType ? { type: sourceType } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function normalizeUsageSource(source) {
  if (typeof source === 'string') return { type: source };
  if (source && typeof source === 'object') return { ...source };
  return { type: 'fixture' };
}

function paperclipBaseUrl(args, config) {
  return valueAfter(args, '--paperclip-base-url')
    ?? process.env.PAPERCLIP_API_BASE_URL
    ?? config.paperclip?.baseUrl
    ?? config.usageSource?.baseUrl
    ?? config.live?.paperclipBaseUrl
    ?? config.paperclipBaseUrl;
}

function participantSource(args, config) {
  if (args.includes('--discover-paperclip-participants')) return 'paperclip';
  return valueAfter(args, '--participants-source')
    ?? config.participantsSource
    ?? config.paperclip?.participantsSource
    ?? (config.paperclip?.participants?.enabled ? 'paperclip' : 'config');
}

function makePaperclipClient({ args, config, dryRun }) {
  const needsPaperclip = config.usageSource.type === 'paperclip' || participantSource(args, config) === 'paperclip';
  if (!needsPaperclip) return null;

  const baseUrl = paperclipBaseUrl(args, config);
  if (!baseUrl) throw new Error('missing Paperclip baseUrl');
  return new PaperclipClient({ baseUrl, dryRun });
}

async function loadParticipants({ args, config, now, paperclipClient }) {
  const participantsSource = participantSource(args, config);
  if (participantsSource === 'config') return config.participants ?? [];
  if (participantsSource !== 'paperclip') throw new Error(`unsupported participantsSource: ${participantsSource}`);

  const source = config.paperclip?.participants ?? {};
  const companyIds = parseList(
    valueAfter(args, '--company-id')
      ?? source.companyIds
      ?? config.paperclip?.companyIds
      ?? config.paperclip?.companyId,
  );
  const providerPoolId = valueAfter(args, '--provider-pool-id') ?? source.providerPoolId ?? config.pools?.[0]?.poolId;
  return discoverPaperclipParticipants({
    client: paperclipClient,
    companyIds,
    providerPoolId,
    issueLimit: source.issueLimit ?? 500,
    defaultMaxRunsPerDay: source.defaultMaxRunsPerDay ?? 12,
    defaultCooldownSec: source.defaultCooldownSec ?? 900,
    now,
  });
}

function resolvePath(pathValue, baseDir) {
  if (!pathValue) return null;
  return isAbsolute(pathValue) ? pathValue : resolve(baseDir, pathValue);
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function usageAndExit() {
  process.stderr.write('Usage: paperclip-heartbeat-manager <decide|report|hold-plan|settings> --config <file> (--dry-run|--live --confirm-live <text>) [--usage <fixture>] [--usage-source fixture|paperclip] [--participants-source config|paperclip|--discover-paperclip-participants] [--paperclip-base-url <api>] [--company-id <uuid[,uuid]>] [--provider-pool-id <id>] [--hold-snapshot <file>] [--now <iso>] [--output <file>] [--format html|json] [--decision-log <jsonl>] [--idempotency-store <json>]\n');
  process.exit(2);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
