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

sys.path.insert(0, str(Path(__file__).resolve().parent))

from client_identity_config import (  # noqa: E402
    ClientIdentityConfigError,
    resolve_client_data_patterns,
    resolve_config_path,
)

REPO_ROOT = Path(__file__).resolve().parent.parent

# =============================================================================
# TWO TIERS. The severities are NOT equal, and treating them as equal is its
# own failure mode: a guard that blocks legitimate work gets ripped out, and
# then it guards nothing. Verified by reading the VR canonicals directly.
# =============================================================================

TIER_CLIENT_DATA = "CLIENT_DATA"
TIER_INTERNAL_ID = "INTERNAL_ID"

# --- TIER 1: REAL CLIENT DATA. Hard block, always, everywhere. ---------------
# Day 130 (Eta review, PR #1090): a hand-typed list like the one below rots at
# every new client -- the next one is always the one nobody remembered to add,
# and it printed PASSED straight through the gap. As of this fix, the LIVE
# client vocabulary is RESOLVED at run time from a host-side config (see
# client_identity_config.py) and merged in via `extra_client_patterns` in
# `main()`. `main()` FAILS LOUDLY, and never prints PASSED, if that config
# cannot be resolved. Do NOT add any new client identifier to the literal
# list below -- new clients go in the host config, never in this file.
#
# The entries still hard-coded below are the small, already-reviewed,
# pre-Day-130 set (kept for the regression tests pinned against them); they
# are not where new client vocabulary belongs going forward.
#
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
    # Real Convex deployment slugs are a CLIENT's live production infrastructure
    # identifier, not an internal operator detail -- Day 130 finding: the
    # vantage-immo prod slug `proper-alligator-8` shipped verbatim in a public
    # CHANGELOG. Listed by literal value, ON PURPOSE, NOT by a generic
    # adjective-animal-number shape regex: measured against the packaged
    # artifact, a shape-based `\b[a-z]+-[a-z]+-\d+\b` pattern hits 39 unrelated
    # hyphenated identifiers (hook names like `enforce-ship-24`, example CSS
    # classes like `bg-gray-900`, decision-doc slugs like `hook-postmortem-2026`
    # -- none of them Convex deployments) for the one real slug it is meant to
    # catch. A pattern with that false-positive ratio is exactly the kind of
    # guard that gets ripped out after mutilating a doc it shouldn't have
    # touched. Real slugs must be added here explicitly as they are confirmed;
    # `guineapig-77` (skills/deploy-track/SKILL.md) is a pedagogical worked
    # example, not client data, and MUST stay off this list.
    (r"\bproper-alligator-8\b", "real client production Convex deployment slug"),
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
    # The maintainer's own first name -- Day 130 T3 finding: it ships verbatim
    # in 10 packaged files. This is the operator's own identity, not a client's
    # (that distinction is what keeps this TIER 2, not TIER 1): still real PII
    # in a PUBLIC package, tracked and regression-gated like every other
    # internal identifier above.
    (r"\blaurent\b", "operator's own first name"),
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


# --- Derived, full-artifact inventory ---------------------------------------
# Day 130 T2 finding: the two hand-written globs above (`skills/*/SKILL.md`,
# `hooks/*.py`) see 53 of 284 files in a real published package -- 19%
# coverage. Anything under `references/`, `evals/`, `docs/`, `templates/`, a
# nested `agents/` tree, etc. is invisible to them. `derive_inventory` below
# is the replacement: it walks the artifact directory from disk (never a
# hand-maintained list) so CHECKED + SKIPPED always sums to 100% of what is
# actually shipped. This is the same discipline `vr_plugin_parity.py` already
# uses (`Path.iterdir()` there) -- applied here to the whole tree, not just
# two subfolders.

# Directories excluded from scanning, WITH a written reason each. This is the
# only silent-skip surface allowed, and it is not silent: every path skipped
# for one of these reasons is reported as SKIPPED, never simply absent.
EXCLUDED_DIR_NAMES: dict[str, str] = {
    ".git": "version-control internals, never shipped as package content",
    "node_modules": "third-party dependency tree, not first-party package content",
    # __pycache__ is deliberately NOT excluded any more. It used to be, with the
    # reason "never shipped" -- which was simply untrue: the .pyc was committed,
    # published, and carried client names in its bytecode. An exclusion is a claim
    # about reality; when the claim is wrong, the exclusion becomes the hiding
    # place. If a __pycache__ is present in a shipped tree, that is itself the
    # finding, and the guard must be able to say so.
}

