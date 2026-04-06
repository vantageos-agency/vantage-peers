#!/usr/bin/env python3
"""
PreToolUse hook: validate GitHub comments before posting.

Blocks comments that contain workarounds, code suggestions, or long
analysis without a PR link. A comment without a PR = not a fix.

Applies to: Bash commands containing "gh issue comment" or GitHub API comment calls.
"""
import json
import re
import sys


WORKAROUND_PATTERNS = re.compile(
    r"workaround|recommended fix|suggested fix|you can try|"
    r"as a temporary|quick fix would be|one approach|"
    r"you could|consider using|try changing|"
    r"here.s a fix|the fix is to",
    re.IGNORECASE,
)

# Code block pattern (triple backticks with code)
CODE_BLOCK = re.compile(r"```\w*\n.{50,}?```", re.DOTALL)


def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    if tool_name != "Bash":
        print(json.dumps({"decision": "allow"}))
        return 0

    command = tool_input.get("command", "")

    # Only check GitHub comment commands
    if "gh issue comment" not in command and "issues/comments" not in command:
        print(json.dumps({"decision": "allow"}))
        return 0

    # Check for workaround patterns
    if WORKAROUND_PATTERNS.search(command):
        print(json.dumps({
            "decision": "block",
            "reason": (
                "BLOCKED: This comment contains workarounds or fix suggestions. "
                "A comment is NOT a fix. Push the code yourself and link the PR. "
                "Acceptable formats: 'Investigating', 'Bug reproduced (PR #N)', "
                "'Fix ready (PR #N)', 'Fixed and deployed (PR #N)'."
            ),
        }))
        return 0

    # Check for long code blocks without PR link
    if CODE_BLOCK.search(command) and "PR" not in command and "pull/" not in command:
        print(json.dumps({
            "decision": "block",
            "reason": (
                "BLOCKED: This comment contains code suggestions without a PR link. "
                "Do not suggest code changes in comments — push the fix and link the PR."
            ),
        }))
        return 0

    print(json.dumps({"decision": "allow"}))
    return 0


if __name__ == "__main__":
    main()
