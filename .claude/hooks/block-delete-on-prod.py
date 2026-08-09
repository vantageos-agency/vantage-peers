#!/usr/bin/env python3
"""
PreToolUse hook: blocks destructive MCP operations on production data.

Targeted tools:
  - mcp__vantage-peers__delete_task
  - mcp__vantage-peers__delete_mission
  - mcp__vantage-peers__delete_message

Exit 0 = allow
Exit 2 = block
"""
import json
import sys

BLOCKED_TOOLS = {
    "mcp__vantage-peers__delete_task",
    "mcp__vantage-peers__delete_mission",
    "mcp__vantage-peers__delete_message",
}

try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")

    if tool_name in BLOCKED_TOOLS:
        print(
            "BLOCKED: destructive operations are not allowed on production data.\n"
            "This task or mission is not deletable — if it was created in error, "
            "cancel it instead: call update_task (or update_mission) with "
            "status='cancelled', callerOrchestrator=<the creator>, and a mandatory "
            "cancelReason explaining why. A cancelled row stays in the record, is "
            "excluded from open/active queues, and is never counted as done.\n"
            "Do not use complete_task to close it out — that would falsely mark "
            "erroneous work as done.",
            file=sys.stderr,
        )
        sys.exit(2)

except Exception:
    pass

sys.exit(0)
