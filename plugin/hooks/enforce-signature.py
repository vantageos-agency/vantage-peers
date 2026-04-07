#!/usr/bin/env python3
"""
PreToolUse hook on Bash: enforce orchestrator signature on all GitHub PRs and comments.

Every PR description and GitHub comment MUST end with:
  Orchestrator: <name> — <team> | YYYY-MM-DD

Blocks gh pr create, gh pr edit --body, gh pr comment, gh issue comment
if the body does not contain the signature pattern.
"""
import json
import re
import sys

SIGNATURE_PATTERN = re.compile(
    r"Orchestrator:\s+\w+\s+—\s+.+\s*\|\s*\d{4}-\d{2}-\d{2}"
)

GH_COMMANDS = [
    "gh pr create",
    "gh pr edit",
    "gh pr comment",
    "gh pr review",
    "gh issue comment",
]


def main():
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    if tool_name != "Bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")

    # Only check GitHub PR/comment commands
    if not any(gc in command for gc in GH_COMMANDS):
        sys.exit(0)

    # Extract body content from --body flag or heredoc
    body = ""
    body_match = re.search(r'--body\s+"([^"]*)"', command)
    if not body_match:
        body_match = re.search(r"--body\s+'([^']*)'", command)
    if not body_match:
        # Heredoc pattern: --body "$(cat <<'EOF' ... EOF )"
        body_match = re.search(r"<<'?EOF'?\n?(.*?)EOF", command, re.DOTALL)
    if body_match:
        body = body_match.group(1)

    if not body:
        # No body found — might be interactive or no --body flag
        sys.exit(0)

    if SIGNATURE_PATTERN.search(body):
        sys.exit(0)

    print(json.dumps({
        "decision": "block",
        "reason": (
            "BLOCKED: Missing orchestrator signature.\n"
            "Every PR and comment must end with:\n"
            "  Orchestrator: <name> — <team> | YYYY-MM-DD\n\n"
            "Example: Orchestrator: Pi — VantageOS Team | 2026-04-07"
        ),
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
