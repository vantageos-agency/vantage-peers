#!/usr/bin/env python3
"""Reap what has landed — worktrees and session scratchpads — and never one that hasn't.

This is the single shared reaper. It replaces `reap_worktrees.py`, which existed
twice, byte-identical, in two repositories: two copies of one thing means one of
them silently wins and nobody knows which.

WHY THE OBVIOUS CHECKS ARE THE BROKEN ONES
------------------------------------------
Three reflexes, three silent failures, all three measured rather than argued:

1. `git branch --merged main` answers "no" for every SQUASH-merged branch — a
   squash rewrites the commit, so the original SHA is never an ancestor. Measured:
   four worktrees, two belonging to demonstrably merged pull requests, ancestry
   reported "not merged" for all four. A reaper built on that signal reaps
   nothing, forever, while reporting that it looked. The signal is the pull
   request STATE, which is the thing that actually decides whether work landed.

2. `git log @{u}..HEAD` exits non-zero and prints NOTHING on a branch with no
   upstream. Measured on a shared host: 30 of 71 repositories were in exactly
   that state, so the command meant to answer "does this hold work that exists
   nowhere else" answered "no" for all of them. Eleven genuinely held such work.
   An absence of output was read as an absence of risk. The replacement is two
   commands: `git remote` (a clone with no remote at all holds its whole history
   in one place) and `git log HEAD --not --remotes` (commits reachable from no
   remote-tracking ref, upstream configured or not).

3. `find -name .git -type d` cannot see a registered worktree, whose `.git` is a
   FILE. Measured: four missed, in silence. Both forms are enumerated here.

THE DIRECTION OF THE SAFE DEFAULT
---------------------------------
This tool DELETES. For a deleter, the safe failure is to delete NOTHING, so every
uncertainty resolves to KEEP, and says so:

  - pull request state cannot be established        -> KEEP
  - pull request is OPEN or DRAFT                   -> KEEP
  - the working tree is dirty                       -> KEEP
  - commits exist that reach no remote              -> KEEP
  - the target cannot be read at all                -> KEEP
  - it is the tree we are running in                -> KEEP

"I could not determine whether this landed" and "this is safe to delete" must
never produce the same action, because an unpushed commit lives in exactly one
place on earth.

ARCHIVES ARE PROVEN BY RECOVERABILITY, NOT BY VERIFY
----------------------------------------------------
`git bundle verify` needs the bundle's prerequisite commits, and for a bundle
written as `--not --remotes` those prerequisites live in the very directory about
to be deleted. It therefore reports failure exactly when it matters — after the
deletion it was supposed to authorise. The proof used here is a restoration:
clone the origin afresh, unbundle into it, and read the head back.

DRY RUN IS THE DEFAULT. Deleting requires --yes, explicitly.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# A fixed-size read of the adjacency of a session directory: anything modified
# inside this window belongs to a session that may still be running, and is never
# a candidate. Twelve hours in seconds.
# allow-time-estimate: a filter parameter, not an effort estimate.
LIVE_WINDOW_SECONDS = 12 * 60 * 60


@dataclass
class Verdict:
    path: Path
    label: str
    reap: bool
    reason: str
    size_kb: int = 0


def _run(args: list[str], cwd: Path | None = None) -> tuple[int, str]:
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "").strip()


# ---------------------------------------------------------------------------
# Enumeration — both forms of `.git`
# ---------------------------------------------------------------------------


def enumerate_repositories(root: Path) -> list[Path]:
    """Every repository under `root`, whether its `.git` is a directory or a file.

    The FILE form is a registered worktree. A sweep that walks only directories
    misses it without a word, which is how four of them survived a clean bill.
    """
    found: list[Path] = []
    for entry in root.rglob(".git"):
        if entry.is_dir() or entry.is_file():
            found.append(entry.parent)
    return sorted(set(found))


# ---------------------------------------------------------------------------
# The safety probe — three states, never two
# ---------------------------------------------------------------------------


def holds_unreachable_commits(path: Path) -> bool | None:
    """True when work here reaches no remote; False when everything reaches one.

    None means the question could not be answered — not a repository, or git
    refused. None is NEVER "clean": the caller keeps.
    """
    rc, _ = _run(["git", "rev-parse", "--git-dir"], cwd=path)
    if rc != 0:
        return None

    rc, remotes = _run(["git", "remote"], cwd=path)
    if rc != 0:
        return None
    if not remotes.strip():
        # No remote at all: the entire history exists here and nowhere else.
        return True

    rc, out = _run(["git", "log", "--oneline", "HEAD", "--not", "--remotes"], cwd=path)
    if rc != 0:
        return None
    return bool(out.strip())


def old_upstream_probe_says_clean(path: Path) -> bool:
    """The blind form, kept ONLY so a probe can demonstrate it going quiet.

    Nothing in this module decides anything on it. It exists because a fix whose
    predecessor is never shown failing proves nothing, and because the next
    person to reach for `@{u}` should find it here, named, with its verdict
    already written.
    """
    rc, out = _run(["git", "log", "--oneline", "@{u}..HEAD"], cwd=path)
    return rc != 0 or not out.strip()


# ---------------------------------------------------------------------------
# Archiving — proven by restoration
# ---------------------------------------------------------------------------


def bundle(path: Path, out_file: Path) -> tuple[bool, str]:
    """Write every commit that reaches no remote into a bundle."""
    out_file.parent.mkdir(parents=True, exist_ok=True)
    rc, remotes = _run(["git", "remote"], cwd=path)
    if rc != 0:
        return False, "could not read the remote list"
    if not remotes.strip():
        rc, out = _run(["git", "bundle", "create", str(out_file), "--all"], cwd=path)
    else:
        rc, out = _run(
            ["git", "bundle", "create", str(out_file), "HEAD", "--not", "--remotes"],
            cwd=path,
        )
    return rc == 0, out


def restoration_proves(bundle_file: Path, origin: str, head: str, scratch: Path) -> bool:
    """The only archive proof that survives the deletion it authorises.

    Clone the origin afresh, unbundle into that clone, read the head back. A
    bundle written `--not --remotes` cannot be verified in place once its source
    directory is gone, because its prerequisites went with it.
    """
    target = scratch / "restore-probe"
    rc, _ = _run(["git", "clone", "-q", "--filter=blob:none", origin, str(target)])
    if rc != 0:
        return False
    rc, _ = _run(["git", "bundle", "unbundle", str(bundle_file)], cwd=target)
    if rc != 0:
        return False
    rc, _ = _run(["git", "cat-file", "-e", f"{head}^{{commit}}"], cwd=target)
    return rc == 0


# ---------------------------------------------------------------------------
# Worktrees — the pull request state is the landed signal
# ---------------------------------------------------------------------------


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

    None is NOT "no pull request, therefore junk". None means unknown, and
    unknown keeps.
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


def is_dirty(path: Path) -> bool | None:
    rc, out = _run(["git", "status", "--porcelain"], cwd=path)
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


def judge_worktree(wt: Path, branch: str, repo: Path, here: Path) -> Verdict:
    kb = size_kb(wt)

    if wt.resolve() == here.resolve():
        return Verdict(wt, branch, False, "KEEP — this is the tree we are running in", kb)

    dirty = is_dirty(wt)
    if dirty is None:
        return Verdict(wt, branch, False, "KEEP — could not read its status; unknown is not safe", kb)
    if dirty:
        return Verdict(wt, branch, False, "KEEP — uncommitted changes", kb)

    unreachable = holds_unreachable_commits(wt)
    if unreachable is None:
        return Verdict(wt, branch, False, "KEEP — could not establish what reaches a remote", kb)
    if unreachable:
        return Verdict(wt, branch, False, "KEEP — commits exist here and reach no remote", kb)

    state = pr_state(branch, repo)
    if state is None:
        return Verdict(wt, branch, False, "KEEP — no pull request state resolved", kb)
    if state in {"MERGED", "CLOSED"}:
        return Verdict(wt, branch, True, f"REAP — pull request is {state}; the work is not here alone", kb)
    return Verdict(wt, branch, False, f"KEEP — pull request is {state}", kb)


# ---------------------------------------------------------------------------
# Session scratchpads — the root is derived, never typed
# ---------------------------------------------------------------------------


def scratchpad_root(working_dir: Path, base: Path = Path("/tmp/claude-1001")) -> Path:
    """The station's own scratchpad root, derived from where it is running.

    A path typed from memory is how a station reaps a neighbour's tree.
    """
    return base / str(working_dir).replace("/", "-")


def is_live(session_dir: Path, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    try:
        return (now - session_dir.stat().st_mtime) < LIVE_WINDOW_SECONDS
    except OSError:
        # Cannot read it -> treat as live. Unknown never authorises a deletion.
        return True


def judge_session(session_dir: Path, here: Path) -> Verdict:
    kb = size_kb(session_dir)

    if here.resolve() == session_dir.resolve() or session_dir.resolve() in here.resolve().parents:
        return Verdict(session_dir, session_dir.name, False, "KEEP — our own session", kb)
    if is_live(session_dir):
        return Verdict(session_dir, session_dir.name, False, "KEEP — modified inside the live window", kb)

    for repo in enumerate_repositories(session_dir):
        unreachable = holds_unreachable_commits(repo)
        if unreachable is None:
            return Verdict(
                session_dir, session_dir.name, False,
                f"KEEP — could not read {repo.name}; unknown is not safe", kb,
            )
        if unreachable:
            return Verdict(
                session_dir, session_dir.name, False,
                f"KEEP — {repo.name} holds commits that reach no remote; archive it first", kb,
            )

    return Verdict(session_dir, session_dir.name, True, "REAP — dead session, nothing unreachable", kb)


# ---------------------------------------------------------------------------
# Removal — one named action, one path, no chaining
# ---------------------------------------------------------------------------


def remove(path: Path, allowed_roots: list[Path]) -> tuple[int, str]:
    """Exit 0 removed, 1 refused (outside every allowed root), 2 could not judge."""
    script = Path(__file__).resolve().parent / "sandbox-rm.sh"
    if not script.is_file():
        return 2, f"REFUSING TO JUDGE: the removal primitive is missing at {script}"
    env = dict(os.environ)
    env["SANDBOX_RM_ROOTS"] = ":".join(str(r) for r in allowed_roots)
    p = subprocess.run([str(script), str(path)], capture_output=True, text=True, env=env)
    return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()


# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--repo", default=".", help="repo root for the worktree pass (default: cwd)")
    ap.add_argument(
        "--scope",
        choices=["worktrees", "scratchpads", "both"],
        default="both",
        help="what to sweep (default: both)",
    )
    ap.add_argument("--yes", action="store_true", help="actually remove. Without it, this only reports.")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    here = Path.cwd()
    verdicts: list[Verdict] = []
    examined = 0
    excluded = 0

    if args.scope in {"worktrees", "both"}:
        try:
            for wt, branch in list_worktrees(repo):
                verdicts.append(judge_worktree(wt, branch, repo, here))
                examined += 1
        except RuntimeError as exc:
            print(f"REFUSING TO JUDGE: {exc}", file=sys.stderr)
            print('"I could not check" and "this is clean" are different answers.', file=sys.stderr)
            return 2

    if args.scope in {"scratchpads", "both"}:
        root = scratchpad_root(here)
        if not root.is_dir():
            print(f"REFUSING TO JUDGE: derived scratchpad root {root} does not exist", file=sys.stderr)
            print('"I could not check" and "this is clean" are different answers.', file=sys.stderr)
            return 2
        for session in sorted(p for p in root.iterdir() if p.is_dir()):
            v = judge_session(session, here)
            verdicts.append(v)
            examined += 1
            if not v.reap:
                excluded += 1

    width = max((len(v.label) for v in verdicts), default=10)
    reclaim = 0
    for v in sorted(verdicts, key=lambda x: (not x.reap, -x.size_kb)):
        mark = "REAP" if v.reap else "keep"
        print(f"[{mark}] {v.label:<{width}}  {v.size_kb/1024:8.1f} MB  {v.reason}")
        if v.reap:
            reclaim += v.size_kb

    reapable = sum(1 for v in verdicts if v.reap)
    print()
    print(f"examined {examined} = kept {examined - reapable} + reapable {reapable}   ({reclaim/1024:.1f} MB)")
    print(f"live-window exclusion: modified within the last {LIVE_WINDOW_SECONDS} seconds")

    if not args.yes:
        print("DRY RUN. Nothing was removed. Pass --yes to act.")
        return 0

    removed = 0
    for v in verdicts:
        if not v.reap:
            continue
        rc, out = remove(v.path, [Path("/tmp"), Path(os.environ.get("TMPDIR", "/tmp"))])
        if rc != 0:
            print(f"FAILED to remove {v.path}: {out}", file=sys.stderr)
            return 1
        removed += 1
    _run(["git", "worktree", "prune"], cwd=repo)

    print(f"reconciled: examined {examined} = kept {examined - removed} + removed {removed}")
    if removed != reapable:
        print(
            f"REFUSING TO REPORT SUCCESS: {reapable} were reapable and {removed} were removed",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
