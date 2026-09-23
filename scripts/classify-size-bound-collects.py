#!/usr/bin/env python3
"""
classify-size-bound-collects.py — sweep for functions whose per-execution
work grows with the corpus, inside a runtime-bounded execution (GitHub
issues #1294 / #1276 class).

A plain grep for `.collect()` (the brief's own first pass: 77 hits) is too
coarse — `.collect()` after a narrow `.withIndex` equality range is fine.
This classifier separates:

  UNINDEXED   — a `ctx.db.query(...)` chain with NO `.withIndex(...)` call
                before `.collect()`/`.take()` reaches it: a full-table scan,
                unconditionally in the class (this is exactly #1294's
                pre-fix no-topic branch and #1276 pre-fix pattern).
  INDEXED     — a `.withIndex(...)` call is present. Requires per-survivor
                judgment.

Scope: convex/**/*.ts, excluding convex/__tests__/, convex/_generated/, and
scripts/ themselves. `.collect()` AND `.take(` are both in scope (a bare
`.take(N)` with N derived from something that itself grows, e.g.
`.take(someCorpusDerivedCount)`, is the same defect shape as `.collect()` —
but every `.take(<NAMED_CAP_CONSTANT> + 1)` sentinel idiom already used
fleet-wide (R-30) is EXCLUDED by name pattern, since that IS the fix
pattern, not the defect.

--- Triage (task k17fcwtw1wwnp40k3pw81ndk0n8ez4h9) ---

task k17fcwtw1wwnp40k3pw81ndk0n8ez4h9 closed a defect in this classifier's
OWN PR body (#1325): the body claimed survivors "are triaged rather than
left as a number" and that IN-class sites are "recorded with the reason so
nobody re-litigates them" — but no committed artifact held either claim.
This script now READS `scripts/collect-triage.json` and treats an unjudged
survivor as a hard failure (exit 2), so the next run's DIFF is the signal,
not its count: a newly added unbounded read with no triage entry fails the
check by existing, instead of silently joining an UNJUDGED pile nobody
re-counts.

Triage entries are keyed `<path>::<enclosing top-level symbol>::<ordinal>`
— NOT a bare line number, which is a state that expires the moment
anything above the site shifts (this is not hypothetical: the file this
classifier reads drifted by +88 lines between task filing and this task,
and every bare-line-number reference the brief was written against moved).
The enclosing symbol name (the nearest top-level `export const NAME = ...`
/ `function NAME(...)` above the hit) plus a 1-based ordinal of
collect/take occurrences WITHIN that symbol survives:
  - unrelated edits anywhere else in the file (imports, comments, other
    functions);
  - reordering of top-level symbols within the file;
  - edits inside the same function that don't add/remove a collect/take
    call before this one.
It does NOT survive, and this is the honest limit of the scheme:
  - renaming the enclosing function/const (the anchor moves with it in a
    normal refactor tool, but a plain text rename breaks it silently);
  - adding or removing an EARLIER collect/take call inside the SAME
    function (shifts every later ordinal in that function by one);
  - moving the site into a different enclosing function.
A rename or reorder that breaks an anchor shows up as exactly the failure
mode this script exists to catch: the site becomes "missing from triage"
and the check fails loud, rather than silently keeping a stale verdict
attached to the wrong line.
"""
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONVEX_DIR = REPO_ROOT / "convex"
TRIAGE_PATH = REPO_ROOT / "scripts" / "collect-triage.json"

EXCLUDE_DIR_PARTS = {"__tests__", "_generated"}
# Migrations are operator-invoked, one-shot batch jobs (already the "fixed
# amount per execution, resumable" shape the brief asks the FIX to look
# like) — not recurring request-path functions. Excluded from the sweep
# proper; still worth a human glance but not this class's target.
EXCLUDE_TOP_LEVEL_DIRS = {"migrations"}

# Matches `.take(fetchCap)`, `.take(limit)`, `.take(50)`, but the
# `.take(SOMETHING_SCAN_CAP + 1)` / `.take(SOMETHING_CAP + 1)` idiom is the
# established fleet-wide bounded-read sentinel (R-30) — exclude it by name.
TAKE_CAP_SENTINEL_RE = re.compile(r"\.take\(\s*[A-Z0-9_]*(?:SCAN_)?CAP\w*\s*\+\s*1\s*\)")
COLLECT_OR_TAKE_RE = re.compile(r"\.(collect|take)\(")
WITH_INDEX_RE = re.compile(r"\.withIndex\(")

