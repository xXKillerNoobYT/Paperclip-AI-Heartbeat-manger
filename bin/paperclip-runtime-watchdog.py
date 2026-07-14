#!/usr/bin/env python3
"""Paperclip runtime watchdog — auto-applies provably-safe repairs.

Runs from a LaunchAgent every 10 minutes against the local Paperclip
instance (local_trusted). It fixes exactly two known failure classes and
nothing else:

1. Agents stuck in status=error whose errorReason matches a known-fixed
   crash signature (hermes rich MarkupError, workspace branch
   incoherence, stale git config.lock). Cleared at most once per
   agent+signature per RECLEAR_COOLDOWN so a genuinely recurring crash
   escalates to a human instead of looping.

2. Execution-workspace records whose recorded branchName is stale after
   a chain leg moved the shared worktree forward. Repaired only when the
   worktree is CLEAN, the recorded branch is an ANCESTOR of the
   checked-out branch, and the checked-out branch matches git's own
   registration — the provably-lossless case Paperclip <=2026.707.0
   refuses to auto-repair. The repair is a PATCH to the workspace
   record; the worktree files are never touched.

State: ~/.paperclip-watchdog/state.json   Log: ~/.paperclip-watchdog/watchdog.log
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

API = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100/api")
SERVER_LOG = os.path.expanduser(
    "~/.paperclip/instances/default/logs/server.log"
)
HOME = os.path.expanduser("~/.paperclip-watchdog")
STATE_PATH = os.path.join(HOME, "state.json")
LOG_PATH = os.path.join(HOME, "watchdog.log")
RECLEAR_COOLDOWN = 6 * 3600
MAX_ACTIONS_PER_RUN = 5
LOG_TAIL_BYTES = 2_000_000

KNOWN_FIXED_SIGNATURES = {
    "hermes-markup": re.compile(r"rich\.errors\.MarkupError"),
    "branch-incoherence": re.compile(
        r"git_worktree_branch_incoherence|Execution workspace git worktree expected branch"
    ),
    "config-lock": re.compile(r"could not lock config file .*config: File exists"),
}

INCOHERENCE_EVIDENCE = re.compile(
    r'"executionWorkspaceId":\s*"(?P<wsid>[0-9a-f-]{36})"[\s\S]{0,2000}?'
    r'"worktreePath":\s*"(?P<path>[^"]+)"[\s\S]{0,2000}?'
    r'"expectedBranch":\s*"(?P<expected>[^"]+)"[\s\S]{0,500}?'
    r'"actualBranch":\s*"(?P<actual>[^"]+)"'
)


def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    with open(LOG_PATH, "a") as f:
        f.write(line + "\n")


def api(method, path, body=None):
    req = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {"cleared": {}, "reconciled": {}}


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE_PATH)


def git(worktree, *args):
    out = subprocess.run(
        ["git", "-C", worktree, *args], capture_output=True, text=True, timeout=30
    )
    return out.returncode, out.stdout.strip()


def clear_stuck_agents(state, budget):
    actions = 0
    for company in api("GET", "/companies"):
        cid = company["id"]
        for agent in api("GET", f"/companies/{cid}/agents"):
            if actions >= budget:
                return actions
            if agent.get("status") != "error":
                continue
            reason = agent.get("errorReason") or ""
            sig = next(
                (name for name, rx in KNOWN_FIXED_SIGNATURES.items() if rx.search(reason)),
                None,
            )
            if sig is None:
                log(f"SKIP agent {agent['name']} ({cid[:8]}): unrecognized error signature")
                continue
            key = f"{agent['id']}:{sig}"
            last = state["cleared"].get(key, 0)
            if time.time() - last < RECLEAR_COOLDOWN:
                log(
                    f"HOLD agent {agent['name']} ({cid[:8]}): '{sig}' recurred within "
                    f"cooldown — leaving in error for human review"
                )
                continue
            api("POST", f"/agents/{agent['id']}/clear-error?companyId={cid}", {})
            state["cleared"][key] = time.time()
            actions += 1
            log(f"FIXED agent {agent['name']} ({cid[:8]}): cleared '{sig}' error")
    return actions


def recent_incoherence_evidence():
    try:
        size = os.path.getsize(SERVER_LOG)
        with open(SERVER_LOG, "rb") as f:
            f.seek(max(0, size - LOG_TAIL_BYTES))
            text = f.read().decode("utf-8", errors="replace")
    except OSError:
        return {}
    found = {}
    for m in INCOHERENCE_EVIDENCE.finditer(text):
        found[m.group("wsid")] = m.groupdict()  # last occurrence wins
    return found


def reconcile_workspaces(state, budget):
    actions = 0
    for wsid, ev in recent_incoherence_evidence().items():
        if actions >= budget:
            break
        try:
            ws = api("GET", f"/execution-workspaces/{wsid}")
        except urllib.error.HTTPError:
            continue
        record = ws.get("workspace") or ws
        if record.get("branchName") != ev["expected"]:
            continue  # record already updated by someone else
        worktree = ev["path"]
        if not os.path.isdir(worktree):
            continue
        rc, head = git(worktree, "symbolic-ref", "--quiet", "--short", "HEAD")
        if rc != 0 or head != ev["actual"]:
            continue  # worktree moved again; evidence stale
        rc, dirt = git(worktree, "status", "--porcelain", "--untracked-files=all")
        if rc != 0 or dirt:
            log(f"HOLD workspace {wsid[:8]}: worktree dirty — not touching")
            continue
        rc, _ = git(worktree, "merge-base", "--is-ancestor", ev["expected"], "HEAD")
        if rc != 0:
            log(f"HOLD workspace {wsid[:8]}: '{ev['expected'][:40]}' not ancestor of HEAD")
            continue
        api("PATCH", f"/execution-workspaces/{wsid}", {"branchName": ev["actual"]})
        state["reconciled"][wsid] = time.time()
        actions += 1
        log(
            f"FIXED workspace {wsid[:8]}: branchName '{ev['expected'][:40]}' -> "
            f"'{ev['actual'][:40]}' (clean worktree, ancestor-verified)"
        )
    return actions


def main():
    os.makedirs(HOME, exist_ok=True)
    try:
        health = api("GET", "/health")
        if health.get("status") != "ok":
            log(f"server unhealthy ({health.get('status')}); no action")
            return 0
    except Exception as exc:
        log(f"server unreachable ({exc}); no action")
        return 0
    state = load_state()
    n = clear_stuck_agents(state, MAX_ACTIONS_PER_RUN)
    n += reconcile_workspaces(state, MAX_ACTIONS_PER_RUN - n)
    save_state(state)
    if n == 0:
        log("healthy — no repairs needed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
