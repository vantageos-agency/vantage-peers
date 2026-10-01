#!/usr/bin/env python3
"""
enforce-create-task-notify-followup.py

Hook PostToolUse for mcp__vantage-peers__create_task — tracks pending
notifications for urgent/high priority tasks. Hook PreToolUse for
mcp__vantage-peers__send_message — clears pending when channel matches
assignedTo.

Detection trigger: PreToolUse for next mcp__vantage-peers__create_task call
inspects /tmp/pi-pending-notifies.jsonl. If pending entries exist for >0 tasks
created previously this session with NO send_message follow-up to that assignee,
BLOCK new create_task with informative reminder.

Source: Laurent feedback Day 100 verbatim "putain tu oublies a chaque fois ca
saoule / Eta et toi etes les sources des frictions et blocages". Memory
j57f7wn5qwhb7nynjp7r57tnsx88ktt5.

Override: include `// allow-no-notify: <reason>` in description (rare).
"""

import json
import os
import re
import sys
import time
from pathlib import Path

STATE_FILE = Path("/tmp/pi-pending-notifies.jsonl")
URGENT_PRIORITIES = {"urgent", "high"}
OVERRIDE_RE = re.compile(r"//\s*allow-no-notify\s*:\s*\S+")


def load_state():
    if not STATE_FILE.exists():
        return []
    entries = []
    try:
        with STATE_FILE.open("r") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return entries


def save_state(entries):
    try:
        with STATE_FILE.open("w") as fh:
            for entry in entries:
                fh.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def handle_create_task_pre(tool_input):
    """PreToolUse on create_task: check if previous urgent/high pending notify exists."""
    entries = load_state()
    # Prune entries older than 10 min — long enough for this turn, short enough to expire stale state. // allow-time-estimate: TTL prune state
    cutoff = time.time() - 600
    fresh = [e for e in entries if e.get("ts", 0) >= cutoff]
    if len(fresh) != len(entries):
        save_state(fresh)
        entries = fresh

    if not entries:
        return

    description = (tool_input or {}).get("description", "") or ""
    if OVERRIDE_RE.search(description):
        return

    pending_assignees = sorted({e["assignedTo"] for e in entries if "assignedTo" in e})
    if not pending_assignees:
        return

    pending_list = ", ".join(pending_assignees)
    sys.stderr.write(
        "BLOCKED: previous create_task(s) urgent/high assigned to "
        f"[{pending_list}] still missing send_message follow-up.\n\n"
        "RULE #21 (Day 100 doctrine, memory j57f7wn5qwhb7nynjp7r57tnsx88ktt5):\n"
        "Every urgent/high dispatch must trigger send_message channel=<assignee>\n"
        "IN THE SAME TURN for immediate pickup (cron is a backstop, not the primary channel).\n\n"
        "Required action BEFORE the next create_task:\n"
        "  -> mcp__vantage-peers__send_message channel=<one-of-pending> "
        "referencing taskId + a one-line summary.\n\n"
        "Override (rare, batch dispatch with no urgency): add "
        "`// allow-no-notify: <reason>` in description.\n"
    )
    sys.exit(2)


def handle_create_task_post(tool_input, tool_response):
    """PostToolUse on create_task: track pending if urgent/high."""
    priority = (tool_input or {}).get("priority", "").lower()
    if priority not in URGENT_PRIORITIES:
        return
    description = (tool_input or {}).get("description", "") or ""
    if OVERRIDE_RE.search(description):
        return
    assigned_to = (tool_input or {}).get("assignedTo")
    if not assigned_to:
        return
    # Skip self-assigned tasks: notify-to-self is meaningless and creates untraceable entries.
    created_by = (tool_input or {}).get("createdBy")
    if created_by and created_by == assigned_to:
        return
    task_id = None
    if isinstance(tool_response, dict):
        task_id = tool_response.get("taskId") or tool_response.get("_id")
    entries = load_state()
    entries.append(
        {
            "taskId": task_id,
            "assignedTo": assigned_to,
            "priority": priority,
            "ts": time.time(),
        }
    )
    save_state(entries)


def handle_send_message_pre(tool_input):
    """PreToolUse on send_message: clear matching pending entries.

    Recognizes BOTH `channel` (legacy) and `recipient` (dispatch-message v2 grid).
    """
    targets = set()
    # Check broadcast first
    if (tool_input or {}).get("broadcast"):
        targets.add("broadcast")
    # Check recipient field (v2 grid skill)
    recipient = (tool_input or {}).get("recipient", "") or ""
    if recipient:
        targets.add(recipient.split("-")[0])
    # Check channel field (legacy + multi-recipient comma list)
    channel = (tool_input or {}).get("channel", "") or ""
    for part in channel.split(","):
        part = part.strip()
        if not part:
            continue
        if part == "broadcast":
            targets.add("broadcast")
            continue
        targets.add(part.split("-")[0])
    if not targets:
        return
    entries = load_state()
    if not entries:
        return
    if "broadcast" in targets:
        save_state([])
        return
    remaining = [e for e in entries if e.get("assignedTo") not in targets]
    if len(remaining) != len(entries):
        save_state(remaining)


def handle_complete_task_pre(tool_input):
    """PreToolUse on complete_task: clear pending entry for the completed task.

    A task can be completed by its assignee (autonomous) or by Pi/orchestrator
    (manual close). Either way, completion = no more pending notify needed.
    """
    task_id = (tool_input or {}).get("taskId")
    if not task_id:
        return
    entries = load_state()
    if not entries:
        return
    remaining = [e for e in entries if e.get("taskId") != task_id]
    if len(remaining) != len(entries):
        save_state(remaining)


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = payload.get("tool_name", "")
    hook_event = payload.get("hook_event_name", "")
    tool_input = payload.get("tool_input", {}) or {}
    tool_response = payload.get("tool_response", {}) or {}

    if tool_name == "mcp__vantage-peers__create_task":
        if hook_event == "PreToolUse":
            handle_create_task_pre(tool_input)
        elif hook_event == "PostToolUse":
            handle_create_task_post(tool_input, tool_response)
    elif tool_name == "mcp__vantage-peers__send_message":
        if hook_event == "PreToolUse":
            handle_send_message_pre(tool_input)
    elif tool_name == "mcp__vantage-peers__complete_task":
        if hook_event == "PreToolUse":
            handle_complete_task_pre(tool_input)

    sys.exit(0)


if __name__ == "__main__":
    main()
