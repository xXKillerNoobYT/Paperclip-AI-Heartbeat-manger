# Paperclip AI Heartbeat Manager

> **Give yourself real control over your agents' heartbeats on Paperclip.**

A Paperclip plugin that monitors, tracks, and manages the heartbeat signals of your CEO, CTO, and key agents — so you always know what's running, what's stalled, and what's dead.

---

## What It Does

Paperclip agents run autonomously, but visibility into whether they're actually alive and doing useful work is limited. This plugin fills that gap:

- 📡 **Tracks heartbeat signals** from all enabled agents in real time
- 🧠 **Shared state file** — agents read/write a central decision output so you can see what's happening
- ⚠️ **Detects stalls and loops** — flags agents that haven't produced output within a configurable window
- 📊 **Dashboard surface** — exposes heartbeat status directly inside your Paperclip UI
- 🔌 **Subscription-usage aware** — integrates with cost/usage math so you're not flying blind on Claude credits

---

## Why This Exists

When you have 15+ agents running across multiple projects (WPR2, Government Watchdog, Mythos Writer, etc.), it's easy to miss when a key agent like the CEO or CTO has gone silent. This plugin makes that visible before it becomes a problem.

---

## Architecture

```
plugin/
├── src/
│   ├── manifest.ts        # Capabilities declaration
│   ├── worker.ts          # Heartbeat polling & state logic
│   └── ui/
│       └── index.tsx      # Dashboard UI surface
├── shared/
│   └── state.json         # Shared reader/writer for agent decision output
├── tests/
│   └── plugin.spec.ts
└── package.json
```

### Shared State File

The plugin reads and writes a shared `state.json` that acts as the central decision bus:

```json
{
  "agents": {
    "CEO": {
      "lastHeartbeat": "2026-06-14T20:45:00Z",
      "status": "active",
      "lastDecision": "Triaging WEI-3444 plan update",
      "runCount": 3
    },
    "CTO": {
      "lastHeartbeat": "2026-06-14T19:30:00Z",
      "status": "stalled",
      "lastDecision": "Waiting on WEI-3341 capacity confirmation",
      "runCount": 1
    }
  },
  "updatedAt": "2026-06-14T21:00:00Z"
}
```

---

## Installation

> **Requires:** Paperclip (self-hosted or cloud), Node.js 18+, pnpm

### From local path (development)

```bash
git clone https://github.com/xXKillerNoobYT/Paperclip-AI-Heartbeat-manger.git
cd Paperclip-AI-Heartbeat-manger
pnpm install
pnpm build
```

Install into Paperclip using an absolute local path via your Paperclip instance's plugin settings.

### From npm (coming soon)

```bash
# Not yet published — watch this repo for the npm release
```

---

## Configuration

After installing the plugin, configure it from the Paperclip plugin settings panel:

| Option | Default | Description |
|--------|---------|-------------|
| `heartbeatIntervalMs` | `60000` | How often to poll for heartbeat updates (ms) |
| `staleThresholdMs` | `300000` | Time before an agent is marked "stalled" (5 min) |
| `trackedAgents` | `["CEO", "CTO"]` | Which agents to monitor |
| `localStatePath` | `./shared/state.json` | Path to shared state file |
| `localhostPort` | `3100` | Local API port for heartbeat calls |

---

## Usage

Once installed, the plugin surfaces a **Heartbeat** panel in your Paperclip dashboard. From there you can:

- See live status of all tracked agents (`active` / `stalled` / `dead`)
- View the last decision each agent made
- Manually trigger a heartbeat check
- View subscription-usage cost stats per agent run

---

## Subscription Usage & Cost Tracking

This plugin integrates with the WEI-3605 subscription-usage math model to track:

- **Cost per agent run** (Claude credits consumed)
- **Run frequency** vs. configured budget window
- **Weekly credit projection** based on current run patterns

Pairs with [Paperclip](https://paperclip.ai) and your existing cost-tracking setup.

---

## Development

```bash
# Install deps
pnpm install

# Type check
pnpm typecheck

# Run tests
pnpm test

# Build
pnpm build
```

### Running locally with localhost API

The plugin can call a local API on port `3100` for heartbeat data. Start your local Paperclip server first:

```bash
# From your Paperclip repo
pnpm dev
```

Then the plugin will automatically attempt `http://localhost:3100/heartbeat` for live data.

---

## Roadmap

- [ ] Shared state file reader/writer (WEI implementation)
- [ ] Decision output surface in UI
- [ ] Subscription-usage math model integration (WEI-3605)
- [ ] npm package publish
- [ ] Alert/notification support (Slack, email)
- [ ] Multi-project heartbeat aggregation

---

## License

GPL-3.0 — see [LICENSE](./LICENSE)

---

## Author

Built by [@xXKillerNoobYT](https://github.com/xXKillerNoobYT) for the [Weirdtoo](https://weirdtoocompany.com) AI stack.
