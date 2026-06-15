# Paperclip AI Heartbeat Manager

> **Give yourself real control over your agents' heartbeats on Paperclip.**

A dry-run-first Paperclip plugin/CLI scaffold that monitors, tracks, and manages heartbeat decisions for CEO, CTO, and other qualified agents while pacing shared provider subscription usage windows.

Issue context:
- Parent request: WEI-3602
- Spec issue: WEI-3605
- Implementation issue: WEI-3606

Milestone 1 intentionally does not trigger real Paperclip heartbeats. It calculates a dry-run decision report from fixture/provider usage, participant configuration, pacing math, and fairness ranking.

---

## What It Does

Paperclip agents run autonomously, but visibility into whether they're alive, stalled, or burning through subscription quota too quickly is limited. This plugin fills that gap:

- 📡 **Tracks heartbeat signals** from enabled agents.
- 🧠 **Shared state file** — agents read/write central decision output so multiple companies/computers can coordinate through synced storage.
- ⚠️ **Detects stalls and loops** — flags agents that have not produced output within a configurable window.
- 📊 **Dashboard/decision surface** — exposes heartbeat and dry-run scheduling decisions for Paperclip operators.
- 🔌 **Subscription-usage aware** — integrates with cost/usage pacing so Claude/Codex/GPT credits are spent deliberately instead of burned early.

---

## What is implemented in this scaffold

- Shared synced-state JSON read/write with atomic replacement and bounded decision log.
- Lease-style lock acquisition/release with fencing token and stale lock recovery.
- Corrupt shared-state backup helper that returns safe hold.
- 6-hour session and weekly pacing math.
- Weekly pre-final-day `optimal - 5%` under-burn ceiling.
- Final-day ramp toward `hardStopAtPct` without crossing hard stops.
- Weighted deficit fairness selector with cooldown, offline, visible-work, qualification, and deterministic tie-break rules.
- Paperclip client adapter for issue discovery, agent reads, wake invocation, comments, and guarded live mutations.
- Paperclip Costs integration that can read quota windows or by-agent/model spend from the board and feed the scheduler without separate fixture files.
- Paperclip participant discovery that reads live company agents plus assigned actionable issues so the scheduler can use existing board state instead of hand-maintained participant lists.
- Fixture usage provider and live Paperclip usage/cost-limit adapter contract for dry-run decisions.
- Dry-run hold-state policy planner plus explicit opt-in live wake/hold/resume executor with idempotency and JSONL decision logs.
- Operator-visible `settings` command that resolves custom synced file locations, provider subscription-only/extra-spend gates, and enabled/disabled tool defaults from the plugin config.
- Unit tests for pacing, fairness, shared-state recovery, settings validation, and scheduler dry-run behavior.

---

## Architecture

```text
bin/
└── paperclip-heartbeat-manager.js   # CLI entrypoint; dry-run required
src/
├── fairness.js                      # Weighted fair-turn participant selection
├── fixture-provider.js              # Fixture usage snapshot loader
├── index.js                         # Public ESM exports for npm consumers
├── pacing.js                        # Session/weekly pacing gates
├── paperclip-client.js              # Paperclip API adapter scaffold
├── paperclip-discovery.js           # Discovers live agents and assigned actionable issues
├── paperclip-usage-provider.js      # Reads Paperclip Costs quota windows for scheduler telemetry
├── scheduler.js                     # Dry-run decision orchestration
├── hold-plan.js                     # Dry-run issue/agent hold and release planner
├── live-executor.js                 # Explicit opt-in live wake/hold/resume executor
├── usage-provider.js                # Fixture/Paperclip telemetry + cost-limit mapping
└── shared-state.js                  # Synced state + lease/fencing helpers
test/
├── fairness.test.js
├── pacing.test.js
├── scheduler.test.js
└── shared-state.test.js
examples/
├── heartbeat-manager.config.json
└── usage-snapshot.json
```

### Shared State File

The plugin reads and writes a shared JSON file that acts as the central decision bus. The scaffold uses atomic replacement and lease fencing so multiple companies/computers can safely coordinate through synced storage.

---

## Installation and Usage

From npm after the package is published:

```bash
npm install paperclip-ai-heartbeat-manager
```

For one-off checks without adding it to a project:

```bash
npx paperclip-ai-heartbeat-manager decide --dry-run --config ./heartbeat-manager.config.json
```

From a local checkout:

```bash
npm test
npm run decide
```

Fixture-backed dry run:

