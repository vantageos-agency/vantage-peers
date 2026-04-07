#!/usr/bin/env python3
"""VantagePeers session-start hook.

Injects startup instructions into every new Claude Code session.
Cleans up stale subagent flags from previous sessions.
"""

import json
import sys
import os
import time

# Clean up stale subagent flag: remove if it exists and is older than 10 minutes.
# A flag younger than 10 minutes may belong to an active subagent in the same session.
SUBAGENT_FLAG = "/tmp/.claude-subagent-active"
if os.path.exists(SUBAGENT_FLAG):
    try:
        flag_age = time.time() - os.path.getmtime(SUBAGENT_FLAG)
        if flag_age > 600:  # 10 minutes in seconds
            os.remove(SUBAGENT_FLAG)
    except OSError:
        pass


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
