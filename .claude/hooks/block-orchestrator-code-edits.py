#!/usr/bin/env python3
"""
Universal orchestrator hook — deploy to EVERY orchestrator (Pi, Tau, Phi, etc.)
PreToolUse on Edit/Write: Orchestrators delegate. They never write code.

Allowed:
- .md / .mdx files in context, knowledge, memory, templates, resources, diary, etc.
- ALL files in .claude/ (settings, hooks, skills, rules = infrastructure)
- /tmp
Blocked: everything else (code files, components, etc.)

Exit 0 = allow
Exit 2 = block
"""
import json
import sys
import os

# Paths where orchestrators ARE allowed to edit .md files only
ALLOWED_MD_DIRS = [
    "context/",
    "knowledge/",
    "memory/",
    "templates/",
    "resources/",
    "diary/",
    "decisions/",
    "analysis/",
    "playbooks/",
    "docs/",
    "",  # root-level .md files (CHANGELOG.md, README.md, etc.)
]

# Paths where ALL file types are allowed (infrastructure, not code)
ALLOWED_ALL_DIRS = [
    ".claude/",
]

# Repos Pi manages directly (no dedicated orchestrator) — all edits allowed
PI_MANAGED_REPOS = [
    "/home/laurentperello/coding/vantage-studio/",
]

# Flag file set by enforce-brief-template.py when a subagent is launched
SUBAGENT_FLAG = "/tmp/.claude-subagent-active"

try:
    data = json.load(sys.stdin)
    file_path = data.get("tool_input", {}).get("file_path", "")

    # If a subagent is active (flag exists), allow edits — the agent was properly delegated
    if os.path.exists(SUBAGENT_FLAG):
        sys.exit(0)

    if not file_path:
        sys.exit(0)

    # Always allow /tmp
    if file_path.startswith("/tmp"):
        sys.exit(0)

    # Allow all edits in repos Pi manages directly (no orchestrator)
    for repo in PI_MANAGED_REPOS:
        if file_path.startswith(repo):
            sys.exit(0)

    # Allow all files in infrastructure dirs (.claude/)
    for allowed_dir in ALLOWED_ALL_DIRS:
        if ("/" + allowed_dir) in file_path:
            sys.exit(0)

    # Allow .md / .mdx content files in allowed directories
    # (.mdx = markdown content, e.g. diary entries — authored content, not code)
    if file_path.endswith((".md", ".mdx")):
        for allowed_dir in ALLOWED_MD_DIRS:
            if ("/" + allowed_dir) in file_path:
                sys.exit(0)

    # Block everything else
    basename = os.path.basename(file_path)
    print(
        f"BLOCKED: Orchestrators do not write code. You tried to edit: {basename}\n"
        f"Full path: {file_path}\n\n"
        f"Follow the orchestration protocol:\n"
        f"1. Read LIBRARY-INDEX.md → find the right specialized agent\n"
        f"2. Find the correct brief template (resources/templates/brief-ui.md or brief-backend.md)\n"
        f"3. Fill the template with exact file:line:change instructions\n"
        f"4. Delegate to the agent or send via claude-peers\n",
        file=sys.stderr,
    )
    sys.exit(2)

except Exception:
    sys.exit(0)
