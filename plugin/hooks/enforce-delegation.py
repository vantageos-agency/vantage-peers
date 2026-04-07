#!/usr/bin/env python3
"""Enforce delegation for orchestrator.
Read: ALLOWED (subagents need it)
Grep on source code: ADVISORY warning
Write/Edit on source code: BLOCKED (must delegate to specialist agents)
"""
import json, sys


SOURCE_DIRS = ["convex/", "components/", "app/", "lib/", "hooks/", "services/",
               "contexts/", "stores/", "src/", "pages/", "utils/", "helpers/"]

# Files the orchestrator IS allowed to edit directly
ALLOWED_PATTERNS = [".claude/", "CLAUDE.md", "CLAUDE.local.md", "PROGRESS.md",
                    "package.json", ".env", "scripts/", "README.md", "/tmp/"]


def is_source_file(path: str) -> bool:
    if not path:
        return False
    if any(a in path for a in ALLOWED_PATTERNS):
        return False
    if any(d in path for d in SOURCE_DIRS):
        return True
    # Block .ts/.tsx/.js/.jsx files outside allowed dirs
    if path.endswith((".ts", ".tsx", ".js", ".jsx", ".py", ".css")):
        return True
    return False


def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    # Read: always allow (subagents need this)
    if tool_name == "Read":
        print(json.dumps({"decision": "allow"}))
        return 0

    # Write/Edit: BLOCK on source files
    if tool_name in ("Write", "Edit"):
        path = tool_input.get("file_path", "")
        if is_source_file(path):
            print(json.dumps({
                "decision": "block",
                "reason": (
                    f"BLOCKED: Orchestrators do not write source code directly. "
                    f"Delegate to a specialist agent (dev-convex-expert, dev-frontend, etc.) "
                    f"with run_in_background: true. File: {path}"
                ),
            }))
            return 0

    # Grep: advisory on source code
    if tool_name == "Grep":
        path = tool_input.get("path", "")
        if ".claude" in path or "/tmp" in path:
            print(json.dumps({"decision": "allow"}))
            return 0
        if any(d in path for d in SOURCE_DIRS) or path == "" or path == ".":
            print(json.dumps({
                "decision": "allow",
                "message": "REMINDER: You are an orchestrator. Consider delegating code investigation to a specialist agent."
            }))
            return 0

    print(json.dumps({"decision": "allow"}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
