# Paperclip AI Heartbeat Manager

> **Give yourself real control over your agents' heartbeats on Paperclip.**

A Paperclip plugin/CLI that monitors and manages qualified agent heartbeat decisions while pacing shared provider subscription usage windows. Milestone 1 is dry-run only: it calculates decisions and writes shared state, but it does not trigger real Paperclip heartbeats.

Issue context:
- Parent request: WEI-3602
- Spec issue: WEI-3605
- Implementation issue: WEI-3606

---

## Why This Exists

When you have 15+ agents running across multiple projects or companies, it is easy to miss when a key agent like the CEO or CTO has gone silent, or to burn too much subscription capacity too early in the week.

This project is intended to make that visible and controllable before it becomes a problem:

- 📡 Track heartbeat decisions for enabled agents.
- 🧠 Use a synced shared state file as the central decision bus.
- 📊 Pace provider subscription usage across 6-hour and weekly windows.
- ⚖️ Rotate qualified agents fairly across companies/computers sharing a subscription.
- 🔒 Start with dry-run/no-wake behavior until safety and ops review approves live invocation.

---

## What is implemented

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
.
├── bin/
│   └── paperclip-heartbeat-manager.js   # CLI entrypoint
├── docs/
│   └── subscription-usage-heartbeat-manager-spec.md
├── examples/
│   ├── heartbeat-manager.config.json
│   └── usage-snapshot.json
├── src/
│   ├── fairness.js                      # weighted deficit/fair rotation
│   ├── fixture-provider.js              # fixture usage snapshots
│   ├── pacing.js                        # 6-hour + weekly usage math
│   ├── paperclip-client.js              # Paperclip API adapter scaffold
│   ├── scheduler.js                     # dry-run decision orchestration
│   └── shared-state.js                  # atomic synced-state + locking
├── test/
│   ├── fairness.test.js
│   ├── pacing.test.js
│   ├── scheduler.test.js
│   └── shared-state.test.js
└── package.json
```

### Shared State File

The manager reads and writes a shared JSON state file that can live in a synced folder shared by multiple machines. It records the current lock, recent decisions, and participant deficits so agents can take turns across companies/computers.

---

## Installation

> **Requires:** Node.js 20+.

```bash
git clone https://github.com/xXKillerNoobYT/Paperclip-AI-Heartbeat-manger.git
cd Paperclip-AI-Heartbeat-manger
npm test
```

This package has no runtime npm dependencies in the first dry-run milestone.

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

Real wake invocation is deliberately not wired in this milestone. The CLI exits unless `--dry-run` is passed. Future work must add a safety/ops review before invoking Paperclip heartbeat endpoints.

---

## Roadmap

- [x] Shared state file reader/writer.
- [x] Dry-run subscription pacing and fairness decision engine.
- [x] Fixture usage provider and Paperclip client scaffold.
- [ ] Live Paperclip heartbeat invocation after explicit safety review.
- [ ] Dashboard/status surface inside Paperclip UI.
- [ ] Alert/notification support.
- [ ] Multi-project heartbeat aggregation.

---

## License

MIT — see [LICENSE](./LICENSE)

---

## Author

Built by [@xXKillerNoobYT](https://github.com/xXKillerNoobYT) for the Weirdtoo AI stack.
