#!/usr/bin/env python3
"""
PreToolUse hook: block messages and task completions that defer issues.

Applies to: send_message (content), complete_task (completionNote),
update_task (completionNote).

Blocked patterns indicate an orchestrator is trying to skip or defer
an issue instead of treating it. Priority = order, not filter.
"""
import json
import re
import sys


DEFER_PATTERNS = re.compile(
    r"en attente de priorit[eé]"
    r"|low priority,?\s*skip"
    r"|cosmetic,?\s*defer"
    r"|not blocking"
    r"|en attente de confirmation"
    r"|awaiting priority"
    r"|defer to next sprint"
    r"|pas urgent,?\s*(on|skip|later)"
    r"|skip for now"
    r"|low priority,?\s*defer"
    r"|not critical,?\s*skip",
    re.IGNORECASE,
)

TOOLS_TO_CHECK = {
    "mcp__vantage-memory__send_message": "content",
    "mcp__vantage-memory__complete_task": "completionNote",
    "mcp__vantage-memory__update_task": "completionNote",
}


def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    field = TOOLS_TO_CHECK.get(tool_name)
    if not field:
        print(json.dumps({"decision": "allow"}))
        return 0

    text = tool_input.get(field, "")
    if not text:
        print(json.dumps({"decision": "allow"}))
        return 0

    match = DEFER_PATTERNS.search(text)
    if match:
        print(json.dumps({
            "decision": "block",
            "reason": (
                f"BLOCKED: Detected defer pattern \"{match.group()}\". "
                "Toutes les issues se traitent. Priority = ordre dans la queue, "
                "pas filtre. Crée une mission IRP ou fixe le problème."
            ),
        }))
        return 0

    print(json.dumps({"decision": "allow"}))
    return 0


if __name__ == "__main__":
    main()
