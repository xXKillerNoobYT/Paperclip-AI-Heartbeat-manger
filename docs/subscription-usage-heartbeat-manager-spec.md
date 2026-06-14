# Subscription Usage Heartbeat Manager Plugin Specification

Issue: WEI-3605
Parent request: WEI-3602
Initial target company: Government Watchdog
Future target: multiple Paperclip companies and multiple computers sharing the same subscription pool through a synced state file

## 1. Purpose

Build a Paperclip plugin that uses provider subscription usage telemetry to schedule and trigger qualified Paperclip agent wakes so subscription capacity is used evenly, safely, and intentionally.

The plugin must solve two pacing problems at the same time:

1. Short rolling/session window pacing, shown in the attached owner screenshot as a 6-hour/current-session window.
2. Weekly subscription window pacing, shown in the screenshot as a weekly limit with a reset time.

The desired operating behavior is:

- Before the final day of the weekly window, stay under the optimal weekly burn line by a safety margin of 5%.
- During the final day before weekly reset, use the remaining weekly capacity more aggressively so the subscription approaches 100% utilization before reset without crossing hard provider limits.
- Use 6-hour/session pacing so a single burst does not exhaust a short-term quota window.
- Rotate work fairly across qualifying CEOs and key agents, with fairness more important than raw throughput.
- Coordinate across companies and computers when they share the same provider subscription.
- Preserve the current Paperclip heartbeat policy by default: routine heartbeats remain CEO-only unless this plugin explicitly qualifies another agent, records why, and triggers a bounded wake.

## 2. Screenshot-derived facts

The attached usage image shows a provider dashboard with these concrete fields:

- Dashboard title: `Usage for Claude Dashboard`.
- Current Session usage: `3%`.
- Current Session reset: `Resets in 4 hr 49 min (7:09 PM)`.
- Weekly Limit usage: `18%`.
- Weekly Limit reset: `Resets Mon, 9:59 AM`.
- The dashboard has both `Session` and `Weekly` series enabled.
- The current-session chart is scaled from 0% to 100%.
- The visible current-session timeline runs from `Now` through hourly ticks until reset.
- The history chart supports ranges including `12h`, `24h`, `3d`, `7d`, `30d`, and `90d`.

The plugin must not hard-code these exact percentages or reset times. They are examples of the data shape the integration must read from Paperclip/provider usage tracking.

## 3. Definitions

Provider: A quota-bearing model provider or subscription surface, for example Claude, Codex/GPT, or another future provider.

Subscription pool: One account/subscription quota source shared by one or more companies, agents, and computers.

Usage window: A bounded quota interval with a reset time. This spec requires at least:

- `session_6h`: short-term/current-session quota window.
- `weekly`: weekly subscription quota window.

Usage percent: Provider-reported consumed capacity as a percentage of the window limit. If Paperclip exposes raw units instead, convert to percentage with `used / limit * 100`.

Optimal burn: The usage percentage that would be consumed at the current point in time if the full allowed capacity were spread evenly across the window.

Safety margin: The required buffer below the optimal weekly burn line before final-day mode. Owner requested 5% under optimal. In this spec that means `targetCeilingPct = max(0, optimalPct - 5)` before final-day mode.

Final-day mode: The last 24 hours before weekly reset. In this mode, the weekly target changes from preserving a 5% under-burn buffer to safely spending the remaining quota before reset.

Qualified agent: A Paperclip agent that the plugin is allowed to wake. Qualification is explicit config, not inferred only from agent name.

Turn: A scheduled wake opportunity for one qualified agent/provider/company participant.

Participant: One schedulable agent entry. It may live on any connected company/computer and references a provider quota pool.

## 4. Non-goals and boundaries

The plugin must not:

