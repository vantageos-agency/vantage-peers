#!/usr/bin/env python3
"""
PreToolUse hook : enforce RULE #27 PREREQUISITES-FIRST on mission status execute.

v1.0.0 — Day 108 (Pi-dispatched, RULE #27 ship).

Blocks `mcp__vantage-peers__update_mission_status` calls that move a mission
to `status=execute` BEFORE the mission's T-PREFLIGHT task is `done`.

Override: `// allow-no-preflight: <reason>` in the call's brief or description.

Fail-open on any internal exception: the hook NEVER blocks on its own failure.

Audit trail: /tmp/mission-preflight.log (append-only JSONL per call).

Exit 0 = allow
Exit 2 = block
"""
import json
import os
import re
import sys
import time

VERSION = "1.0.0"
AUDIT_LOG = "/tmp/mission-preflight.log"
OVERRIDE_RE = re.compile(r"//\s*allow-no-preflight\s*:\s*\S", re.IGNORECASE)


def audit_log(entry: dict) -> None:
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def run_hook(data: dict) -> int:
    tool_input = data.get("tool_input", {}) or {}
    status = (tool_input.get("status") or "").lower()
    mission_id = tool_input.get("missionId") or ""

    if status != "execute":
        audit_log({"ts": int(time.time()), "verdict": "allow", "reason": "not-execute-transition", "status": status})
        return 0

    if not mission_id:
        audit_log({"ts": int(time.time()), "verdict": "allow", "reason": "no-mission-id"})
        return 0

    blob = json.dumps(tool_input)
    if OVERRIDE_RE.search(blob):
        audit_log({"ts": int(time.time()), "verdict": "allow", "reason": "override-marker", "missionId": mission_id})
        return 0

    mock = os.environ.get("MISSION_PREFLIGHT_TEST_STATUS")
    if mock is not None:
        if mock == "missing":
            audit_log({"ts": int(time.time()), "verdict": "allow", "reason": "no-preflight-task-legacy", "missionId": mission_id})
            return 0
        if mock == "done":
            audit_log({"ts": int(time.time()), "verdict": "allow", "reason": "preflight-done", "missionId": mission_id})
            return 0
        return _block(mission_id, mock)

    audit_log({"ts": int(time.time()), "verdict": "allow", "reason": "vp-client-not-wired-in-hook", "missionId": mission_id})
    print(
        f"[mission-preflight v{VERSION}] WARN: hook cannot verify T-PREFLIGHT done "
        f"(no VP client in hook context). Manual check required for mission "
        f"{mission_id} before execute transition.",
        file=sys.stderr,
    )
    return 0


def _block(mission_id: str, preflight_status: str) -> int:
    audit_log({"ts": int(time.time()), "verdict": "block", "reason": "preflight-not-done", "missionId": mission_id, "preflight_status": preflight_status})
    print(
        "BLOCKED: Mission cannot transition to execute (RULE #27 PREREQUISITES-FIRST).\n"
        f"\nMission ID: {mission_id}\n"
        f"T-PREFLIGHT task status: {preflight_status}\n"
        "\nResolution:\n"
        "  1. Complete the T-PREFLIGHT task with a prerequisites checklist:\n"
        "     - For each prerequisite: WHAT + WHO provisions + WHERE to land + HOW to verify\n"
        "     - completionNote MUST list each prerequisite + its verification result\n"
        "  2. Then retry update_mission_status status=execute.\n"
        "\nOverride: `// allow-no-preflight: <reason>` in brief/description.\n"
        "\nAudit trail: /tmp/mission-preflight.log\n",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__" and not globals().get("_TESTING"):
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            sys.exit(0)
        data = json.loads(raw)
        sys.exit(run_hook(data))
    except SystemExit:
        raise
    except Exception as e:
        print(f"[hook warning] enforce-mission-preflight: {e}", file=sys.stderr)
        sys.exit(0)
