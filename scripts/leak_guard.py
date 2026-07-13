#!/usr/bin/env python3
"""Leak guard — no client/personal identifiers or internal infra paths in a PUBLIC package.

Context (Day 130): `vantageos-agency/vantage-peers` is a PUBLIC repo and the
plugin under plugin/ is PUBLISHED. The VantageRegistry canonical for
`session-start` carries a hardcoded orchestrator/workspace identity table
containing REAL client names, a REAL person's name, and internal VPS paths:

    "/root/coding/victor-workspace": ("victor", "victor-vps",
        "Victor — Iris RH (Marie Parrent)", "project/iris-rh"),

Blindly resyncing packaged sources from VR would import that leak into the
public package. Hence this guard, and hence the rule that it OUTRANKS parity:

    SECRECY > PARITY.

A packaged artifact must never carry these identifiers, even if that makes it
diverge from its VR canonical. When the VR canonical itself is dirty, parity
for that item is SUSPENDED (see vr_plugin_parity.py) rather than enforced --
otherwise the parity gate would permanently block the purge and force the leak
back in. A guard that compels the very thing it should prevent is worse than
no guard.

MATCHING DISCIPLINE — word-boundary / token matching, NEVER substrings.
A prior fleet purge did substring matching and renamed "summaries" because it
contains "marie" ("sum|marie|s"). We do not repeat that. Every pattern below
is anchored with \\b word boundaries (or is a path/structural pattern), and
the false-positive corpus in tests/plugin/test_leak_guard.py pins the benign
terms that must NEVER match: "summaries", "client-side", "client delivery".
Note in particular that bare "client" is NOT a pattern -- only real, specific
client/person identifiers are.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# =============================================================================
# TWO TIERS. The severities are NOT equal, and treating them as equal is its
# own failure mode: a guard that blocks legitimate work gets ripped out, and
# then it guards nothing. Verified by reading the VR canonicals directly.
# =============================================================================

TIER_CLIENT_DATA = "CLIENT_DATA"
TIER_INTERNAL_ID = "INTERNAL_ID"

# --- TIER 1: REAL CLIENT DATA. Hard block, always, everywhere. ---------------
# Third-party client organisations and their contact persons. This is client
# confidentiality: never sync, never publish, no exceptions, no baselining.
# Exactly ONE VR canonical carries this today: `session-start`
#   "Victor — Iris RH (Marie Parrent)"        -> project/iris-rh
#   "Gaia — ... (1er client Marie Josée / Mini Mondes)"
# It is NOT currently public (absent from origin/main and from the distributed
# plugin copies). It is a LOADED GUN, not a live leak -- and we keep it that way.
#
# Keep this list SPECIFIC. A generic word here (e.g. bare "client") would fire
# on benign prose and get the guard disabled by the next engineer.
CLIENT_DATA_PATTERNS: list[tuple[str, str]] = [
    (r"\bparrent\b", "real person surname (client contact)"),
    (r"\bmarie\s+parrent\b", "real person full name (client contact)"),
    (r"\biris[\s\-_]?rh\b", "real client org name"),
    (r"\bmarie[\s\-]jos[ée]e\b", "real person name (client contact)"),
    (r"\bmini[\s\-]?mondes\b", "real client org name"),
    (r"\bminimondesdemarie\b", "real client org/domain"),
    (r"\balsachimie\b", "real client org name"),
]

# --- TIER 2: INTERNAL IDENTIFIERS ONLY. Tracked, not hard-blocked. -----------
# Operator home paths, internal VPS workspace paths, orchestrator instance ids.
# NO client-org or client-person data. These are already PUBLIC on origin/main
# (e.g. `/home/laurentperello/...` is on line 24 of the very check-messages
# SKILL.md we are replacing), so syncing a canonical that contains them adds
# ZERO new exposure.
#
# WHY WE DO NOT FAIL THE BUILD ON THE PRE-EXISTING BASELINE:
# Failing on day one for state that is ALREADY on main means the gate can never
# go green. A permanently-red gate gets disabled -- and then it guards nothing,
# including the TIER 1 client data that actually matters. So: report every
# TIER 2 finding LOUDLY as a tracked finding with file+line (written down, not
# silently swallowed, so it can be burned down), but FAIL only on a NEW
# introduction -- a regression measured against the origin/main baseline.
INTERNAL_ID_PATTERNS: list[tuple[str, str]] = [
    (r"/root/coding/[A-Za-z0-9._\-]+", "internal VPS workspace path"),
    (r"/home/laurentperello\b", "operator home path"),
    (r"\blaurentperello\b", "operator home path component"),
    (r"\bperello[\s\-]?consulting\b", "operator's own org name (not a client)"),
    (r"\b[a-z]+-vps\b", "internal VPS instance identifier"),
    (r"\bpi-chromebook\b", "internal operator machine identifier"),
]

ALL_PATTERNS: list[tuple[str, str, str]] = [
    *[(p, r, TIER_CLIENT_DATA) for p, r in CLIENT_DATA_PATTERNS],
    *[(p, r, TIER_INTERNAL_ID) for p, r in INTERNAL_ID_PATTERNS],
]


@dataclass
class LeakFinding:
    source: str  # human label: file path, or "VR:<name>"
    line_no: int
    line: str
    pattern: str
    reason: str
    category: str

    @property
    def tier(self) -> str:
        return self.category

    @property
    def is_client_data(self) -> bool:
        return self.category == TIER_CLIENT_DATA

    def render(self) -> str:
        return (
            f"{self.source}:{self.line_no}: [{self.category}: {self.reason}] "
            f"matched /{self.pattern}/\n      {self.line.strip()[:160]}"
        )

    def fingerprint(self) -> tuple:
        """Identity of a finding for baseline comparison, INDEPENDENT of line number.

        Line numbers shift when unrelated content is edited; keying the baseline
        on them would produce phantom 'new' findings. We key on the offending
        token as it appears, plus the pattern that caught it.
        """
        m = re.search(self.pattern, self.line, flags=re.IGNORECASE)
        return (self.pattern, m.group(0).lower() if m else "")


def client_data(findings: list["LeakFinding"]) -> list["LeakFinding"]:
    return [f for f in findings if f.category == TIER_CLIENT_DATA]


def internal_ids(findings: list["LeakFinding"]) -> list["LeakFinding"]:
    return [f for f in findings if f.category == TIER_INTERNAL_ID]


def new_internal_ids(
    current: list["LeakFinding"], baseline: list["LeakFinding"]
) -> list["LeakFinding"]:
    """TIER 2 regressions only: internal identifiers NOT present in the baseline.

    Pre-existing internal identifiers (already public on origin/main) are tracked
    and reported, but do not fail the build -- see the TIER 2 rationale above.
    A NEWLY introduced one does fail: that is a regression, and the baseline only
    ever burns down.

    THE BASELINE IS REPO-WIDE, NOT PER-FILE -- and that is deliberate.
    Exposure is a property of the PUBLISHED PACKAGE, not of an individual file.
    `/home/laurentperello` is already public on origin/main (check-messages
    SKILL.md line 27). Its appearance in a second packaged file discloses nothing
    that is not already disclosed: the token is out. Scoping the baseline per-file
    would mark that as a "new" leak and block a sync that adds ZERO new exposure --
    exactly the over-blocking that gets a guard disabled.
    A token that is NOT already public anywhere in the packaged artifact (a new
    client, a new host, a new person) still fails. That is the line that matters.
    """
    base = {f.fingerprint() for f in internal_ids(baseline)}
    return [f for f in internal_ids(current) if f.fingerprint() not in base]


def packaged_paths(root: Path = None) -> list[Path]:
    root = root or REPO_ROOT
    return sorted((root / "plugin" / "skills").glob("*/SKILL.md")) + sorted(
        (root / "plugin" / "hooks").glob("*.py")
    )


def repo_wide_baseline(ref: str = None) -> list["LeakFinding"]:
    """Every internal identifier already public across the packaged artifact on `ref`.

    Derived from git + the packaged directories, never hand-maintained.
    """
    ref = ref or BASELINE_REF
    out: list[LeakFinding] = []
    for p in packaged_paths():
        out.extend(scan_baseline(p, ref))
    return out


def scan_text(text: str, source: str) -> list[LeakFinding]:
    """Return every leak finding in `text`. Empty list == clean."""
    findings: list[LeakFinding] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        for pattern, reason, category in ALL_PATTERNS:
            if re.search(pattern, line, flags=re.IGNORECASE):
                findings.append(
                    LeakFinding(
                        source=source,
                        line_no=line_no,
                        line=line,
                        pattern=pattern,
                        reason=reason,
                        category=category,
                    )
                )
    return findings


def scan_file(path: Path) -> list[LeakFinding]:
    return scan_text(path.read_text(encoding="utf-8", errors="replace"), str(path))


BASELINE_REF = os.environ.get("LEAK_GUARD_BASELINE_REF", "origin/main")


def scan_baseline(path: Path, ref: str = BASELINE_REF) -> list[LeakFinding]:
    """Scan the SAME file as it exists on `ref` (default origin/main).

    This is the TIER 2 baseline: what is already public. Derived from git, never
    hand-maintained -- a hand-written allowlist is the same disease one level up.
    A file absent from `ref` (a brand-new packaged file) has an EMPTY baseline,
    so every internal identifier in it counts as new -> build fails. That is the
    correct default: new files must be born clean.
    """
    try:
        rel = path.resolve().relative_to(REPO_ROOT)
    except ValueError:
        return []
    proc = subprocess.run(
        ["git", "show", f"{ref}:{rel.as_posix()}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return []  # absent from baseline -> born-clean rule applies
    return scan_text(proc.stdout, f"{ref}:{rel.as_posix()}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "paths", nargs="*", help="files to scan (default: the packaged plugin artifact)"
    )
    args = parser.parse_args()

    if args.paths:
        targets = [Path(p) for p in args.paths]
    else:
        skills = sorted((REPO_ROOT / "plugin" / "skills").glob("*/SKILL.md"))
        hooks = sorted((REPO_ROOT / "plugin" / "hooks").glob("*.py"))
        targets = skills + hooks

    if not targets:
        print(
            "FAIL: leak guard enumerated ZERO files. That is a broken parser, "
            "not a clean repo.",
            file=sys.stderr,
        )
        return 2

    fatal_client: list[LeakFinding] = []
    regressions: list[LeakFinding] = []
    tracked: list[LeakFinding] = []

    baseline = repo_wide_baseline()  # what is ALREADY public in the package

    for t in targets:
        found = scan_file(t)
        cd = client_data(found)
        new_ids = new_internal_ids(found, baseline)
        pre_existing = [f for f in internal_ids(found) if f not in new_ids]

        fatal_client.extend(cd)
        regressions.extend(new_ids)
        tracked.extend(pre_existing)

        if cd:
            status = f"CLIENT-DATA ({len(cd)})"
        elif new_ids:
            status = f"NEW-INTERNAL-ID ({len(new_ids)})"
        elif pre_existing:
            status = f"tracked ({len(pre_existing)})"
        else:
            status = "clean"
        print(f"{status:22} {t}")

    print("-" * 90)

    # TIER 2, pre-existing: written down, NOT a build failure. This is the
    # burn-down list -- it must never grow (regressions above enforce that).
    if tracked:
        print(
            f"\nTRACKED — {len(tracked)} pre-existing INTERNAL identifier(s), "
            f"already public on {BASELINE_REF}. No new exposure; NOT failing the "
            "build. Burn these down:"
        )
        for f in tracked:
            print(f"  {f.render()}")

    exit_code = 0

    # TIER 2, regressions: a NEW internal identifier is a regression -> RED.
    if regressions:
        print(
            f"\nFAILED — {len(regressions)} NEW internal identifier(s) introduced "
            f"(not present on {BASELINE_REF}). The baseline only burns down, never "
            "grows:",
            file=sys.stderr,
        )
        for f in regressions:
            print(f"  {f.render()}", file=sys.stderr)
        exit_code = 1

    # TIER 1: real client data. Hard block, always. Printed DISTINCTLY.
    if fatal_client:
        print(
            f"\n{'=' * 70}\nCLIENT DATA — {len(fatal_client)} finding(s). HARD BLOCK.\n"
            f"{'=' * 70}\n"
            "Real client organisations and/or their contact persons. This is client\n"
            "confidentiality in a PUBLIC, PUBLISHED package. Never sync, never ship.\n",
            file=sys.stderr,
        )
        for f in fatal_client:
            print(f"  {f.render()}", file=sys.stderr)
        exit_code = 1

    if exit_code == 0:
        print(
            f"\nLEAK GUARD PASSED — no client data, no new internal identifiers "
            f"across {len(targets)} packaged file(s)."
        )
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
