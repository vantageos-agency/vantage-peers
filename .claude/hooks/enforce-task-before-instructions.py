#!/usr/bin/env python3
"""
Block send_message when content contains work instructions without a task.

Messages should notify, not instruct. If the message contains action verbs
and is >100 chars, block it and require a create_task first.

Allow: short notifications, status reports, acknowledgments.
Block: detailed work instructions that should be tasks.
"""
import json
import re
import sys


ACTION_VERBS = re.compile(
    r"\b(fix|build|deploy|write|create|update|implement|add|remove|migrate|"
    r"test|review|check|verify|launch|run|install|configure|setup|refactor|"
    r"delete|move|rename|merge|push|pull|fetch|clone|seed|audit)\b",
    re.IGNORECASE,
)

REPORT_PATTERNS = re.compile(
    r"\b(done|termin[eé]|rapport|r[eé]sultat|PASS|FAIL|complete|fini|"
    r"pushed|deployed|committed|merged|created|reported|acknowledged)\b",
    re.IGNORECASE,
)

MIN_LENGTH_FOR_CHECK = 100


def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    if tool_name != "mcp__vantage-memory__send_message":
        print(json.dumps({"decision": "allow"}))
        return 0

    content = tool_input.get("content", "")

    # Short messages always allowed
    if len(content) < MIN_LENGTH_FOR_CHECK:
        print(json.dumps({"decision": "allow"}))
        return 0

    # Reports/status always allowed
    if REPORT_PATTERNS.search(content):
        print(json.dumps({"decision": "allow"}))
        return 0

    # Count action verbs
    verb_matches = ACTION_VERBS.findall(content)
    if len(verb_matches) >= 3:
        print(json.dumps({
            "decision": "block",
            "reason": (
                f"BLOCKED: This message contains {len(verb_matches)} work instructions "
                f"({', '.join(verb_matches[:5])}). Create a TASK (create_task) first, "
                "then send a short notification message. Messages notify, tasks instruct."
            ),
        }))
        return 0

    print(json.dumps({"decision": "allow"}))
    return 0


if __name__ == "__main__":
    main()