- Create hidden polling loops or bypass visible Paperclip run records.
- Enable all non-CEO routine heartbeats globally.
- Trigger campaign messaging, official public-contact automation, legal conclusions, or final publication decisions.
- Spend provider quota blindly when Paperclip usage telemetry is stale or unavailable.
- Assume all computers are online.
- Mutate every agent heartbeat config as its primary scheduling mechanism.
- Treat a local synced file as authoritative forever if its lease/heartbeat is stale.
- Exceed provider hard limits intentionally.

The plugin may:

- Trigger heartbeat-like wakes through Paperclip's existing wake/invoke mechanism.
- Temporarily qualify non-CEO key agents for plugin-triggered work when config says so and quota math allows it.
- Adjust future plugin wake cadence based on quota state.
- Record fairness and usage decisions in a shared state file.

## 5. Required Paperclip integration points

Implementation must use supported Paperclip surfaces where possible:

1. Usage telemetry input
   - Read Paperclip's provider usage tracking if available.
   - Required fields per provider/window:
     - provider key
     - account/subscription pool key
     - window kind
     - used percent or raw used/limit
     - reset time
     - last updated time
     - source confidence/staleness

2. Agent/company inventory
   - Read company IDs, agents, model/provider mappings, enabled state, and runtime adapter type.
   - Read or store plugin-specific qualification metadata.

3. Wake trigger
   - Use the same visible mechanism Paperclip uses for heartbeat expiration where practical, for example a heartbeat invoke/wake endpoint or equivalent internal scheduler API.
   - Every plugin-triggered wake must produce normal issue/run/activity evidence.

4. Audit log
   - Record each scheduling decision with quota snapshot, fairness score, selected participant, reason, and skipped candidates.

5. Configuration
   - Company-level config controls initial GOV-only scope.
   - Provider-pool config maps provider accounts to shared state files.
   - Agent-level config declares whether an agent is qualified.

## 6. Configuration model

Configuration should be explicit and safe by default.

Example YAML/JSON shape:

```json
{
  "enabled": true,
  "scope": {
    "companyIds": ["bcac096e-4aff-4ce3-ad33-c4e0b693b36f"],
    "defaultCompanyMode": "deny"
  },
  "pools": [
    {
      "poolId": "claude-main-isaac",
      "provider": "claude",
      "stateFile": "/path/to/synced/paperclip-heartbeat-manager/claude-main.json",
      "windows": ["session_6h", "weekly"],
      "finalDayHours": 24,
      "preFinalWeeklyUnderburnPct": 5,
      "hardStopAtPct": 98,
      "staleTelemetryMaxAgeSec": 300,
      "lockTtlSec": 60
    }
  ],
  "participants": [
    {
      "participantId": "gov-ceo-claude",
      "companyId": "bcac096e-4aff-4ce3-ad33-c4e0b693b36f",
      "agentId": "...",
      "providerPoolId": "claude-main-isaac",
      "role": "CEO",
      "qualified": true,
      "weight": 1,
      "minCooldownSec": 900,
      "maxRunsPerDay": 12,
      "allowedWorkKinds": ["planning", "triage", "workflow", "source_review"],
      "requiresVisibleIssue": true
    }
  ]
}
```

Default values:

- `enabled`: false until explicitly enabled.
- `defaultCompanyMode`: deny.
- `preFinalWeeklyUnderburnPct`: 5.
- `finalDayHours`: 24.
- `hardStopAtPct`: 98, leaving 2% provider/dashboard error buffer unless owner overrides.
- `staleTelemetryMaxAgeSec`: 300.
- `lockTtlSec`: 60.
- `requiresVisibleIssue`: true.

## 7. Shared synced-state file schema

The shared state file is the coordination source for multi-company and multi-computer fairness. It is not a substitute for Paperclip's own issue/run records.

Recommended JSON schema version 1:

