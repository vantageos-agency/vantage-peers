#!/usr/bin/env python3
# // allow-no-verify: hook-source-documentation
"""
PreToolUse hook: enforces Pi-self verify-before-dispatch (Day 114).

Pi must NEVER dispatch a task whose brief cites a repo / file / version /
state / config / package / deploy / tool surface without having VERIFIED
that claim with a tool call FIRST. The brief must be grounded in
observation, not in assumption.

Trigger memory: feedback memory j5796zx4pzg3sq2sc4dgb6d4qh89fzqc.
Day 114 verbatim Laurent: "j'en ai assez que tu délègues sans jamais
rien vérifier avvant putain on perd du temps et on risque des damage!!!"

Three recurrences in the same session that motivated this hook:
  - Kappa mission brief assumed @vantageos/mosaic-blocks@0.2.0-alpha
    installed when actually 0.1.0-alpha.1 (T1 PREREQUISITES caught).
  - Sigma vantage-peers refonte mission brief assumed workspace state
    without checking actual repo + branches.
  - Omega Railway redeploy task brief assumed Railway server = npm
    wrapper when actually = autonomous codebase (Omega had to stop
    and explain).

Enforced on:
  - mcp__vantage-peers__create_task (when createdBy == "pi")

A description PASSES when it contains a line matching:
  ^\\s*VERIFIED:\\s*<value>     // allow-no-verify: hook-source-documentation
where <value> is at least one non-whitespace char. The line declares
what Pi verified before authoring the brief. Examples of what to
cite: command + extract of output, file path + line, npm view result,
gh pr view output, ssh ls / cat, ToolSearch match.

Opt-out (rare, one-shot — hot-fix or genuinely unverifiable scope):
  // allow-no-verify: <reason>
in the description. Reason >= 3 chars. After override, fix the root
cause: either find a verification path, or document the gap.

Scope: only fires when createdBy == "pi". Other orchestrators are
not gated by this hook — they own their BU and dispatch from within
their own workspace where the terrain is by construction visible.

Fail-open on malformed JSON / internal errors.
"""

from __future__ import annotations

import json
import re
import sys

MATCHED_TOOLS = {"mcp__vantage-peers__create_task"}

# Verified declaration: `VERIFIED:` at start of line, with non-empty value
VERIFIED_LINE_RE = re.compile(  # // allow-no-verify: hook-source-documentation
    r"^\s*VERIFIED:\s*\S",  # // allow-no-verify: hook-source-documentation
    re.IGNORECASE | re.MULTILINE,
)

# Override marker
OVERRIDE_RE = re.compile(  # // allow-no-verify: hook-source-documentation
    r"//\s*allow-no-verify\s*:\s*\S{3,}",  # // allow-no-verify: hook-source-documentation
    re.IGNORECASE,
)


STDERR_MSG = (
    "BLOCKED: Pi verify-before-dispatch enforcement (Day 114).\n"
    "\n"
    "create_task description is missing the mandatory VERIFIED: block.\n"
    "\n"
    "Trigger: feedback memory j5796zx4pzg3sq2sc4dgb6d4qh89fzqc.\n"
    "Day 114 verbatim Laurent: \"j'en ai assez que tu délègues sans\n"
    "jamais rien vérifier avvant putain on perd du temps et on risque\n"
    "des damage!!!\"\n"
    "\n"
    "Before dispatching ANY task that cites a repo / file / version /\n"
    "state / config / package / deploy / tool surface, Pi MUST first\n"
    "verify that claim with a tool call (Read, Bash, grep, ToolSearch,\n"
    "mcp__*, npm view, gh, ssh) and cite the output in a VERIFIED: block.\n"
    "\n"
    "FIX: add a block to the description of the form:\n"
    "  VERIFIED:\n"  # // allow-no-verify: hook-source-documentation
    "  - <command 1> -> <output extract>\n"
    "  - <command 2> -> <output extract>\n"
    "\n"
    "Examples:\n"
    "  VERIFIED: gh pr view 242 -R elpiarthera/vantage-registry --json mergeStateStatus -> CLEAN\n"  # // allow-no-verify: hook-source-documentation
    "  VERIFIED: ssh root@code.vantageos.agency 'cat /root/coding/X/package.json' -> version 0.1.0-alpha.1\n"  # // allow-no-verify: hook-source-documentation
    "  VERIFIED: ToolSearch select:mcp__vantage-registry__upsert_rule_content -> No matching deferred tools found\n"  # // allow-no-verify: hook-source-documentation
    "  VERIFIED: npm view @vantageos/mosaic-tokens version -> 0.2.1\n"  # // allow-no-verify: hook-source-documentation
    "\n"
    "The discipline is the DECLARATION + the cited tool-call evidence.\n"
    "A brief grounded in assumption ('I think it's like X') propagates\n"
    "the assumption into the assignee's wasted work.\n"
    "\n"
    "Override (rare, one-shot — hot-fix or scope genuinely unverifiable):\n"
    "  add `// allow-no-verify: <reason>` in the description.\n"
    "Reason >= 3 chars. After override, fix the root cause: either\n"
    "find a verification path, or document the gap.\n"
)


def _has_verified_line(text: str) -> bool:
    if not text:
        return False
    return bool(VERIFIED_LINE_RE.search(text))


def _has_override(text: str) -> bool:
    if not text:
        return False
    return bool(OVERRIDE_RE.search(text))


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
        if tool_name not in MATCHED_TOOLS:
            return 0

        tool_input = payload.get("tool_input") or payload.get("input") or {}
        if not isinstance(tool_input, dict):
            return 0

        # Scope: only Pi-created tasks are gated
        created_by = (tool_input.get("createdBy") or "").strip().lower()
        if created_by != "pi":
            return 0

        description = tool_input.get("description") or ""
        if not isinstance(description, str):
            return 0

        if _has_override(description):
            return 0

        if _has_verified_line(description):
            return 0

        sys.stderr.write(STDERR_MSG)
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
