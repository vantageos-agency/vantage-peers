#!/usr/bin/env python3
"""
PreToolUse hook on mcp__vantage-peers__create_mission.
Blocks missions whose brief does not reference a REAL mission template.

DYNAMIC SOURCE (Day 156 — Sigma P4). The set of valid template names is no
longer a hardcoded whitelist (root cause of non-usage: any real VP template not
baked into the list was wrongly refused). It is resolved at runtime, in order:
  1. `MISSION_TEMPLATE_PROBE_CMD` — a shell command emitting a JSON array of the
     live template names (mirrors the IRP_PROBE_CMD probe convention used by
     sibling hooks). This is the canonical live source.
  2. `MISSION_TEMPLATE_MANIFEST` (or DEFAULT_MANIFEST) — a cached JSON array of
     template names on disk, if present.
  3. No source available -> accept ANY well-formed `[a-z0-9-]+-v\\d+` slug the
     caller cites as a template (the regex is the only gate). The static list is
     GONE; a fresh template is never refused for being "unknown".

ANTI-GENERIC GATE (Day 156 — Sigma P4). `mission-generic-v1` on a BUILD /
construction mission is refused, because a build almost always has a specific
template. It passes only when the brief cites a template search proving none
matched (`template search: ...`) or carries the override marker
(`genericJustified: <reason>`). Generic on a non-build mission is legitimate.

Opt-out: include `templateOptOut: <reason>` in the brief. RARE — Laurent Day 73
PM doctrine: "pas de bypass pour se confronter au même problème encore et
encore". If you need opt-out twice, FIX THE ROOT CAUSE.

Exit 0 = allow, Exit 2 = block. Fail-open on exception.

Version: 2.0.0 (2026-08-06 Day 156 — Sigma k17fwfkvt : static list -> dynamic
source + anti-generic build gate)
"""
import json
import os
import pathlib
import re
import subprocess
import sys

DEFAULT_MANIFEST = str(
    pathlib.Path(__file__).resolve().parent / "fixtures" / "mission-templates.json"
)
GENERIC_TEMPLATE = "mission-generic-v1"

TEMPLATE_PATTERN = re.compile(
    r"template\s*(?:utilis(?:e|\xe9)\s*)?:\s*([a-z0-9-]+-v\d+)", re.IGNORECASE
)
OPT_OUT_PATTERN = re.compile(r"templateOptOut\s*:\s*\S", re.IGNORECASE)
# A build/construction mission: something is being built rather than researched.
BUILD_PATTERN = re.compile(
    r"\b(build|builds|building|construct\w*|implement\w*|develop\w*|scaffold\w*|"
    r"refactor\w*|migrat\w*|feature|construire|d\xe9velopp\w*|impl\xe9ment\w*|"
    r"cr\xe9er)\b",
    re.IGNORECASE,
)
# A cited template search proving no specific template matched the scope.
TEMPLATE_SEARCH_PATTERN = re.compile(r"template\s+search\s*:\s*\S", re.IGNORECASE)
# Documented override for the legitimate generic-on-build case.
GENERIC_OVERRIDE_PATTERN = re.compile(r"genericJustified\s*:\s*\S", re.IGNORECASE)


def load_known_templates():
    """Return a set of live template names, or None when no source is available.

    None is the signal to fall back to the well-formed-slug regex gate — it must
    NOT be treated as an empty whitelist (that would refuse everything)."""
    cmd = os.environ.get("MISSION_TEMPLATE_PROBE_CMD")
    if cmd:
        try:
            out = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=5
            )
            names = json.loads(out.stdout)
            if isinstance(names, list) and names:
                return {str(n).lower() for n in names}
        except Exception:
            pass
    manifest = os.environ.get("MISSION_TEMPLATE_MANIFEST", DEFAULT_MANIFEST)
    try:
        with open(manifest) as f:
            names = json.load(f)
            if isinstance(names, list) and names:
                return {str(n).lower() for n in names}
    except Exception:
        pass
    return None


def _block(msg: str, known=None) -> None:
    if known:
        listing = "\n  - ".join(sorted(known))
        source = f"Live templates:\n  - {listing}\n\n"
    else:
        source = "Cite any real VP mission-template as `Template: <slug>-vN`.\n\n"
    print(
        f"BLOCKED: {msg}\n\n"
        f"Every mission brief MUST reference a real mission template:\n"
        f'  Example: "Template utilise : hook-development-v1"\n\n'
        f"{source}"
        f"Opt-out (rare): add `templateOptOut: <reason>` to the brief.",
        file=sys.stderr,
    )
    sys.exit(2)


try:
    data = json.load(sys.stdin)
    # TOOL_NAME_GUARD_PI_FIX Day 113 — fleet deadlock fix (matcher=null fires on every tool)
    if data.get("tool_name") != "mcp__vantage-peers__create_mission":
        sys.exit(0)
    brief = data.get("tool_input", {}).get("brief", "") or ""

    if not brief.strip():
        _block("Mission has no brief — cannot verify template reference.")

    if OPT_OUT_PATTERN.search(brief):
        sys.exit(0)

    match = TEMPLATE_PATTERN.search(brief)
    if not match:
        _block("Brief does not reference any mission template.")

    name = match.group(1).lower()
    known = load_known_templates()

    # Defect 1 — dynamic gate: only refuse "unknown" when a live source exists
    # AND the name is absent from it. No source -> the regex slug is enough.
    if known is not None and name not in known:
        _block(f"Template '{name}' is not in the live template set.", known)

    # Defect 2 — anti-generic gate on build/construction missions.
    if name == GENERIC_TEMPLATE and BUILD_PATTERN.search(brief):
        if not (
            TEMPLATE_SEARCH_PATTERN.search(brief)
            or GENERIC_OVERRIDE_PATTERN.search(brief)
        ):
            _block(
                "mission-generic-v1 on a BUILD mission needs a cited template "
                "search (`template search: <what you searched, none matched>`) "
                "or the override `genericJustified: <reason>`. A build almost "
                "always has a specific template — generic is the last resort."
            )

    sys.exit(0)

except SystemExit:
    raise
except Exception:
    sys.exit(0)