```json
{
  "schemaVersion": 1,
  "stateId": "claude-main-isaac",
  "updatedAt": "2026-06-14T20:00:00Z",
  "updatedBy": {
    "computerId": "isaac-macbook",
    "companyId": "bcac096e-4aff-4ce3-ad33-c4e0b693b36f",
    "processId": "paperclip-plugin-heartbeat-manager"
  },
  "lock": {
    "ownerId": null,
    "token": null,
    "acquiredAt": null,
    "expiresAt": null,
    "fencingToken": 0
  },
  "providerPool": {
    "poolId": "claude-main-isaac",
    "provider": "claude",
    "accountAlias": "primary",
    "timezone": "America/Denver"
  },
  "windows": {
    "session_6h": {
      "usagePct": 3,
      "limitUnits": null,
      "usedUnits": null,
      "resetAt": "2026-06-14T19:09:00-06:00",
      "lastTelemetryAt": "2026-06-14T14:20:42-06:00",
      "source": "paperclip_usage_tracking",
      "confidence": "reported"
    },
    "weekly": {
      "usagePct": 18,
      "limitUnits": null,
      "usedUnits": null,
      "resetAt": "2026-06-15T09:59:00-06:00",
      "lastTelemetryAt": "2026-06-14T14:20:42-06:00",
      "source": "paperclip_usage_tracking",
      "confidence": "reported"
    }
  },
  "participants": {
    "gov-ceo-claude": {
      "companyId": "bcac096e-4aff-4ce3-ad33-c4e0b693b36f",
      "agentId": "...",
      "providerPoolId": "claude-main-isaac",
      "qualified": true,
      "weight": 1,
      "lastRunAt": null,
      "lastSuccessfulRunAt": null,
      "lastSkippedAt": null,
      "runCountWindow": {
        "session_6h": 0,
        "weekly": 0
      },
      "estimatedUsageUnitsWindow": {
        "session_6h": 0,
        "weekly": 0
      },
      "deficitScore": 0,
      "cooldownUntil": null,
      "offlineUntil": null,
      "lastDecisionReason": null
    }
  },
  "decisionLog": [
    {
      "decisionId": "uuid",
      "createdAt": "2026-06-14T20:00:00Z",
      "type": "wake|skip|hold",
      "selectedParticipantId": "gov-ceo-claude",
      "providerPoolId": "claude-main-isaac",
      "windowSnapshot": {
        "sessionUsagePct": 3,
        "weeklyUsagePct": 18,
        "sessionResetAt": "2026-06-14T19:09:00-06:00",
        "weeklyResetAt": "2026-06-15T09:59:00-06:00"
      },
      "reason": "weekly below target and session window has budget",
      "skipped": []
    }
  ]
}
```

State-file requirements:

- Write atomically: write to a temp file, fsync when possible, then rename.
- Keep only a bounded decision log in the shared file, for example last 500 decisions; full logs can be local Paperclip logs.
- Include `schemaVersion` and reject unknown future major versions.
- Store timestamps in ISO-8601 with timezone or UTC.
- Never store API keys or provider secrets in the shared state file.

## 8. Locking and conflict recovery

The plugin must guard the synced file with a lease-style lock.

Lock algorithm:

1. Read file.
2. If no lock or `lock.expiresAt < now`, attempt to acquire.
3. Generate a random token and increment `fencingToken`.
4. Atomically write the lock.
5. Re-read and confirm the token and fencing token are still present.
6. Perform scheduling decision and update state.
7. Release lock by clearing owner/token, or let it expire on crash.

Conflict handling:

- If two computers write conflicting states, the highest fencing token wins only if its `updatedAt` is newer and its lock token matches its decision.
- If file parse fails, copy the corrupt file to a timestamped `.corrupt` backup and enter safe hold mode until Paperclip telemetry can rebuild a minimal state.
- If lock is held and not stale, skip this cycle and log `hold: lock_held`.
- If lock is stale, recover it and log `lock_recovered`.
- If synced file disappears, recreate only if config permits and Paperclip telemetry is fresh.

## 9. Fallback behavior when a computer is off

Each participant/computer must maintain a liveness record.

