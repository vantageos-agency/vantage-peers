#!/usr/bin/env python3
"""
PostToolUse hook: after a successful git push to upstream,
remind the orchestrator to create a PR.
"""
import json
import re
import sys


def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})
    tool_result = input_data.get("tool_result", {})

    if tool_name != "Bash":
        return 0

    command = tool_input.get("command", "")

    # Only trigger on git push to upstream
    if not re.search(r"git\s+push\s+upstream\b", command):
        return 0

    # Check if push succeeded (no error in result)
    stdout = tool_result.get("stdout", "")
    stderr = tool_result.get("stderr", "")
    if "error" in stderr.lower() or "rejected" in stderr.lower():
        return 0

    # Extract branch name from command
    branch_match = re.search(r"git\s+push\s+upstream\s+(\S+)", command)
    branch = branch_match.group(1) if branch_match else "HEAD"

    print(json.dumps({
        "decision": "allow",
        "message": (
            f"Push to upstream successful. "
            f"CREATE A PR NOW: gh pr create --repo [repo] --base main "
            f"--head {branch} --title '...' --body '...'"
        ),
    }))
    return 0


if __name__ == "__main__":
    main()