# NOTHING IS SKIPPED FOR BEING BINARY. Every shipped file is read as BYTES.
#
# The previous version skipped binary extensions "not scanned as text", and
# excluded __pycache__ with the comment "compiled bytecode cache, not source,
# never shipped". Both were false, and together they hid a live leak:
# scripts/__pycache__/leak_guard.cpython-312.pyc was COMMITTED and PUBLISHED on
# the public repo, and `strings` on its bytecode returned 6 client-name hits.
# The .pyc of the leak guard was leaking the very identifiers the leak guard
# exists to catch, and the guard could not see it because it refused to open it.
#
# Purging a name from the SOURCE does not remove it from a compiled artifact:
# string constants survive in bytecode. And a directory-copy distribution ships
# whatever sits in the tree, tracked or not. This repo's own plugin CHANGELOG had
# already written the lesson down -- "the bytecode has to actually be absent from
# the directory" -- and this guard did not apply it.
#
# So: bytes, always. Decoding is latin-1, which cannot raise and maps every byte
# to exactly one character, so ASCII identifiers embedded in any container --
# bytecode, archives, images with metadata -- are still found. Scanning a binary
# for a name yields at worst a harmless false-positive line number; NOT scanning
# it yields a silent leak. Those two failure modes are not comparable.
BINARY_EXTENSIONS: frozenset[str] = frozenset()


def _claudepluginignore_patterns(root: Path) -> list[str]:
    ignore_file = root / ".claudepluginignore"
    if not ignore_file.is_file():
        return []
    lines = ignore_file.read_text(encoding="utf-8", errors="replace").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("#")]


@dataclass
class InventoryItem:
    path: Path
    skip_reason: str | None = None  # None == CHECKED; set == SKIPPED-with-reason

    @property
    def checked(self) -> bool:
        return self.skip_reason is None


def derive_inventory(root: Path) -> list[InventoryItem]:
    """Walk `root` on disk and classify every shipped file as CHECKED or
    SKIPPED-with-a-written-reason. CHECKED ∪ SKIPPED == 100% of `root`'s files,
    by construction (every file yielded by the walk gets exactly one
    InventoryItem). Never a hand-written file list.
    """
    if not root.is_dir():
        raise FileNotFoundError(f"leak guard inventory root does not exist or is not a directory: {root}")

    ignore_patterns = _claudepluginignore_patterns(root)
    items: list[InventoryItem] = []

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_NAMES]
        dpath = Path(dirpath)
        for fname in sorted(filenames):
            fpath = dpath / fname
            rel = fpath.relative_to(root).as_posix()

            reason = None
            if fpath.suffix.lower() in BINARY_EXTENSIONS:
                reason = f"binary file extension {fpath.suffix!r}, not scanned as text"
            else:
                for pat in ignore_patterns:
                    if fpath.match(pat) or rel == pat or rel.startswith(pat.rstrip("/") + "/"):
                        reason = f".claudepluginignore pattern {pat!r}"
                        break

            items.append(InventoryItem(path=fpath, skip_reason=reason))

    return items


def repo_wide_baseline(ref: str = None, paths: list[Path] | None = None, git_root: Path | None = None) -> list["LeakFinding"]:
    """Every internal identifier already public across the packaged artifact on `ref`.

    Derived from git + the packaged directories, never hand-maintained. `paths`
    defaults to `packaged_paths()` (this script's own two-glob artifact) for
    backward compatibility with existing callers/tests; `main()` passes the
    DERIVED inventory + the target artifact's own `git_root` when scanning an
    external package.
    """
    ref = ref or BASELINE_REF
    out: list[LeakFinding] = []
    for p in (paths if paths is not None else packaged_paths()):
        out.extend(scan_baseline(p, ref, git_root=git_root))
    return out


def scan_text(
    text: str,
    source: str,
    extra_client_patterns: list[tuple[str, str]] | None = None,
) -> list[LeakFinding]:
    """Return every leak finding in `text`. Empty list == clean.

    `extra_client_patterns` -- (regex, reason) pairs, TIER_CLIENT_DATA -- lets
    callers merge in the RESOLVED, host-config-derived client vocabulary
    (see client_identity_config.py) on top of the small set of historical,
    already-reviewed literals in `CLIENT_DATA_PATTERNS` below. `main()` is the
    only caller that is REQUIRED to pass a resolved set (and fails loudly,
    never PASSED, if it cannot resolve one) -- direct `scan_text` callers
    (tests, `vr_plugin_parity.py`) may omit it when they are only exercising
    the pre-existing, already-reviewed pattern set.
    """
    patterns = ALL_PATTERNS
    if extra_client_patterns:
        patterns = ALL_PATTERNS + [
            (p, r, TIER_CLIENT_DATA) for p, r in extra_client_patterns
        ]
    findings: list[LeakFinding] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        for pattern, reason, category in patterns:
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


def scan_file(
    path: Path,
    extra_client_patterns: list[tuple[str, str]] | None = None,
) -> list[LeakFinding]:
    # BYTES, not text. latin-1 cannot raise and maps every byte to exactly one
    # character, so ASCII identifiers embedded in ANY container -- Python
    # bytecode, an archive, image metadata -- are still found. utf-8 with
    # errors="replace" would mangle those regions into U+FFFD and quietly lose
    # the very strings we are hunting: the search would come back clean, which is
    # the one answer a leak scanner must never give by accident.
    return scan_text(
        path.read_bytes().decode("latin-1"),
        str(path),
        extra_client_patterns=extra_client_patterns,
    )