- If a participant's `lastSeenAt` or local computer heartbeat is older than `offlineAfterSec`, mark its candidates offline.
- Offline participants do not get turns while offline.
- Their missed turns are not immediately dumped onto the next online participant if that would violate session or weekly pacing.
- Fairness deficit may accumulate up to a cap, for example `maxDeficitCarry = 3 turns`, so returning computers can catch up gradually.
- If only one computer is online, it may use the pool subject to quota ceilings and participant cooldowns.
- If all provider telemetry is stale, no wake is triggered.

## 10. Pacing math

### 10.1 Window progress

For a usage window:

```text
windowStart = previous reset time, if known, else resetAt - configuredWindowDuration
windowEnd = resetAt
elapsedSec = clamp(now - windowStart, 0, windowEnd - windowStart)
windowSec = windowEnd - windowStart
progress = elapsedSec / windowSec
```

For `session_6h`, configured duration is 6 hours when previous reset is not reported.
For weekly, configured duration is 7 days when previous reset is not reported.

### 10.2 Optimal burn line

```text
optimalPct = 100 * progress
```

This is the straight-line budget that would hit 100% exactly at reset.

### 10.3 Pre-final-day weekly target

Before the final day:

```text
weeklyTargetCeilingPct = max(0, optimalPct - 5)
weeklyOverTarget = weeklyUsagePct >= weeklyTargetCeilingPct
```

If usage is over target, hold or reduce wakes unless there is an explicitly configured minimum maintenance wake.

Important interpretation: At the very beginning of a weekly window, `optimalPct - 5` may be negative. Clamp to zero. This means no quota spending is required just to satisfy the 5% under target when the week has barely started.

### 10.4 Final-day weekly ramp

During final-day mode, use remaining quota with increasing urgency but preserve provider error buffer.

```text
hoursRemaining = max((weeklyResetAt - now) / 3600, 0)
remainingUsablePct = max(0, hardStopAtPct - weeklyUsagePct)
remainingTimeFraction = hoursRemaining / finalDayHours
finalDayTargetPct = hardStopAtPct - (hardStopAtPct * remainingTimeFraction)
finalDayTargetPct = clamp(finalDayTargetPct, 0, hardStopAtPct)
```

Wake more aggressively when:

```text
weeklyUsagePct < finalDayTargetPct
```

If usage is still far below target in the last few hours, reduce cooldowns for qualified participants but never violate `session_6h` hard stop.

### 10.5 Session/6-hour gating

Short-term gate must always protect the session window.

Recommended limits:

```text
sessionHardStopPct = configured hard stop, default 90 or provider-reported warning threshold
sessionSoftTargetPct = min(90, 100 * sessionProgress - sessionSafetyMarginPct)
```

A wake is allowed only if:

```text
sessionUsagePct + estimatedWakeCostPct <= sessionHardStopPct
```

If estimated wake cost is unknown, use a conservative default based on recent median usage for that provider/agent/work kind. If there is no history, start with a small fixed estimate such as 2% and update after telemetry changes.

### 10.6 Combined decision

A candidate wake is allowed when all are true:

- Plugin enabled.
- Provider telemetry fresh.
- Participant qualified and online.
- Participant cooldown elapsed.
- Participant max-runs-per-day/session not exceeded.
- Session gate allows the estimated wake cost.
- Weekly gate allows or requests spending.
- There is visible actionable Paperclip work or a configured maintenance workflow.

If weekly says `spend` but session says `hold`, hold until the session window resets or cools down.

## 11. Fairness and turn-taking

Fairness is based on weighted deficit round robin.

Each participant has:

- `weight`: default 1.
- `turnsExpected`: proportional share of total turns in the active fairness window.
- `turnsActual`: count of wakes actually triggered.
- `deficitScore = turnsExpected - turnsActual`, adjusted for cooldown/offline state.

Selection algorithm:

1. Build candidate list from qualified, online, cooldown-free participants in the provider pool.
2. Remove candidates whose provider/window gates fail.
3. Remove candidates with no visible allowed work unless maintenance wakes are explicitly configured.
4. Sort by:
   - highest `deficitScore`
   - oldest `lastRunAt`
   - higher priority work kind
   - deterministic participant ID tiebreaker