```bash
node ./bin/paperclip-heartbeat-manager.js decide \
  --dry-run \
  --config ./examples/heartbeat-manager.config.json
```

Live Paperclip telemetry dry run:

```bash
node ./bin/paperclip-heartbeat-manager.js decide \
  --dry-run \
  --config ./examples/heartbeat-manager.config.json \
  --usage-source paperclip \
  --paperclip-base-url http://localhost:3100/api
```

Review resolved plugin settings before enabling live automation:

```bash
node ./bin/paperclip-heartbeat-manager.js settings \
  --config ./examples/heartbeat-manager.config.json
```

The settings output shows operator-controlled paths for the synced shared-state file, decision log, and idempotency store; provider pool gates such as `subscriptionOnly`, `allowExtraSpend`, `extraSpendBudgetCents`, and `requireCompanyCostLimit`; and tool defaults that a Paperclip plugin settings UI can expose without mutating live state. Subscription-only pools fail closed if `allowExtraSpend` is enabled by mistake.

Hold-plan dry run from an operator snapshot:

```bash
node ./bin/paperclip-heartbeat-manager.js hold-plan \
  --dry-run \
  --config ./examples/heartbeat-manager.config.json \
  --hold-snapshot ./examples/hold-snapshot.json
```

The hold-plan command is mutation-free. It prints proposed `hold_issue`, `resume_issue`, `disable_interval_heartbeat`, and `restore_interval_heartbeat` actions plus skipped issue/agent reasons. See `docs/hold-state-policy.md` for the safety policy: closed issues, already-blocked issues, active recovery actions, active live runs, and running agents are preserved; live mutation requires explicit owner/operator approval.

Explicit live wake after safety approval:

```bash
node ./bin/paperclip-heartbeat-manager.js decide \
  --live \
  --confirm-live "I understand this mutates live Paperclip state" \
  --config ./examples/heartbeat-manager.config.json \
  --usage-source paperclip \
  --paperclip-base-url http://localhost:3100/api \
  --decision-log ./logs/heartbeat-manager-decisions.jsonl \
  --idempotency-store ./logs/heartbeat-manager-idempotency.json
```

Explicit live hold/release after safety approval:

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

Live mode is fail-closed. It requires `config.live.enabled: true`, the exact confirmation text, a Paperclip API base URL, a non-empty idempotency store path, and a non-empty decision log path. Before mutating, the executor re-reads the selected agent or issue and skips anything that is already running/live. The idempotency store is guarded by a short-lived local lock and atomic replacement so concurrent processes cannot execute the same operation twice. Live idempotency uses a stable operation fingerprint, not the timestamp-derived dry-run `decisionId`, so rerunning the same wake/hold/release command seconds later returns `duplicate: true` without invoking Paperclip again. Every completed or duplicate decision is appended to the JSONL decision log, and wake responses are compacted to non-secret identifiers/status fields.

The Paperclip source currently reads:

- `GET /companies/{companyId}/costs/quota-windows` for provider quota windows. Provider adapter results are mapped by `pool.provider`/`pool.quotaProvider`; labels matching `5h`, `6h`, `session`, or `current` become `session_6h`, and labels matching `weekly` become `weekly`.
- `GET /companies/{companyId}/costs/summary` for monthly spend and company budget utilization.
- `GET /companies/{companyId}/budgets/overview` for active budget incidents and budget-policy state.

If provider quota telemetry is absent, stale, missing required windows, or returned as provider failure, the scheduler returns `hold`. If a pool or participant sets `requireCompanyCostLimit: true` and no company budget/cost-limit telemetry is available, that participant is skipped and the decision holds. A zero-dollar company budget is treated as monitoring-only unless an active budget incident exists; configured budgets and active incidents are hard stops.

From an installed package/tarball:

```bash
npm install paperclip-ai-heartbeat-manager
npx paperclip-heartbeat-manager decide --dry-run \
  --config ./node_modules/paperclip-ai-heartbeat-manager/examples/heartbeat-manager.config.json
```

The CLI resolves relative fixture paths from the config file location, so the packaged example config works after `npm install` from any consumer project directory.

To tap into Paperclip's built-in Costs → Providers telemetry instead of maintaining a separate usage fixture, point the same config at a live Paperclip API and set `usageSource` to `paperclip` or pass it on the command line:

```bash
npx paperclip-heartbeat-manager decide --dry-run \
  --config ./node_modules/paperclip-ai-heartbeat-manager/examples/heartbeat-manager.config.json \
  --usage-source paperclip \
  --paperclip-base-url http://localhost:3100/api \
  --company-id 803d6ebd-cc2a-415f-8bbf-6a800fa36d20
```

