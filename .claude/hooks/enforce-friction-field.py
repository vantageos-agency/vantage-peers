#!/usr/bin/env python3
# // allow-no-friction-field: hook-source-documentation
"""
PreToolUse hook: enforces RULE #15 Auto-Amelioration (Day 89).

Every complete_task must declare what friction the orchestrator hit
during the work — even if the answer is "none". The goal is to grow
the meta-cognitive reflex Laurent diagnosed as missing Day 89:

    "vous, orchestrateurs n'avez pas du tout le reflexe d'ameliorer
     ce qui ne fonctionne pas ou qui ne fonctionne pas de maniere
     optimale. comment fixer ca?"

Examples of friction the fleet swallowed silently before this hook:
  - CronCreate ignored durable=true -> registrations dropped at restart
  - gws CLI emitted token_cache decrypt warnings on every call
  - hooks fired false positives bypassed via override instead of fixed
  - check-messages skill papered over MCP v2.3.2 schema gap

Enforced on:
  - mcp__vantage-peers__complete_task

A completionNote PASSES when it contains a line matching:
  ^\\s*friction_observed:\\s*<value>     // allow-no-friction-field: hook-source-documentation
where <value> is at least one non-whitespace char. The literal value
"none" or "0" is accepted — the discipline is the DECLARATION.

Opt-out (rare, one-shot): add the override marker
  // allow-no-friction-field: <reason>
in the completionNote. Reason >= 3 chars.

Fail-open on malformed JSON / internal errors.
"""

from __future__ import annotations

import json
import re
import sys

# Matchers this hook fires on
MATCHED_TOOLS = {"mcp__vantage-peers__complete_task"}

# Trigger string at start of line, any non-empty value after
FRICTION_LINE_RE = re.compile(  # // allow-no-friction-field: hook-source-documentation
    r"^\s*friction_observed:\s*\S",  # // allow-no-friction-field: hook-source-documentation
    re.IGNORECASE | re.MULTILINE,
)

# Override marker: `// allow-no-friction-field: <reason>` with reason >= 3 chars
OVERRIDE_RE = re.compile(  # // allow-no-friction-field: hook-source-documentation
    r"//\s*allow-no-friction-field\s*:\s*\S{3,}",  # // allow-no-friction-field: hook-source-documentation
    re.IGNORECASE,
)


STDERR_MSG = (
    "BLOCKED: RULE #15 Auto-Amelioration (Day 89 — 2026-05-31).\n"
    "\n"
    "completionNote is missing the mandatory friction declaration.\n"
    "\n"
    "Laurent verbatim Day 89:\n"
    "  \"vous, orchestrateurs n'avez pas du tout le reflexe\n"
    "   d'ameliorer ce qui ne fonctionne pas ou qui ne fonctionne\n"
    "   pas de maniere optimale. comment fixer ca?\"\n"
    "\n"
    "Every complete_task must surface friction the orchestrator hit\n"
    "during the work — silent CronCreate durable bugs, gws CLI\n"
    "warnings, hook false positives, MCP schema gaps — instead of\n"
    "working around them and moving on.\n"
    "\n"
    "FIX: add a line to the completionNote of the form:\n"
    "  friction_observed: <what you hit, or 'none'>\n"  # // allow-no-friction-field: hook-source-documentation
    "\n"
    "Examples:\n"
    "  friction_observed: none\n"  # // allow-no-friction-field: hook-source-documentation
    "  friction_observed: CronCreate dropped durable=true silently at restart\n"  # // allow-no-friction-field: hook-source-documentation
    "  friction_observed: gws CLI emits token_cache decrypt warning per call\n"  # // allow-no-friction-field: hook-source-documentation
    "  friction_observed: enforce-X hook false-positives on Eta proper noun\n"  # // allow-no-friction-field: hook-source-documentation
    "\n"
    "Value 'none' or '0' is accepted — the discipline is the\n"
    "DECLARATION, not the quantity. Anything you flag will be\n"
    "harvested at close-day and aggregated weekly by /friction-digest\n"
    "into improvement missions dispatched fleet-wide.\n"
    "\n"
    "Override (rare, one-shot — fix the source after):\n"
    "  add `// allow-no-friction-field: <reason>` in the note.\n"
)


def _has_friction_line(text: str) -> bool:
    if not text:
        return False
    return bool(FRICTION_LINE_RE.search(text))


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

        note = tool_input.get("completionNote") or ""
        if not isinstance(note, str):
            return 0

        if _has_override(note):
            return 0

        if _has_friction_line(note):
            return 0

        sys.stderr.write(STDERR_MSG)
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