5. Select one participant per scheduling tick unless config allows batch wakes.
6. After wake is triggered, increment actual turn count and record decision.

Fairness constraints:

- No participant can be selected twice in a row while another eligible participant has positive deficit, unless the other participant is blocked/offline/cooling down.
- Returning offline participants may catch up gradually, but catch-up must not starve online participants or exceed quota gates.
- Provider fairness is separate from company fairness. A Claude pool and a Codex pool do not compete unless they share a higher-level subscription policy.

## 12. Wake sizing and estimated cost

The plugin needs an estimate of quota consumed by a wake.

Minimum implementation:

- Record before/after usage percent snapshots for each triggered wake.
- Attribute delta to the participant if telemetry resolution allows.
- Maintain rolling medians per provider, agent, and work kind.
- Use conservative fallback estimates when no history exists.

Suggested fields:

```json
{
  "costEstimate": {
    "providerPoolId": "claude-main-isaac",
    "participantId": "gov-ceo-claude",
    "workKind": "triage",
    "sessionPctMedian": 1.2,
    "weeklyPctMedian": 0.15,
    "sampleCount": 8,
    "lastUpdatedAt": "..."
  }
}
```

If provider usage is too coarse to attribute deltas accurately, count turns equally for fairness and keep a conservative session buffer.

## 13. Work discovery rules

The plugin should not wake agents into empty loops.

Before triggering a wake, check for one of:

- Assigned actionable issue in `todo`, `backlog`, or `in_progress`.
- Explicit plugin-created maintenance issue or workflow run.
- Approved manager/owner goal that requires a periodic check.
- A visible stale-blocker/recovery case assigned to the participant.

Statuses that should not be treated as actionable: `blocked`, `done`, `cancelled`, unless a recovery workflow explicitly asks for a visible coordination check.

## 14. Audit comments and run evidence

Every wake decision must be explainable. At minimum log:

- provider pool
- company
- agent
- issue/workflow target
- current session usage and reset
- weekly usage and reset
- weekly mode: pre-final-day or final-day
- fairness rank/deficit
- selected/skipped candidates
- expected cost
- actual run id after invocation

Do not spam Paperclip comments for every internal hold. Use structured plugin logs for holds and only comment when a visible issue state changes or an operator needs attention.

## 15. Safety modes

Safe hold mode is entered when:

- telemetry is stale beyond `staleTelemetryMaxAgeSec`
- usage percent is missing or unparsable
- reset time is missing
- shared state lock cannot be acquired for multiple consecutive cycles
- state file corruption cannot be recovered
- provider reports usage over hard stop
- Paperclip wake endpoint fails repeatedly
- configuration includes no qualified participants

In safe hold mode:

- Do not trigger wakes.
- Log the reason.
- Optionally create or update one visible operator issue after a configured threshold, not every cycle.

## 16. Provider abstraction

Implement providers behind a common interface:

```ts
interface UsageProvider {
  providerKey: string;
  readUsage(poolConfig: ProviderPoolConfig): Promise<UsageSnapshot>;
}

interface UsageSnapshot {
  providerPoolId: string;
  collectedAt: string;
  windows: Record<string, {
    usagePct: number;
    usedUnits?: number;
    limitUnits?: number;
    resetAt: string;
    confidence: 'reported' | 'estimated' | 'stale';
  }>;
}
```

Initial provider priority:

1. Paperclip built-in usage tracking adapter.
2. Provider dashboard/API scraper only if already approved and stable.
3. Manual/test fixture provider for local tests.

## 17. Scheduler cadence

This plugin should not become a hidden heartbeat. It should be event-driven where possible.

Allowed triggers:

- Paperclip usage telemetry update event.
- Paperclip issue/assignment event that creates actionable work.
- Provider reset boundary approaching.
- Explicit operator/manager manual run.
- A low-frequency visible scheduler owned by the plugin, for example every 15-60 minutes, only while enabled and recorded as plugin activity.

