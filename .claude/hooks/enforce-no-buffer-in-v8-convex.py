#!/usr/bin/env python3
"""
PreToolUse hook: reject commits that add Buffer usage to Convex V8 files.

VantagePeers Cloud — Day 116 recurrence guard (B-track CI grep).

Context:
  PR #1026 fixed Buffer.from/Buffer.byteLength in three files that lacked the
  "use node" directive (businessUnits.ts, githubRepoMapping.ts, components.ts).
  This hook prevents the same class of V8 runtime crash from recurring in future
  commits.

Rule:
  Any commit adding a line that matches \\bBuffer\\b in a convex/*.ts file
  (excluding _generated/, __tests__/, and comment-only lines) MUST either:
    (a) have "use node"; as the first non-blank line of that file, OR
    (b) be excluded via the override comment below.

Override (per-commit, rare):
  Append the line:
    // allow-buffer-in-v8: <reason>
  to the commit command. The hook will pass once and warn in stderr.

Triggered on:
  - Bash tool calls where the command starts with `git commit`

Files excluded from the check:
  - convex/_generated/**  (auto-generated)
  - convex/__tests__/**   (test harness, runs under vitest/edge-runtime, not V8)
"""

import json
import re
import subprocess
import sys

def main():
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = hook_input.get("tool_name", "")
    if tool_name != "Bash":
        sys.exit(0)

    tool_input = hook_input.get("tool_input", {})
    command = tool_input.get("command", "")

    if not command.strip().startswith("git commit"):
        sys.exit(0)

    # Allow override.
    if "// allow-buffer-in-v8:" in command:
        print(
            "[enforce-no-buffer-in-v8] override detected — skipping check (ensure reason is valid)",
            file=sys.stderr,
        )
        sys.exit(0)

    # Get the list of staged files in convex/*.ts that are NOT _generated or __tests__.
    try:
        staged_output = subprocess.check_output(
            ["git", "diff", "--cached", "--name-only"],
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except subprocess.CalledProcessError:
        sys.exit(0)

    staged_files = [
        f.strip()
        for f in staged_output.splitlines()
        if f.strip().startswith("convex/")
        and f.strip().endswith(".ts")
        and "_generated" not in f
        and "__tests__" not in f
    ]

    if not staged_files:
        sys.exit(0)

    violations = []

    for filepath in staged_files:
        # Get the full staged content of the file.
        try:
            content = subprocess.check_output(
                ["git", "show", f":{filepath}"],
                stderr=subprocess.DEVNULL,
                text=True,
            )
        except subprocess.CalledProcessError:
            # File deleted or not found in index — skip.
            continue

        lines = content.splitlines()

        # Check for "use node" directive (must be in first 3 non-blank lines).
        has_use_node = False
        checked = 0
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped in ('"use node";', "'use node';"):
                has_use_node = True
                break
            checked += 1
            if checked >= 3:
                break

        if has_use_node:
            continue  # File is Node-runtime — Buffer is fine.

        # Scan for Buffer usage in non-comment, non-variable-name lines.
        # We look for the word `Buffer` as a type or global call, not inside
        # variable names like `hashBuffer` or `sigBuffer` or `arrayBuffer`.
        buffer_pattern = re.compile(
            r"(?<!\w)Buffer(?:\.from|\.concat|\.byteLength|\.alloc|\b)"
        )
        # Exclude lines where Buffer is ONLY used as a variable name suffix.
        # "hashBuffer", "sigBuffer", "expBuf", etc. won't match the above regex.
        # Also skip pure comment lines.
        comment_pattern = re.compile(r"^\s*//")

        for lineno, line in enumerate(lines, 1):
            if comment_pattern.match(line):
                continue
            if buffer_pattern.search(line):
                violations.append(f"  {filepath}:{lineno}: {line.rstrip()}")

    if not violations:
        sys.exit(0)

    print(
        "[enforce-no-buffer-in-v8] BLOCKED: Buffer reference found in V8-runtime Convex file(s).\n"
        "Buffer is a Node.js global — it is undefined under the Convex V8 runtime.\n"
        "Fix: either add '\"use node\";' at the top of the file (actions only),\n"
        "or replace Buffer with a V8-safe equivalent (btoa/atob, TextEncoder, crypto.subtle).\n"
        "\nViolating lines:",
        file=sys.stderr,
    )
    for v in violations:
        print(v, file=sys.stderr)
    print(
        "\nTo override (rare, must document reason):\n"
        "  Append '// allow-buffer-in-v8: <reason>' to the commit command.",
        file=sys.stderr,
    )

    result = {"type": "block", "message": "[enforce-no-buffer-in-v8] Buffer in V8 Convex file — see stderr for details"}
    print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    main()
