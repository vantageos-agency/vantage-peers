#!/usr/bin/env python3
"""
Block git checkout -b (new branch creation) unless git pull upstream main
was run within the last 5 minutes.

Prevents branching from stale main, which causes merge conflicts.
"""
import json
import os
import re
import subprocess
import sys
import time


def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    if tool_name != "Bash":
        print(json.dumps({"decision": "allow"}))
        return 0

    command = tool_input.get("command", "")

    # Only check git checkout -b (new branch creation)
    if not re.search(r"git\s+checkout\s+-b\b", command):
        print(json.dumps({"decision": "allow"}))
        return 0

    # Check when the last git pull upstream was done
    # Look at the fetch timestamp for upstream
    try:
        # Get the FETCH_HEAD modification time (updated on git pull/fetch)
        cwd = tool_input.get("cwd", os.getcwd())
        fetch_head = os.path.join(cwd, ".git", "FETCH_HEAD")

        if not os.path.exists(fetch_head):
            # Also check the repo root
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                fetch_head = os.path.join(result.stdout.strip(), ".git", "FETCH_HEAD")

        if os.path.exists(fetch_head):
            mtime = os.path.getmtime(fetch_head)
            age_minutes = (time.time() - mtime) / 60

            if age_minutes <= 5:
                print(json.dumps({"decision": "allow"}))
                return 0

        # FETCH_HEAD is stale or missing
        print(json.dumps({
            "decision": "block",
            "reason": (
                "BLOCKED: Run `git pull upstream main` (or `git fetch upstream`) "
                "before creating a new branch. This prevents branching from stale "
                "main and avoids merge conflicts."
            ),
        }))
        return 0

    except Exception:
        # On error, allow (don't block work on edge cases)
        print(json.dumps({"decision": "allow"}))
        return 0


if __name__ == "__main__":
    main()