Not allowed:

- Secret per-agent intervals that bypass Paperclip run records.
- Enabling ordinary heartbeat intervals for every agent.

## 18. API/checklist for BackendCoder implementation

BackendCoder should implement in this order:

1. Create config types and validation.
2. Create shared-state read/write module with atomic writes and lease locks.
3. Create usage provider interface and a fixture provider for tests.
4. Create pacing math module with deterministic unit tests.
5. Create fairness selector module with deterministic unit tests.
6. Create Paperclip integration adapter for issues, agents, and wake trigger.
7. Create scheduler decision loop that returns a dry-run decision object before invoking.
8. Create audit logger.
9. Add safe hold behavior.
10. Add end-to-end fixture tests for multi-company/multi-computer coordination.
11. Only then wire real wake invocation.

## 19. Required tests

Pacing math tests:

- Weekly at 18% with reset in less than 24h enters final-day mode.
- Pre-final-day weekly target clamps `optimal - 5` at zero.
- Pre-final-day over-target usage suppresses wakes.
- Final-day under-target usage requests wakes.
- Session hard stop blocks wakes even when weekly wants spending.
- Missing reset time enters safe hold.
- Stale telemetry enters safe hold.

Fairness tests:

- Equal weights alternate turns between two eligible CEOs.
- Weighted participants receive proportional turns over time.
- Offline participant is skipped.
- Returning participant catches up gradually without exceeding deficit cap.
- Cooldown blocks an otherwise highest-deficit participant.
- Deterministic tie-break produces stable output.

Shared state tests:

- Atomic write leaves either old or new valid JSON.
- Stale lock can be recovered.
- Active lock causes hold.
- Corrupt JSON is backed up and safe hold is returned.
- Unknown schema major version is rejected.

Paperclip integration tests:

- Only actionable statuses trigger work discovery.
- Blocked/done/cancelled issues do not trigger normal wakes.
- A wake decision records selected issue/agent/provider evidence.
- Non-CEO agent requires explicit qualification reason.

## 20. Acceptance checklist

The implementation is ready only when:

- The plugin can run in dry-run mode against fixture telemetry and produce a decision report.
- The plugin handles both `session_6h` and `weekly` windows.
- Weekly pre-final-day mode keeps usage at least 5% under optimal burn.
- Weekly final-day mode ramps toward near-full usage before reset while preserving hard-stop buffer.
- Session/6-hour hard stop prevents bursts.
- Fairness rotates turns across qualified agents and companies.
- Shared synced-state file works with locking, stale recovery, and offline computers.
- Every wake uses visible Paperclip mechanisms and creates auditable evidence.
- GOV can be enabled first without enabling other WEI/GOV/other-company participants.
- The plugin defaults to safe hold when telemetry/config/state is unsafe.
- Unit tests cover math, fairness, locking, and work discovery.

## 21. Open implementation decisions

These are implementation decisions BackendCoder should resolve or expose as config, not guesses hidden in code:

- Exact Paperclip built-in usage tracking endpoint/schema to read.
- Exact wake endpoint or internal plugin hook Paperclip wants third-party plugins to use.
- Whether session hard stop default should be 90%, 95%, or a provider-reported threshold.
- Where plugin config is stored in Paperclip: company settings, plugin config file, database, or all of the above.
- How to map provider accounts to shared pool IDs when multiple computers use different local credentials for the same subscription.
- Whether dry-run decisions should appear in the UI as plugin logs, comments, or a dashboard panel.

## 22. Recommended first milestone

Milestone 1 should be a no-wake dry-run CLI/plugin command:

```text
paperclip-heartbeat-manager decide --config ./heartbeat-manager.config.json --dry-run
```

It should print:

- current telemetry snapshot
- calculated weekly/session targets
- eligible participants
- fairness ranking
- final decision: wake/hold/skip
- exact reason

This gives safe verification before any subscription credits are spent automatically.
