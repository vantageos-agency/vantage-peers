#!/usr/bin/env python3
"""Reap git worktrees whose work has LANDED — and never, ever one that hasn't.

Day 128: the VPS disk hit 100%. Worktrees accumulate because nothing removes them,
and one of them was 827 MB on its own.

WHY THE OBVIOUS CHECK IS THE BROKEN ONE
---------------------------------------
`git branch --merged main` — the reflex — answers "no" for EVERY squash-merged
branch, because a squash rewrites the commit and the original SHA is never an
ancestor of main. Measured on this repo: four worktrees, two of them belonging to
PRs that are demonstrably MERGED, and git ancestry reports "not merged" for all
four. A reaper built on that signal reaps NOTHING, forever, while reporting that it
looked. The disk fills, and the sensor says everything is fine.

So the signal is the PR STATE (`gh pr view --json state`), which is the thing that
actually decides whether the work landed. Ancestry is a proxy, and the proxy is
wrong precisely where we merge.

THE DIRECTION OF THE SAFE DEFAULT
---------------------------------
This tool DELETES. For a deleter, the safe failure is to delete NOTHING.

So every uncertainty resolves to KEEP:
  - PR state cannot be determined (gh fails, no network, no PR)  -> KEEP, say so
  - PR is OPEN or DRAFT                                          -> KEEP
  - working tree is dirty                                        -> KEEP, say so
  - commits exist that were never pushed                         -> KEEP, say so
  - the worktree is the one we are running in                    -> KEEP

"I could not determine whether this landed" and "this is safe to delete" must never
produce the same action. That equivalence is what costs people their work — and an
unpushed commit lives in exactly one place on earth.

DRY RUN IS THE DEFAULT. Deleting requires --yes, explicitly.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Verdict:
    path: Path
    branch: str
    reap: bool
    reason: str
    size_kb: int = 0


def _run(args: list[str], cwd: Path | None = None) -> tuple[int, str]:
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "").strip()


def list_worktrees(repo: Path) -> list[tuple[Path, str]]:
    rc, out = _run(["git", "worktree", "list", "--porcelain"], cwd=repo)
    if rc != 0:
        raise RuntimeError("`git worktree list` failed — refusing to guess at the inventory")
    entries: list[tuple[Path, str]] = []
    path: Path | None = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            path = Path(line[len("worktree ") :])
        elif line.startswith("branch ") and path is not None:
            entries.append((path, line[len("branch refs/heads/") :]))
            path = None
    return entries


def pr_state(branch: str, repo: Path) -> str | None:
    """MERGED / CLOSED / OPEN, or None when it cannot be established.

    None is NOT "no PR, therefore junk". None means UNKNOWN, and unknown keeps.
    """
    rc, out = _run(
        ["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "state", "--limit", "1"],
        cwd=repo,
    )
    if rc != 0:
        return None
    try:
        rows = json.loads(out or "[]")
    except json.JSONDecodeError:
        return None
    if not rows:
        return None
    return str(rows[0].get("state") or "").upper() or None


def is_dirty(wt: Path) -> bool | None:
    rc, out = _run(["git", "status", "--porcelain"], cwd=wt)
    if rc != 0:
        return None  # unknown -> caller keeps
    return bool(out.strip())


def has_unpushed(wt: Path) -> bool | None:
    rc, _ = _run(["git", "rev-parse", "--abbrev-ref", "@{u}"], cwd=wt)
    if rc != 0:
        return True  # no upstream at all: the commits exist HERE and nowhere else
    rc, out = _run(["git", "log", "--oneline", "@{u}..HEAD"], cwd=wt)
    if rc != 0:
        return None
    return bool(out.strip())


def size_kb(path: Path) -> int:
    rc, out = _run(["du", "-sk", str(path)])
    if rc != 0:
        return 0
    try:
        return int(out.split()[0])
    except (ValueError, IndexError):
        return 0


def judge(wt: Path, branch: str, repo: Path, self_path: Path) -> Verdict:
    kb = size_kb(wt)

    if wt.resolve() == self_path.resolve():
        return Verdict(wt, branch, False, "KEEP — this is the worktree we are running in", kb)

    dirty = is_dirty(wt)
    if dirty is None:
        return Verdict(wt, branch, False, "KEEP — could not read its status; unknown is not safe", kb)
    if dirty:
        return Verdict(wt, branch, False, "KEEP — uncommitted changes", kb)

    unpushed = has_unpushed(wt)
    if unpushed is None:
        return Verdict(wt, branch, False, "KEEP — could not compare against upstream; unknown is not safe", kb)
    if unpushed:
        return Verdict(wt, branch, False, "KEEP — commits exist here and NOWHERE else", kb)

    state = pr_state(branch, repo)
    if state is None:
        return Verdict(wt, branch, False, "KEEP — no PR state resolved; 'I could not tell' is not 'safe to delete'", kb)
    if state in {"MERGED", "CLOSED"}:
        return Verdict(wt, branch, True, f"REAP — PR is {state}; the work landed (or was abandoned) and is not here alone", kb)
    return Verdict(wt, branch, False, f"KEEP — PR is {state}", kb)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".", help="repo root (default: cwd)")
    ap.add_argument("--yes", action="store_true", help="actually remove. Without it, this only reports.")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    self_path = Path.cwd()

    try:
        entries = list_worktrees(repo)
    except RuntimeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2

    verdicts = [judge(wt, br, repo, self_path) for wt, br in entries]

    width = max((len(v.branch) for v in verdicts), default=10)
    reclaim = 0
    for v in sorted(verdicts, key=lambda x: (not x.reap, -x.size_kb)):
        mark = "REAP" if v.reap else "keep"
        print(f"[{mark}] {v.branch:<{width}}  {v.size_kb/1024:8.1f} MB  {v.reason}")
        if v.reap:
            reclaim += v.size_kb

    print()
    n = sum(1 for v in verdicts if v.reap)
    print(f"{n} of {len(verdicts)} worktree(s) reapable — {reclaim/1024:.1f} MB")

    if not args.yes:
        print("DRY RUN. Nothing was removed. Pass --yes to act.")
        return 0

    for v in verdicts:
        if not v.reap:
            continue
        rc, out = _run(["git", "worktree", "remove", str(v.path)], cwd=repo)
        if rc != 0:
            # Loudly. A removal that half-failed must not be reported as done.
            print(f"FAILED to remove {v.path}: {out}", file=sys.stderr)
            return 1
        print(f"removed {v.path}")
    _run(["git", "worktree", "prune"], cwd=repo)
    return 0


if __name__ == "__main__":
    sys.exit(main())