# Top-level (column-0) symbol boundary: `export const NAME = ...` or
# `(export )?(async )?function NAME(...)`. This is the anchor's stable
# component — see the module docstring's "does NOT survive" list for what
# breaks it.
SYMBOL_RE = re.compile(
    r"^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*="
)

VALID_VERDICTS = {"IN", "OUT", "UNJUDGED"}


def iter_source_files():
    for path in sorted(CONVEX_DIR.rglob("*.ts")):
        if any(part in EXCLUDE_DIR_PARTS for part in path.parts):
            continue
        rel_parts = path.relative_to(CONVEX_DIR).parts
        if rel_parts and rel_parts[0] in EXCLUDE_TOP_LEVEL_DIRS:
            continue
        if path.name.endswith(".test.ts"):
            continue
        yield path


def find_hits(path: Path):
    """Returns a list of (key, lineno, kind, has_index, line) tuples."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    hits = []
    current_symbol = "<module-top>"
    symbol_ordinal: dict[str, int] = {}
    rel = path.relative_to(REPO_ROOT)
    for lineno, line in enumerate(lines, start=1):
        m = SYMBOL_RE.match(line)
        if m:
            current_symbol = m.group(1) or m.group(2)
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
            continue  # comment/prose mentioning .collect()/.take(), not code
        if not COLLECT_OR_TAKE_RE.search(line):
            continue
        if TAKE_CAP_SENTINEL_RE.search(line):
            continue  # already the R-30 bounded-read sentinel idiom
        # Look back up to 8 lines for a `.withIndex(` in the same statement
        # (query chains are usually broken across lines).
        window_start = max(0, lineno - 9)
        window = "\n".join(lines[window_start:lineno])
        has_index = bool(WITH_INDEX_RE.search(window))
        kind = "collect" if ".collect(" in line else "take"
        symbol_ordinal[current_symbol] = symbol_ordinal.get(current_symbol, 0) + 1
        ordinal = symbol_ordinal[current_symbol]
        key = f"{rel}::{current_symbol}::{ordinal}"
        hits.append((key, lineno, kind, has_index, line.strip()))
    return hits


def load_triage():
    if not TRIAGE_PATH.exists():
        print(f"FATAL: triage file not found at {TRIAGE_PATH}", file=sys.stderr)
        sys.exit(2)
    data = json.loads(TRIAGE_PATH.read_text(encoding="utf-8"))
    for key, entry in data.items():
        if entry.get("verdict") not in VALID_VERDICTS:
            print(
                f"FATAL: {TRIAGE_PATH} entry {key!r} has invalid verdict {entry.get('verdict')!r}"
                f" (must be one of {sorted(VALID_VERDICTS)})",
                file=sys.stderr,
            )
            sys.exit(2)
        if not entry.get("reason"):
            print(f"FATAL: {TRIAGE_PATH} entry {key!r} has no reason", file=sys.stderr)
            sys.exit(2)
    return data


def main():
    unindexed = []
    indexed = []
    all_hits = []
    for path in iter_source_files():
        for key, lineno, kind, has_index, line in find_hits(path):
            rel = path.relative_to(REPO_ROOT)
            entry = f"{rel}:{lineno}: [{kind}] {line}"
            all_hits.append((key, entry))
            if has_index:
                indexed.append(entry)
            else:
                unindexed.append(entry)

    print("=" * 79)
    print(f"UNINDEXED (definitely in class — full/partial table scan, no .withIndex): {len(unindexed)}")
    print("=" * 79)
    for e in unindexed:
        print(e)

    print()
    print("=" * 79)
    print(f"INDEXED (needs per-survivor judgment — .withIndex present): {len(indexed)}")
    print("=" * 79)
    for e in indexed:
        print(e)

    print()
    print(f"TOTAL SURVIVORS: {len(unindexed) + len(indexed)} (unindexed={len(unindexed)}, indexed={len(indexed)})")

    # --- Triage coverage gate ---
    triage = load_triage()
    missing = [key for key, _entry in all_hits if key not in triage]
    counts = {"IN": 0, "OUT": 0, "UNJUDGED": 0}
    for key, _entry in all_hits:
        verdict = triage[key]["verdict"] if key in triage else None
        if verdict in counts:
            counts[verdict] += 1

    print()
    print("=" * 79)
    print("TRIAGE COVERAGE")
    print("=" * 79)
    print(f"IN={counts['IN']} OUT={counts['OUT']} UNJUDGED={counts['UNJUDGED']} (of {len(all_hits)} survivors)")

    if missing:
        print()
        print(f"FAIL: {len(missing)} survivor(s) have NO triage entry in {TRIAGE_PATH}:")
        for key in missing:
            print(f"  {key}")
        return 2

    print("PASS: every survivor has a triage entry.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
