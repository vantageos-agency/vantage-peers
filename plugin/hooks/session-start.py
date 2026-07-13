#!/usr/bin/env python3
"""
Generic SessionStart hook — detects the workspace from a LOCAL, non-published
mapping file and emits the orchestrator identity prompt.

Day 130 rewrite: the previous canonical embedded the workspace->identity map
in this file — including client names, a real person's name, and internal
host paths — while the hook ships inside a PUBLIC plugin package. Identity
data is DERIVED from local config now; nothing identifying is ever packaged.

Mapping file (first found wins):
  1. $VANTAGE_WORKSPACE_MAP (explicit path)
  2. ~/.config/vantageos/workspace-map.json
  3. /root/.config/vantageos/workspace-map.json

Format: { "<workspace-path>": ["role", "instance", "friendly-name", "namespace"], ... }

The mapping file lives on the host, outside every git repo and every package.
A missing or unreadable map degrades LOUDLY to the neutral prompt — never a
silent wrong identity.
"""

import json
import os
import sys

MAP_CANDIDATES = [
    os.environ.get("VANTAGE_WORKSPACE_MAP") or "",
    os.path.expanduser("~/.config/vantageos/workspace-map.json"),
    "/root/.config/vantageos/workspace-map.json",
]


def load_map():
    """Return (mapping, source_path) or (None, reason)."""
    for path in MAP_CANDIDATES:
        if not path:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data, path
            return None, f"map at {path} is not a JSON object"
        except FileNotFoundError:
            continue
        except Exception as exc:  # unreadable / invalid JSON — say so, loudly
            return None, f"map at {path} unreadable: {exc}"
    return None, "no workspace map found (VANTAGE_WORKSPACE_MAP / ~/.config/vantageos/workspace-map.json)"


def detect_workspace(mapping):
    """Return [role, instance, name, namespace] for current workspace, or None."""
    cwd = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    if cwd in mapping:
        return mapping[cwd]
    for path, info in mapping.items():
        if cwd == path or cwd.startswith(path.rstrip("/") + "/"):
            return info
    return None


def neutral(reason):
    prompt = (
        "[Session start] Workspace identity not resolved "
        f"({reason}). Identify your role via this workspace's CLAUDE.md. "
        "If CLAUDE.md is absent or ambiguous, ask the operator."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": prompt
        }
    }))
    return 0


def main():
    mapping, source = load_map()
    if mapping is None:
        return neutral(source)

    detected = detect_workspace(mapping)
    if detected is None or len(detected) != 4:
        return neutral(f"no entry for this path in {source}")

    role, instance, friendly, namespace = detected

    msg = (
        f"You are {friendly}, on {instance}. "
        f"STARTUP SEQUENCE (do all immediately): "
        f"1. Call set_summary with orchestratorId='{role}', instanceId='{instance}', summary='Session started'. "
        f"2. Call check_messages with recipient='{role}', recipientInstanceId='{instance}'. "
        f"3. Call list_tasks with assignedTo='{role}', status='todo'. "
        f"4. Call recall with query='priorities pending blockers feedback rules', namespace='global', limit=10. "
        f"5. Call recall with query='current status pending decisions', namespace='{namespace}', limit=5. "
        f"6. Call recall with query='briefing mission initial', namespace='orchestrator/{role}', limit=5. "
        f"7. STALE TASK CHECK: Call list_tasks with assignedTo='{role}', status='in_progress'. For each task actually done, call complete_task IMMEDIATELY with completionNote. "
        f"Read CLAUDE.md of this workspace for scope + doctrine + memory protocol. "
        f"Use recalled context to inform your session."
    )

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": f"[{role} session start] {msg}"
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
