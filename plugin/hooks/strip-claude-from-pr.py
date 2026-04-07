#!/usr/bin/env python3
"""
PreToolUse hook: strip "Generated with Claude Code" and robot emoji
from gh pr create commands.

Matches Bash commands containing "gh pr create".
Rewrites the command to remove offending lines from the --body argument.
"""
import json
import re
import sys


def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    if tool_name != "Bash":
        print(json.dumps({"decision": "allow"}))
        return 0

    command = tool_input.get("command", "")

    if "gh pr create" not in command:
        print(json.dumps({"decision": "allow"}))
        return 0

    # Strip Claude Code branding patterns from the command
    original = command
    # Remove lines containing "Generated with Claude Code" or robot emoji
    command = re.sub(r'[^\n]*🤖[^\n]*Generated with[^\n]*\n?', '', command)
    command = re.sub(r'[^\n]*Generated with \[Claude Code\][^\n]*\n?', '', command)
    command = re.sub(r'[^\n]*Generated with Claude Code[^\n]*\n?', '', command)
    # Also catch the markdown link format
    command = re.sub(r'[^\n]*\[Claude Code\]\(https://claude\.com/claude-code\)[^\n]*\n?', '', command)

    if command != original:
        print(json.dumps({
            "decision": "allow",
            "toolInput": {"command": command},
        }))
    else:
        print(json.dumps({"decision": "allow"}))

    return 0


if __name__ == "__main__":
    main()
