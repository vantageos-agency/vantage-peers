#!/usr/bin/env python3
"""enforce-irp-sequence.py v4 — one in_progress task per orchestrator PER
DISTINCT `project` (repo/stream), read from REAL state.

PreToolUse hook on mcp__vantage-peers__start_task. Blocks starting a new task
only when the caller ALREADY has a different task in_progress in VantagePeers
IN THE SAME `project` as the task being started. Mirrors the server-side
relaxation in convex/tasks.ts `start` (Day 156,
mission vp-concurrent-active-tasks-per-stream-v1, T1): the source of truth is
the `by_assignee_project` index, `[assignedTo, project, status]`.

Project bounding v4 (Day 156, coordinator follow-up): the MCP `start_task`
tool_input carries only `taskId` + `callerOrchestrator` — never `project` —
and deliberately stays that way (no added MCP-server coupling). So the hook
SELF-DERIVES the started task's project from VP by looking the task up via
`taskId` (the same probe mechanism already used to read the caller's
in_progress tasks: injectable command for tests, VP HTTP query for real
traffic — see `probe_task_via_cmd`/`probe_task_via_http`). The conflict check
then bounds on that derived project, exactly as the server does: a task with
no `project` field (undefined) shares one "default" stream with every other
null-project task (still mutually exclusive there). If the started task's
project cannot be derived (VP/probe unreachable, or the probe genuinely fails)
the WHOLE hook fails open — this is not a narrower "unbounded fallback", it
is the same class of failure as the in-progress-list probe being unreachable,
and is announced identically on stderr.

The state of truth is the VP task table, never a local file. The previous
generation trusted a /tmp witness file consumed on every allowed start_task:
first start of a session always blocked, tasks moved to review never re-armed
it, any /tmp sweep erased it, and orchestrators with PRs in review could not
start anything (fix-task k17aj6nksfr573g1ad21k2ks9s8a9vj1).

FAIL-OPEN: when the state cannot be read (probe missing, VP unreachable), the
hook allows. A sequencing guard must not freeze the fleet when it cannot know.
Every fail-open SAYS SO on stderr: an unverified "no conflict" must never be
indistinguishable from a verified one.

Probe order (TWO independent probes, each with the same two-tier order):
  1. Caller's in_progress tasks — IRP_PROBE_CMD env (shell command printing a
     JSON list, or {"items"/"value": [...]}), else VP HTTP `tasks:list`.
  2. Started task's own doc (to derive its `project`) — IRP_TASK_PROBE_CMD env
     (shell command printing a JSON task object, or {"value": {...}}), else
     VP HTTP `tasks:get`.

Identity: callerOrchestrator in the tool input, else VP_ORCHESTRATOR env.
Never the hostname (the VPS is shared) and never a default role — an unknown
identity fails open and says so on stderr.

Escape hatches: IRP_BYPASS=1 (session) or `// allow-irp-skip: <reason>` inline.
Restarting the SAME task that is already in_progress is allowed (idempotent).

Exit 0 = allow. Exit 2 = block (only on a PROVEN conflict, blocking id named).
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

AUDIT_LOG = "/tmp/enforce-irp-sequence.log"
OVERRIDE_RE = re.compile(r"//\s*allow-irp-skip:\s*\S+", re.IGNORECASE)
VP_URL = os.environ.get("VP_CONVEX_URL", "https://compassionate-goldfinch-737.convex.cloud")
VP_TIMEOUT_SEC = 2.0


def audit(payload: dict) -> None:
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(payload) + "\n")
    except Exception:
        pass


def _normalize(body):
    """Accept a JSON list of tasks, or wrappers {"items": [...]}/{"value": ...}."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in ("items", "value"):
            inner = body.get(key)
            got = _normalize(inner)
            if got is not None:
                return got
    return None


def probe_via_cmd(cmd: str):
    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=5)
        if proc.returncode != 0:
            return None
        return _normalize(json.loads(proc.stdout))
    except Exception:
        return None


def probe_via_http(orchestrator: str):
    payload = json.dumps({
        "path": "tasks:list",
        "format": "json",
        "args": {"assignedTo": orchestrator, "status": "in_progress", "limit": 5},
    }).encode()
    req = urllib.request.Request(
        f"{VP_URL}/api/query", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=VP_TIMEOUT_SEC) as resp:
            return _normalize(json.loads(resp.read()))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None


def _extract_doc(body):
    """A single-task probe returns the task doc directly, or wrapped as
    {"value": {...}} (the shape of a real VP HTTP query response). Never
    unwraps a list — that would be the wrong probe's shape."""
    if isinstance(body, dict) and "value" in body and not isinstance(body["value"], list):
        return body["value"]
    if isinstance(body, dict):
        return body
    return None


def probe_task_via_cmd(cmd: str):
    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=5)
        if proc.returncode != 0:
            return None
        return _extract_doc(json.loads(proc.stdout))
    except Exception:
        return None


