#!/usr/bin/env python3
"""VantagePeers session-start hook.

Injects startup instructions into every new Claude Code session.
The hook itself does not call MCP tools -- it outputs a JSON prompt
that instructs the main agent to perform the startup sequence.

Configuration via environment variables:
  VM_ROLE       Agent role name (default: "agent")
  VM_INSTANCE   Instance identifier (default: "{role}-default")
  VM_PROJECT    Default project namespace for recall (default: "")
"""

import json
import sys
import os


def main():
    role = os.environ.get("VM_ROLE", "agent")
    instance = os.environ.get("VM_INSTANCE", f"{role}-default")
    project = os.environ.get("VM_PROJECT", "")

    recall_ns = f"project/{project}" if project else "global"

    msg = (
        f"You are {role}, running as {instance}. "
        "STARTUP SEQUENCE (execute silently, do not narrate): "
        f"1. set_summary orchestratorId='{role}', instanceId='{instance}', "
        f"summary='Session started'. "
        f"2. check_messages recipient='{role}', "
        f"recipientInstanceId='{instance}'. "
        "3. Run /check-tasks. "
        f"4. recall query='priorities pending blockers', "
        f"namespace='{recall_ns}', limit=5. "
        "5. Start working on your highest-priority unblocked task immediately. "
    )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": f"[{instance} session start] {msg}",
        }
    }

    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