BASELINE_REF = os.environ.get("LEAK_GUARD_BASELINE_REF", "origin/main")


def _git_toplevel(start: Path) -> Path | None:
    """Return the git repo root containing `start`, or None if it isn't one."""
    proc = subprocess.run(
        ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return None
    return Path(proc.stdout.strip())


def scan_baseline(path: Path, ref: str = BASELINE_REF, git_root: Path | None = None) -> list[LeakFinding]:
    """Scan the SAME file as it exists on `ref` (default origin/main) of the git
    repo that CONTAINS `path` (`git_root`, auto-detected from `path` when not
    given explicitly -- this is what makes the baseline correct when scanning
    an external artifact, e.g. a clone of the published plugin repo, instead of
    this script's own repo).

    This is the TIER 2 baseline: what is already public. Derived from git, never
    hand-maintained -- a hand-written allowlist is the same disease one level up.
    A file absent from `ref` (a brand-new packaged file) has an EMPTY baseline,
    so every internal identifier in it counts as new -> build fails. That is the
    correct default: new files must be born clean.
    """
    root = git_root or _git_toplevel(path.resolve().parent) or REPO_ROOT
    try:
        rel = path.resolve().relative_to(root)
    except ValueError:
        return []
    proc = subprocess.run(
        ["git", "show", f"{ref}:{rel.as_posix()}"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return []  # absent from baseline -> born-clean rule applies
    return scan_text(proc.stdout, f"{ref}:{rel.as_posix()}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "paths",
        nargs="*",
        help=(
            "explicit files to scan. If omitted, the inventory is DERIVED "
            "(os.walk, never hand-written globs) from --root."
        ),
    )
    parser.add_argument(
        "--root",
        default=str(REPO_ROOT / "plugin"),
        help=(
            "root directory of the shipped artifact to walk when no explicit "
            "paths are given (default: %(default)s). Point this at any "
            "published/packaged copy, e.g. a clone of the public plugin repo."
        ),
    )
    args = parser.parse_args()

    # RESOLVE THE CLIENT VOCABULARY FIRST, before anything else. A guard that
    # scans files and only discovers afterwards that it never had a resolved
    # client vocabulary is one bad refactor away from silently downgrading
    # "I could not resolve the vocabulary" into "found nothing" -> PASSED.
    # Fail here, loudly, before any scanning happens, and before any code
    # path that could reach the PASSED print at the bottom of this function.
    try:
        resolved_client_patterns = resolve_client_data_patterns()
    except ClientIdentityConfigError as exc:
        print(
            "FAIL: could not resolve the client-identity vocabulary -- "
            "refusing to report PASSED without it.\n"
            f"  {exc}",
            file=sys.stderr,
        )
        return 2

    skipped: list[InventoryItem] = []
    git_root: Path | None = None

    if args.paths:
        targets = [Path(p) for p in args.paths]
    else:
        root = Path(args.root)
        try:
            inventory = derive_inventory(root)
        except FileNotFoundError as exc:
            print(f"FAIL: {exc}", file=sys.stderr)
            return 2
        targets = [item.path for item in inventory if item.checked]
        skipped = [item for item in inventory if not item.checked]
        git_root = _git_toplevel(root)

    if not targets:
        print(
            "FAIL: leak guard enumerated ZERO files. That is a broken parser, "
            "not a clean repo.",
            file=sys.stderr,
        )
        return 2

    if skipped:
        print(f"SKIPPED (with reason) — {len(skipped)} file(s):")
        for item in skipped:
            print(f"  {item.path}: {item.skip_reason}")
        print("-" * 90)

    total_enumerated = len(targets) + len(skipped)
    print(
        f"Derived inventory: {total_enumerated} file(s) total "
        f"({len(targets)} CHECKED, {len(skipped)} SKIPPED-with-reason)."
    )
    print("-" * 90)

    fatal_client: list[LeakFinding] = []
    regressions: list[LeakFinding] = []
    tracked: list[LeakFinding] = []

    # What is ALREADY public in the package, per the ARTIFACT'S OWN git history
    # (not this script's repo) when scanning a derived, external inventory.
    baseline = repo_wide_baseline(paths=targets if not args.paths else None, git_root=git_root)

    for t in targets:
        found = scan_file(t, extra_client_patterns=resolved_client_patterns)
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
            f"\nLEAK GUARD PASSED — client vocabulary RESOLVED "
            f"({len(resolved_client_patterns)} identity pattern(s) from "
            f"{resolve_config_path()}); no client data, no new internal "
            f"identifiers across {len(targets)} packaged file(s)."
        )
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
