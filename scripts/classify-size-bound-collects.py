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
                judgment (this script prints the index name + file:line for
                a human/agent to classify — see the per-survivor verdicts in
                the task report, not in this script's own output).

Scope: convex/**/*.ts, excluding convex/__tests__/, convex/_generated/, and
scripts/ themselves. `.collect()` AND `.take(` are both in scope (a bare
`.take(N)` with N derived from something that itself grows, e.g.
`.take(someCorpusDerivedCount)`, is the same defect shape as `.collect()` —
but every `.take(<NAMED_CAP_CONSTANT> + 1)` sentinel idiom already used
fleet-wide (R-30) is EXCLUDED by name pattern, since that IS the fix
pattern, not the defect.
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONVEX_DIR = REPO_ROOT / "convex"

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


def iter_source_files():
    for path in CONVEX_DIR.rglob("*.ts"):
        if any(part in EXCLUDE_DIR_PARTS for part in path.parts):
            continue
        rel_parts = path.relative_to(CONVEX_DIR).parts
        if rel_parts and rel_parts[0] in EXCLUDE_TOP_LEVEL_DIRS:
            continue
        if path.name.endswith(".test.ts"):
            continue
        yield path


def find_hits(path: Path):
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    hits = []
    for lineno, line in enumerate(lines, start=1):
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
        # Also check forward 1 line in case .withIndex trails on same
        # logical statement continuation (rare, but keep it honest).
        kind = "collect" if ".collect(" in line else "take"
        hits.append((lineno, kind, has_index, line.strip()))
    return hits


def main():
    unindexed = []
    indexed = []
    for path in sorted(iter_source_files()):
        rel = path.relative_to(REPO_ROOT)
        for lineno, kind, has_index, line in find_hits(path):
            entry = f"{rel}:{lineno}: [{kind}] {line}"
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


if __name__ == "__main__":
    sys.exit(main())
