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
            "BLOCKED: Destructive operations are not allowed on production data.\n"
            "Use complete_task with a completionNote instead of delete_task.\n"
            "Close tasks, never delete them.",
            file=sys.stderr,
        )
        sys.exit(2)

except Exception:
    pass

sys.exit(0)
