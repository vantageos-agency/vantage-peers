#!/usr/bin/env python3
"""
PreToolUse hook: enforce MCP tool registration mirrors Convex schema changes.

VantagePeers Cloud — Day 108 conformance (BU-specific).

RULE #24: Every new table or entity added to convex/schema.ts MUST have
a corresponding MCP tool registered in mcp-server/src/tools/ in the same
commit, OR carry an explicit skip justification in the commit message.

Root cause this addresses (mirrors eta-approval-hook-postmortem-2026-05-26.md
pattern of silent contract drift):
  VantagePeers Cloud exposes all data entities through MCP tools. When a
  developer adds a Convex table without wiring a corresponding MCP tool,
  the data entity becomes invisible to Claude.ai / ChatGPT / Claude Code /
  Codex and all IDE MCP clients. This schema-mirror gap compounds over time
  — discovered only when a client tool call returns "unknown tool".

  The eta-approval postmortem (2026-05-26) identified that silent drift
  between implementation layers is the root class of integration failures.
  This hook applies the same gate to the Convex→MCP surface.

Enforced on:
  - Bash tool calls where the command starts with `git commit`
  - Only when convex/schema.ts is among the staged files

Pass conditions (any one):
  - convex/schema.ts is not staged
  - At least one file under mcp-server/src/tools/ is staged in the same commit
  - Commit message contains override marker: // allow-schema-mirror-skip: <reason>

Exit codes:
  0 = allow
  2 = block with remediation message

Override (rare, one-shot — RULE #24, Day 108):
  Include `// allow-schema-mirror-skip: <reason>` in the commit message.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys

WORKSPACE = "/root/coding/vantage-memory"

# Schema file that triggers the MCP tool coverage check
SCHEMA_FILE = "convex/schema.ts"

# MCP tool registration path prefix
MCP_TOOLS_PREFIX = "mcp-server/src/tools/"

# Override marker — scan commit message flag (-m) for this string
OVERRIDE_RE = re.compile(
    r"//\s*allow-schema-mirror-skip\s*:\s*\S+",
    re.IGNORECASE,
)

STDERR_MSG = """\
BLOCKED: RULE #24 — MCP tool coverage must mirror Convex schema changes (Day 108).

Your commit modifies convex/schema.ts but no file under mcp-server/src/tools/
is staged in this commit.

RULE #24 (VantagePeers Cloud architecture doctrine):
  Every table/entity added to convex/schema.ts requires a corresponding
  MCP tool registration in mcp-server/src/tools/ in the SAME commit.

WHY THIS MATTERS:
  VantagePeers Cloud is a multi-client MCP platform (Claude.ai, ChatGPT,
  Claude Code, Codex, IDE clients). The MCP tool layer is the ONLY surface
  through which all clients access Convex data. An unregistered entity is
  invisible to every client simultaneously.

  Root class: silent contract drift between implementation layers —
  the same failure mode documented in the eta-approval postmortem
  (analysis/eta-approval-hook-postmortem-2026-05-26.md).

HOW TO FIX:
  Option A (preferred): Add or update a tool file in mcp-server/src/tools/
    1. Create/edit mcp-server/src/tools/<entity>.ts
    2. Register the tool in mcp-server/src/tools/index.ts
    3. Stage both files: git add mcp-server/src/tools/
    4. Retry the commit.

  Option B (schema refactor, no new entity exposed):
    Include this marker verbatim in your commit message -m argument:
      // allow-schema-mirror-skip: <reason>

    Example:
      git commit -m "refactor: rename internal field // allow-schema-mirror-skip: internal-field-only-no-new-entity"

    Use once, then add the MCP tool before the next deploy.

REFERENCE: RULE #24 — VantagePeers Cloud MCP surface doctrine (Day 108).
"""


def _has_override_in_command(command: str) -> bool:
    """Check for override marker in the commit message embedded in the command."""
    return bool(OVERRIDE_RE.search(command))


def _get_staged_files() -> list[str]:
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True,
            text=True,
            cwd=WORKSPACE,
            timeout=10,
        )
        if result.returncode == 0:
            return [f.strip() for f in result.stdout.splitlines() if f.strip()]
    except Exception:
        pass
    return []


def _schema_is_staged(staged: list[str]) -> bool:
    return SCHEMA_FILE in staged


def _mcp_tool_is_staged(staged: list[str]) -> bool:
    return any(f.startswith(MCP_TOOLS_PREFIX) for f in staged)


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        payload = json.loads(raw)
    except Exception:
        return 0

    try:
        tool_name = payload.get("tool_name") or payload.get("tool") or ""
        if tool_name != "Bash":
            return 0

        tool_input = payload.get("tool_input") or payload.get("input") or {}
        if not isinstance(tool_input, dict):
            return 0

        command = tool_input.get("command") or ""
        if not isinstance(command, str):
            return 0

        # Only fire on git commit commands
        if not re.match(r"\s*git\s+commit\b", command):
            return 0

        if _has_override_in_command(command):
            return 0

        staged = _get_staged_files()

        if not _schema_is_staged(staged):
            return 0

        if _mcp_tool_is_staged(staged):
            return 0

        sys.stderr.write(STDERR_MSG)
        sys.stderr.write(f"Schema file staged: {SCHEMA_FILE}\n")
        sys.stderr.write(
            f"MCP tool files staged (mcp-server/src/tools/*): none\n"
        )
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