def probe_task_via_http(task_id: str):
    """Self-derives the started task's own doc (for its `project` field) by
    `taskId` — the same VP the caller's in_progress-list probe already
    reads. Never requires the MCP tool to forward `project`."""
    payload = json.dumps({
        "path": "tasks:get",
        "format": "json",
        "args": {"taskId": task_id},
    }).encode()
    req = urllib.request.Request(
        f"{VP_URL}/api/query", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=VP_TIMEOUT_SEC) as resp:
            return _extract_doc(json.loads(resp.read()))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None


def detect_orchestrator(tool_input: dict):
    """Return the caller's identity, or None when it cannot be established.

    Sources, in order: explicit callerOrchestrator in the tool input, then the
    workspace-level VP_ORCHESTRATOR env var. Hostname is NEVER used: the VPS is
    shared, so no hostname names an orchestrator, and a silent default that
    designates ANOTHER orchestrator's queue is worse than no guard.
    """
    caller = tool_input.get("callerOrchestrator")
    if caller:
        return str(caller).lower()
    env_orch = os.environ.get("VP_ORCHESTRATOR", "").strip().lower()
    return env_orch or None


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        try:
            data = json.loads(raw)
        except Exception:
            return 0
        if data.get("tool_name", "") != "mcp__vantage-peers__start_task":
            return 0
        tool_input = data.get("tool_input") or {}

        if os.environ.get("IRP_BYPASS") == "1":
            audit({"ts": int(time.time()), "verdict": "allow", "reason": "env-bypass"})
            return 0
        if OVERRIDE_RE.search(json.dumps(tool_input, ensure_ascii=False)):
            audit({"ts": int(time.time()), "verdict": "allow", "reason": "override-marker"})
            return 0

        orch = detect_orchestrator(tool_input)
        if orch is None:
            audit({"ts": int(time.time()), "verdict": "allow",
                   "reason": "identity-unknown-fail-open"})
            sys.stderr.write(
                "enforce-irp-sequence: caller identity unknown "
                "(no callerOrchestrator, no VP_ORCHESTRATOR) — allowing without check. "
                "Set VP_ORCHESTRATOR in the workspace env to arm this guard.\n"
            )
            return 0
        probe_cmd = os.environ.get("IRP_PROBE_CMD")
        tasks = probe_via_cmd(probe_cmd) if probe_cmd else probe_via_http(orch)

        if tasks is None:
            audit({"ts": int(time.time()), "verdict": "allow",
                   "reason": "state-unreadable-fail-open", "orchestrator": orch})
            sys.stderr.write(
                f"enforce-irp-sequence: task state unreadable for '{orch}' "
                f"(VP unreachable or probe failed) — allowing without check. "
                f"'No conflict' was NOT verified.\n"
            )
            return 0

        started_id = str(tool_input.get("taskId", ""))

        # Zero in_progress tasks at all → nothing can conflict, no need to
        # even derive the started task's project.
        if not tasks:
            audit({"ts": int(time.time()), "verdict": "allow",
                   "reason": "zero-conflicting-in-progress", "orchestrator": orch})
            return 0

        # Day 156 (coordinator follow-up) — self-derive the started task's
        # `project` from VP by `taskId`. The MCP tool_input never carries
        # `project` (by design, no added MCP-server coupling); this hook
        # looks the task up itself via the same probe mechanism it already
        # uses for the in_progress list.
        task_probe_cmd = os.environ.get("IRP_TASK_PROBE_CMD")
        target_task = (
            probe_task_via_cmd(task_probe_cmd) if task_probe_cmd
            else probe_task_via_http(started_id)
        )
        if target_task is None:
            audit({"ts": int(time.time()), "verdict": "allow",
                   "reason": "project-unreadable-fail-open", "orchestrator": orch,
                   "taskId": started_id})
            sys.stderr.write(
                f"enforce-irp-sequence: could not derive project for task "
                f"'{started_id}' (VP unreachable or probe failed) — allowing "
                f"without check. 'No conflict' was NOT verified.\n"
            )
            return 0
        # `project` absent on the started task's own doc → None, the shared
        # "default" stream — mirrors the server's null-project semantics
        # (convex/tasks.ts `start`).
        target_project = target_task.get("project")

        blocking = [
            t for t in tasks
            if isinstance(t, dict)
            and str(t.get("_id", "")) != started_id
            and t.get("project") == target_project
        ]
        if not blocking:
            audit({"ts": int(time.time()), "verdict": "allow",
                   "reason": "zero-conflicting-in-progress", "orchestrator": orch})
            return 0

        ids = ", ".join(str(t.get("_id", "?")) for t in blocking)
        audit({"ts": int(time.time()), "verdict": "block",
               "reason": "real-in-progress-conflict", "orchestrator": orch, "ids": ids})
        sys.stderr.write(
            f"BLOCKED: orchestrator '{orch}' already has in_progress task(s): {ids}. "
            f"Complete them (complete_task with completionNote) or move them "
            f"explicitly before starting a new one. "
            f"Escape hatches: IRP_BYPASS=1 for the session, or "
            f"`// allow-irp-skip: <reason>` in the tool input.\n"
        )
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
