#!/usr/bin/env python3
"""
PreToolUse hook on mcp__vantage-peers__create_mission.
Blocks new missions whose brief doesn't cite the Fleet Living Bible (VR catalog).

Doctrine RULE #26 — FLEET-BIBLE-CONSULT
Day 105 trigger: Gamma + Pi about to propose 3 MCPs already published 2 months ago.
Fix structurel: every new mission MUST reference VR catalog before adding surface.

A valid reference matches any of:
  - "VR-CHECKED: <component or N/A>" (case-insensitive, in brief)
  - "# vr-checked: <reason>"
  - "// vr-checked: <reason>"
  - "fleet-asset-bible" (citing the legacy markdown source)
  - "mcp__vantage-registry__list_components" or "list_components" (tool invocation cited)

Override (rare, one-shot):
  // allow-no-vr-check: <reason linked to fix-pattern>

Exit 0 = allow, Exit 2 = block. Fail-open on exception.

Version: 1.0.0 (2026-06-17 Day 105 — RULE #26 ship)
"""
import json
import re
import sys

VR_CHECK_PATTERNS = [
    re.compile(r"VR-CHECKED\s*:\s*\S", re.IGNORECASE),
    re.compile(r"#\s*vr-checked\s*:\s*\S", re.IGNORECASE),
    re.compile(r"//\s*vr-checked\s*:\s*\S", re.IGNORECASE),
    re.compile(r"fleet-asset-bible", re.IGNORECASE),
    re.compile(r"mcp__vantage-registry__list_components", re.IGNORECASE),
    re.compile(r"\blist_components\b", re.IGNORECASE),
]
OVERRIDE_PATTERN = re.compile(r"//\s*allow-no-vr-check\s*:\s*\S", re.IGNORECASE)


def _has_vr_check(text: str) -> bool:
    if not text:
        return False
    for pat in VR_CHECK_PATTERNS:
        if pat.search(text):
            return True
    return False


def _block() -> None:
    print(
        "BLOCKED: new mission missing VR (Fleet Living Bible) consult reference.\n\n"
        "RULE #26 FLEET-BIBLE-CONSULT: every new mission MUST cite the VR catalog\n"
        "to prevent reinventing components that already exist.\n\n"
        "Accepted markers (any one in brief):\n"
        "  - 'VR-CHECKED: <component-name>' (or 'N/A' if scope is not new-component)\n"
        "  - '# vr-checked: <reason>'\n"
        "  - '// vr-checked: <reason>'\n"
        "  - 'fleet-asset-bible' (citing legacy source)\n"
        "  - 'list_components' or 'mcp__vantage-registry__list_components' (tool cited)\n\n"
        "How to comply: run `mcp__vantage-registry__list_components` (or search_all) before\n"
        "proposing a new component, then cite the check in the mission brief.\n\n"
        "Override (rare, one-shot): add `// allow-no-vr-check: <reason>` in the brief.\n",
        file=sys.stderr,
    )
    sys.exit(2)


try:
    data = json.load(sys.stdin)
    # TOOL_NAME_GUARD_PI_FIX Day 113 — fleet deadlock fix (matcher=null fires on every tool)
    if data.get("tool_name") != "mcp__vantage-peers__create_mission":
        sys.exit(0)
    tool_input = data.get("tool_input", {}) or {}

    brief = tool_input.get("brief") or ""
    description = tool_input.get("description") or ""
    name = tool_input.get("name") or ""
    combined = f"{name}\n{description}\n{brief}"

    if OVERRIDE_PATTERN.search(combined):
        sys.exit(0)

    if _has_vr_check(combined):
        sys.exit(0)

    _block()

except SystemExit:
    raise
except Exception:
    sys.exit(0)