The Paperclip source reads `/companies/:companyId/costs/quota-windows`, matches each configured provider pool by `provider` (`anthropic`, `openai`, etc.), and normalizes the reported 5h/6h and weekly quota windows into the scheduler's `session_6h` and `weekly` pacing inputs. The example config includes both an Anthropic/Claude pool and an OpenAI/GPT pool so GPT-backed agents can be paced with the same Paperclip telemetry path. If Paperclip reports a provider polling failure or missing window, the scheduler receives missing telemetry and safely holds rather than waking agents blindly.

To use Paperclip's existing company/agent/issue state for participants instead of writing a static `participants` array, add `--discover-paperclip-participants` (or set `participantsSource: "paperclip"` / `paperclip.participants.enabled: true`). The discovery path reads `/companies/:companyId`, `/agents`, and `/issues`, then builds fair-turn candidates from wake-capable agents and their assigned `todo`, `backlog`, or `in_progress` issues:

```bash
npx paperclip-heartbeat-manager decide --dry-run \
  --config ./heartbeat-manager.config.json \
  --paperclip-base-url http://localhost:3100/api \
  --company-id 803d6ebd-cc2a-415f-8bbf-6a800fa36d20 \
  --discover-paperclip-participants
```

The package exposes both:

- CLI binaries: `paperclip-ai-heartbeat-manager` and `paperclip-heartbeat-manager`
- ESM API entrypoint: `import { decideDryRun, evaluatePacing, selectParticipant } from 'paperclip-ai-heartbeat-manager'`

The published npm tarball intentionally includes `bin/`, `src/`, `examples/`, `docs/`, `README.md`, and `LICENSE`; it excludes local git/worktree artifacts.

The example dry-run command prints a decision object with:

- provider pool
- selected participant
- weekly/session usage snapshot
- weekly mode
- fairness ranking
- skipped candidates
- expected cost
- Paperclip cost-limit evidence when live cost limits were read
- `invoked: false`

---

## Safety boundary

Dry-run remains the default behavior. Omitting `--live` produces dry-run decisions and hold plans only.

Live mode is intentionally gated for owner/operator approval and SecurityAgent review before merge:

- `config.live.enabled` must be `true`; the checked-in example keeps it `false`.
- The CLI must pass `--live` and the exact `--confirm-live` text.
- The executor requires and writes a decision log and idempotency/fencing store before performing any mutation; the idempotency store uses a local lock plus atomic replacement to fence concurrent duplicate operations.
- Wake execution re-reads the selected agent and skips if it is running/busy/working.
- Hold/release execution re-reads each issue/agent and skips currently running work immediately before mutation.
- Live hold execution persists a namespaced `holdState` marker with previous issue status / heartbeat state so a later release plan can safely identify only heartbeat-manager-held records.
- Duplicate operation fingerprints are fenced and do not invoke Paperclip twice even when the dry-run decision timestamp changes; JSONL decision logs compact Paperclip wake responses to run/status identifiers instead of storing full response bodies.
- Emergency disable is to set `config.live.enabled=false`, remove `--live`, or point automation back to `--dry-run`.

---

## Development

```bash
# Run tests
npm test

# Run the fixture-backed dry-run scheduler
npm run decide

# Generate a browser-reviewable operator dashboard
npm run report

# Verify npm package contents before publishing
npm run pack:check
```

The report command writes `reports/operator-dashboard.html`. It includes provider pools,
session/weekly reset timers, usage %, optimal-vs-actual burn, safety margin, next wake
candidate, skipped/held work, plain-English hold/wake reasons, telemetry diagnostics,
and an explicit desktop/tablet/mobile + accessibility verification note for review.

---

## Roadmap

- [x] Shared state file reader/writer.
- [x] Subscription-usage pacing math model.
- [x] Dry-run CLI decision output.
- [x] Browser-reviewable dashboard/decision output surface.
- [x] Dry-run hold-state policy planner for issue/agent pause and reset release plans.
- [x] Gated live heartbeat trigger integration after owner approval.
- [x] Gated live hold/resume mutation mode after owner/operator approval.
- [ ] Alert/notification support.
- [ ] Multi-project heartbeat aggregation.

---

## License

GPL-3.0 — see [LICENSE](./LICENSE).

---

## Author

Built by [@xXKillerNoobYT](https://github.com/xXKillerNoobYT) for the [Weirdtoo](https://weirdtoocompany.com) AI stack.
