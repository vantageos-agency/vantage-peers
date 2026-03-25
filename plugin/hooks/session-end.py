#!/usr/bin/env python3
"""VantagePeers session-end hook.

Ensures no session ends without updating state. Injects a prompt that
triggers the close-day routine. If the SessionEnd hook event is not
supported, the user can invoke /close-day manually as a fallback.

Configuration via environment variables:
  VM_ROLE       Agent role name (default: "agent")
  VM_INSTANCE   Instance identifier (default: "{role}-default")
"""

import json
import sys
import os
from datetime import date


def main():
    role = os.environ.get("VM_ROLE", "agent")
    instance = os.environ.get("VM_INSTANCE", f"{role}-default")
    today = date.today().isoformat()

    msg = (
        "SESSION END PROTOCOL (mandatory): "
        "1. Update any in_progress tasks with current status. "
        f"2. write_diary date='{today}', orchestrator='{role}' "
        "with session highlights. "
        f"3. store_memory namespace='orchestrator/{role}', type='project', "
        "content='Session summary: [what was done, what is pending, "
        "what to start next]'. "
        f"4. set_summary orchestratorId='{role}', instanceId='{instance}', "
        f"summary='Session closed -- {today}'. "
    )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionEnd",
            "additionalContext": f"[{instance} session end] {msg}",
        }
    }

    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
