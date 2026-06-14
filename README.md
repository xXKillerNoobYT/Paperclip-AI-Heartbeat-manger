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
- Paperclip client adapter scaffold for issue discovery and dry-run wake invocation guard.
- Fixture usage provider and CLI dry-run command.
- Unit tests for pacing, fairness, shared-state recovery, and scheduler dry-run behavior.

---

## Architecture

```text
bin/
└── paperclip-heartbeat-manager.js   # CLI entrypoint; dry-run required
src/
├── fairness.js                      # Weighted fair-turn participant selection
├── fixture-provider.js              # Fixture usage snapshot loader
├── pacing.js                        # Session/weekly pacing gates
├── paperclip-client.js              # Paperclip API adapter scaffold
├── scheduler.js                     # Dry-run decision orchestration
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

## Usage

```bash
npm test
npm run decide
```

The example dry-run command prints a decision object with:

- provider pool
- selected participant
- weekly/session usage snapshot
- weekly mode
- fairness ranking
- skipped candidates
- expected cost
- `invoked: false`

---

## Safety boundary

Real wake invocation is deliberately not wired in this milestone. The CLI exits unless `--dry-run` is passed. Future work must add a safety/ops review and explicit owner approval before invoking Paperclip heartbeat endpoints.

---

## Development

```bash
# Run tests
npm test

# Run the fixture-backed dry-run scheduler
npm run decide
```

---

## Roadmap

- [x] Shared state file reader/writer.
- [x] Subscription-usage pacing math model.
- [x] Dry-run CLI decision output.
- [ ] Dashboard/decision output surface in Paperclip UI.
- [ ] Live heartbeat trigger integration after owner approval.
- [ ] Alert/notification support.
- [ ] Multi-project heartbeat aggregation.

---

## License

GPL-3.0 — see [LICENSE](./LICENSE).

---

## Author

Built by [@xXKillerNoobYT](https://github.com/xXKillerNoobYT) for the [Weirdtoo](https://weirdtoocompany.com) AI stack.
