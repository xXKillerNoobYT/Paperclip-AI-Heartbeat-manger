# Heartbeat Manager Hold-State Policy

Issue: WEI-3622

This document defines the first safe Paperclip-side hold policy for the heartbeat manager. Dry-run remains the default and reports the exact issue and agent changes that would be made. A separate live executor exists, but it is fail-closed behind explicit config, CLI confirmation text, idempotency/fencing, and pre-mutation rechecks.

## Goals

- Let a manager pause future agent work when provider usage, session quota, weekly quota, or Paperclip company budget limits say new wakes should stop.
- Avoid killing or interrupting already-running agents.
- Preserve real blocked/recovery state instead of overwriting it with usage-hold state.
- Provide a reviewable release plan when the weekly/session usage window resets.
- Require owner/operator approval before live mutation mode is enabled.

## Inputs

The hold plan accepts a snapshot with:

- `companyId` — Paperclip company UUID.
- `trigger.state` — `hold`, `over_limit`, `limited`, or `exhausted` for hold mode; `release`, `available`, `ok`, `under_limit`, or `reset` for resume mode.
- `trigger.reason` — plain-English reason shown on every proposed action.
- `trigger.resetAt` — usage reset time when known.
- `issues[]` — Paperclip issue summaries with at least `id`, `identifier`, and `status`; optional `activeRecoveryAction`, `liveRunActive`, `currentRunId`, `executionRunId`, `liveRuns`, and `holdState`.
- `agents[]` — Paperclip agent summaries with at least `id`, `name`, `status`, and `runtimeConfig.heartbeat`; optional `holdState`.

## Hold mode rules

Hold mode proposes only future-work pauses:

1. Candidate issues are `todo`, `backlog`, or `in_progress` only.
2. `done` and `cancelled` issues are always excluded.
3. Already `blocked` issues are preserved as-is so the manager does not overwrite a real blocker chain.
4. Issues with `activeRecoveryAction` are preserved so stale recovery/adaptor paths remain diagnosable.
5. Issues with active live work (`liveRunActive`, `currentRunId`, `executionRunId`, or non-empty `liveRuns`) are preserved.
6. Idle agents with `runtimeConfig.heartbeat.enabled === true` are candidates for `disable_interval_heartbeat`.
7. Running/busy/working agents are preserved. The hold plan must not stop or cancel active execution.

## Release mode rules

Release mode resumes only state that the hold plan owns:

1. An issue is eligible only when `holdState.source === "heartbeat_manager_hold_plan"`.
2. Closed issues remain closed even if they contain old hold metadata.
3. The resume target is `holdState.previousStatus`; unsafe previous statuses (`done`, `cancelled`, `blocked`) fall back to `todo`.
4. An agent is eligible only when `holdState.source === "heartbeat_manager_hold_plan"` and `holdState.previousHeartbeatEnabled === true`.
5. Running agents remain preserved during release as well.
6. Unrelated blocked issues and unrelated disabled heartbeats are reported as skipped, not changed.

## Live ownership, idempotency, and override

- `buildHoldPlan()` is still a planning function and returns `mode: "dry_run"`, `mutationsEnabled: false`, and `requiresOwnerApprovalForLiveMutation: true`.
- Live execution is separate (`src/live-executor.js`) and requires all of the following:
  1. `config.live.enabled === true`.
  2. CLI `--live` instead of `--dry-run`.
  3. Exact `--confirm-live` text matching `config.live.confirmationText`.
  4. A Paperclip API base URL.
  5. A JSON idempotency/fencing store so duplicate `decisionId` values cannot mutate twice.
  6. A short-lived local lock around the idempotency store so concurrent processes cannot both execute the same decision before either one marks it complete.
  7. A JSONL decision log path for reviewable operator evidence; wake responses are compacted to run/status identifiers rather than full response bodies.
- Before applying an issue hold or release, the live executor re-reads the issue and skips it if a live run or execution run is present.
- Before disabling/restoring an agent heartbeat, the live executor re-reads the agent and skips it if the agent is running/busy/working.
- Hold execution posts an issue comment explaining decision id, fencing token, prior status, reason, reset target, and non-interruption safety before changing status.
- Release execution posts an issue comment explaining decision id, fencing token, reason, and restored status before changing status.
- Any emergency override should be manager/operator-owned, comment why the hold was bypassed, preserve evidence of provider/budget state, and disable live mode by setting `config.live.enabled=false` or running only `--dry-run`.

## CLI usage

```bash
node ./bin/paperclip-heartbeat-manager.js hold-plan \
  --dry-run \
  --config ./examples/heartbeat-manager.config.json \
  --hold-snapshot ./examples/hold-snapshot.json
```

Live hold/release after approval:

```bash
node ./bin/paperclip-heartbeat-manager.js hold-plan \
  --live \
  --confirm-live "I understand this mutates live Paperclip state" \
  --config ./examples/heartbeat-manager.config.json \
  --hold-snapshot ./examples/hold-snapshot.json \
  --paperclip-base-url http://localhost:3100/api \
  --decision-log ./logs/heartbeat-manager-decisions.jsonl \
  --idempotency-store ./logs/heartbeat-manager-idempotency.json
```

The command prints JSON with:

- `issueActions` — proposed `hold_issue` or `resume_issue` changes.
- `skippedIssues` — exclusions and reasons.
- `agentActions` — proposed heartbeat disables/restores.
- `skippedAgents` — exclusions and reasons.
- `policy` — machine-readable safety boundaries used by the planner.

## Acceptance checks

The test suite covers:

- done/cancelled exclusions;
- currently-running issue and agent preservation;
- stale recovery-action preservation;
- already-blocked issue preservation;
- weekly/session reset release behavior for hold-plan-managed issues/agents only;
- dry-run/no-mutation mode;
- live fail-closed config/confirmation checks;
- live duplicate-decision idempotency and concurrent duplicate fencing;
- live wake, hold, release, API failure surface, and running-work preservation with mocked Paperclip API.
