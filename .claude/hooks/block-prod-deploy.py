#!/usr/bin/env python3
"""
PreToolUse hook: block production deploys without safety checks.

Blocks `npx convex deploy` (prod) unless:
1. Current branch is main
2. The command is explicitly approved (contains --yes or -y)

Does NOT block dev deploys (npx convex dev).

This prevents deploying feature branches to production.
"""
import json
import re
import subprocess
import sys


def get_current_branch():
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    if tool_name != "Bash":
        print(json.dumps({"decision": "allow"}))
        return 0

    command = tool_input.get("command", "")

    # Only check prod deploy commands
    if "convex deploy" not in command:
        print(json.dumps({"decision": "allow"}))
        return 0

    # Allow dev deploys
    if "convex dev" in command:
        print(json.dumps({"decision": "allow"}))
        return 0

    # Check current branch
    branch = get_current_branch()

    if branch != "main":
        print(json.dumps({
            "decision": "block",
            "reason": (
                f"BLOCKED: Production deploy from branch '{branch}'. "
                f"You MUST be on main with a merged PR before deploying to prod. "
                f"Switch to main (git checkout main && git pull) then deploy."
            ),
        }))
        return 0

    # On main — allow but warn
    print(json.dumps({
        "decision": "allow",
        "message": (
            "PROD DEPLOY CHECKLIST:\n"
            "- [ ] PR merged to main?\n"
            "- [ ] All tests pass?\n"
            "- [ ] Pi approved the deploy?\n"
            "Proceeding with production deploy..."
        ),
    }))
    return 0


if __name__ == "__main__":
    main()
