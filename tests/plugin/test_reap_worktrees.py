"""The reaper DELETES work. Every guard it has is a fear I wrote down — and none of them
had a test. That is not commendable transparency; it is an incomplete delivery, and on a
destructive tool it is the one case where the price is irreversible.

Eta, PR #1095, quoting my own rule back at me: a fear the author names must ALREADY have
its test in the diff. I wrote "unknown is not safe", "an unpushed commit lives in exactly
one place on earth", "'I could not tell' is not 'safe to delete'" — three fears, stated
precisely, guarded by nothing.

The four guards behaved correctly in his sandbox. Nothing holds them there. The next hand
to touch `is_dirty()` or `has_unpushed()` meets no resistance, and the failure makes NO
NOISE: it destroys a file that existed in exactly one place on earth.

BIPOLAR, and the second pole is not optional: a reaper that reaps NOTHING scores perfectly
on a keep-only probe. Test 4 is what stops "never delete anything" from passing as safety.
"""

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import reap_worktrees as reaper  # noqa: E402


def git(repo: Path, *args: str) -> str:
    p = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True)
    return p.stdout.strip()


@pytest.fixture
def sandbox(tmp_path):
    """A real git repo with a real remote and a real worktree. No mocks: the reaper's whole
    job is to read git and gh correctly, and a mock would only prove it reads my mock."""
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)

    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    git(repo, "config", "user.email", "t@t.t")
    git(repo, "config", "user.name", "t")
    git(repo, "remote", "add", "origin", str(remote))
    (repo / "README.md").write_text("x\n", encoding="utf-8")
    git(repo, "add", "README.md")
    git(repo, "commit", "-qm", "init")
    git(repo, "branch", "-M", "main")
    git(repo, "push", "-q", "-u", "origin", "main")
    return repo


def make_worktree(repo: Path, branch: str, *, push: bool, dirty: bool) -> Path:
    wt = repo.parent / branch.replace("/", "-")
    git(repo, "worktree", "add", "-q", "-b", branch, str(wt))
    (wt / "work.txt").write_text("landed\n", encoding="utf-8")
    git(wt, "add", "work.txt")
    git(wt, "commit", "-qm", "work")
    if push:
        git(wt, "push", "-q", "-u", "origin", branch)
    if dirty:
        (wt / "uncommitted.txt").write_text("EXISTS ONLY HERE\n", encoding="utf-8")
    return wt


def judge(wt: Path, branch: str, repo: Path, pr_state, monkeypatch):
    """Judge with the PR state forced — `gh` is not reachable from a sandbox, and the PR
    state is an INPUT to the decision, not the thing under test."""
    monkeypatch.setattr(reaper, "pr_state", lambda b, r: pr_state)
    return reaper.judge(wt, branch, repo, self_path=repo)


# ─── KEEP: the four fears I wrote down ───────────────────────────────────────

def test_merged_but_DIRTY_is_kept_and_the_file_survives(sandbox, monkeypatch):
    """The fear: uncommitted work destroyed because the PR happened to be merged.
    Asserted ON DISK, not on the report — a tool that says "kept" and deletes anyway
    would pass a report-only assertion."""
    wt = make_worktree(sandbox, "feat/merged-dirty", push=True, dirty=True)
    v = judge(wt, "feat/merged-dirty", sandbox, "MERGED", monkeypatch)

    assert not v.reap, f"MERGED+dirty was marked reapable: {v.reason}"
    assert "uncommitted" in v.reason.lower()
    assert (wt / "uncommitted.txt").is_file(), (
        "the uncommitted file is GONE. A reaper that deletes what exists nowhere else is "
        "not a cleanup tool, it is data loss with a progress bar."
    )


def test_merged_but_UNPUSHED_is_kept(sandbox, monkeypatch):
    """The fear I wrote as: an unpushed commit lives in exactly one place on earth."""
    wt = make_worktree(sandbox, "feat/merged-unpushed", push=False, dirty=False)
    v = judge(wt, "feat/merged-unpushed", sandbox, "MERGED", monkeypatch)

    assert not v.reap, f"a worktree whose commits exist NOWHERE ELSE was reaped: {v.reason}"
    assert "nowhere else" in v.reason.lower()


def test_unresolvable_pr_state_is_kept_AND_SAID(sandbox, monkeypatch):
    """The fear: 'I could not tell whether this landed' silently becoming 'safe to delete'.

    It must keep, AND it must say why — a keep with no reason is indistinguishable from a
    keep by luck, and the next maintainer cannot tell them apart."""
    wt = make_worktree(sandbox, "feat/unknown", push=True, dirty=False)
    v = judge(wt, "feat/unknown", sandbox, None, monkeypatch)

    assert not v.reap, "unresolved PR state was treated as permission to delete"
    assert "could not" in v.reason.lower() or "no PR state" in v.reason, (
        f"it kept, but did not SAY it could not tell: {v.reason!r}"
    )


def test_open_pr_is_kept(sandbox, monkeypatch):
    wt = make_worktree(sandbox, "feat/open", push=True, dirty=False)
    v = judge(wt, "feat/open", sandbox, "OPEN", monkeypatch)
    assert not v.reap, f"a worktree with an OPEN PR was reaped: {v.reason}"


# ─── REAP: the pole without which "never delete" would score perfectly ────────

def test_merged_clean_and_pushed_IS_reaped(sandbox, monkeypatch):
    """Without this, a reaper that reaps NOTHING passes every test above.

    'Safe' and 'useless' are different properties, and a probe with one pole cannot tell
    them apart — which is the same single-pole blindness this repo has spent the day
    closing everywhere else."""
    wt = make_worktree(sandbox, "feat/merged-clean", push=True, dirty=False)
    v = judge(wt, "feat/merged-clean", sandbox, "MERGED", monkeypatch)

    assert v.reap, (
        f"a MERGED, clean, fully-pushed worktree was NOT reaped: {v.reason}. "
        "A reaper that never reaps is not safe, it is broken — and it fills the disk "
        "while reporting that it looked."
    )


# ─── The default must be inert, and proven inert ON DISK ─────────────────────

def test_default_is_dry_run_and_nothing_is_removed_on_disk(sandbox, monkeypatch):
    """Asserted on the FILESYSTEM, not on stdout. A tool that prints 'DRY RUN' and deletes
    anyway satisfies every output-based assertion ever written."""
    wt = make_worktree(sandbox, "feat/merged-clean-2", push=True, dirty=False)
    monkeypatch.setattr(reaper, "pr_state", lambda b, r: "MERGED")
    monkeypatch.setattr(sys, "argv", ["reap_worktrees.py", "--repo", str(sandbox)])

    rc = reaper.main()

    assert rc == 0
    assert wt.is_dir(), (
        "the worktree was REMOVED without --yes. The default of a destructive tool must "
        "be inert, and 'inert' is a property of the disk, not of the log."
    )
