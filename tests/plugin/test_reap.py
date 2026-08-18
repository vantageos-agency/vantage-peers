"""The two coverage holes that made the previous reaper blind, closed by probe.

Both were found the hard way, on a shared host at 90% disk, by a sweep that
reported a clean bill over 71 repositories and was wrong about eleven of them.

HOLE 1 — the upstream probe. `git log @{u}..HEAD` exits non-zero and prints
NOTHING on a branch with no upstream. Thirty of those seventy-one repositories
were in exactly that state, so the command that was supposed to answer "does
this hold work that exists nowhere else" answered "no" for every one of them.
An absence of output was read as an absence of risk.

HOLE 2 — the enumeration. A registered worktree carries a `.git` FILE, not a
`.git` directory. A sweep built on `find -name .git -type d` cannot see one, and
misses it in silence rather than failing.

Every fixture below is a REAL git repository built by this module, and every
assertion is made against the tool's own functions rather than a re-implementation
of them. The negative pole matters as much as the positive one: a probe that
flags everything is as useless as one that flags nothing, and it gets disabled
in a week.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from reap import (  # noqa: E402
    enumerate_repositories,
    holds_unreachable_commits,
    old_upstream_probe_says_clean,
)


def _git(*args: str, cwd: Path) -> str:
    p = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=False
    )
    return (p.stdout or "") + (p.stderr or "")


def _init(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    _git("init", "-q", cwd=path)
    _git("config", "user.email", "probe@example.invalid", cwd=path)
    _git("config", "user.name", "probe", cwd=path)
    return path


def _commit(path: Path, name: str) -> None:
    (path / name).write_text(name, encoding="utf-8")
    _git("add", "-A", cwd=path)
    _git("commit", "-qm", name, cwd=path)


@pytest.fixture()
def origin(tmp_path: Path) -> Path:
    """A repository that plays the part of the remote — its own history is safe."""
    o = _init(tmp_path / "origin")
    _commit(o, "landed")
    _git("branch", "-M", "main", cwd=o)
    return o


# --------------------------------------------------------------------------
# HOLE 1 — the upstream probe
# --------------------------------------------------------------------------


def test_no_remote_at_all_is_flagged(tmp_path: Path) -> None:
    """A clone with no remote holds its entire history in one place on earth."""
    lone = _init(tmp_path / "lone")
    _commit(lone, "only-copy")

    assert _git("remote", cwd=lone).strip() == "", "fixture must have no remote"
    assert holds_unreachable_commits(lone) is True


def test_unpushed_commit_is_flagged_where_the_old_probe_was_silent(
    origin: Path, tmp_path: Path
) -> None:
    """The founding defect, reproduced end to end.

    The clone carries one commit that reached no remote, on a branch with no
    upstream — the shape thirty of seventy-one measured repositories were in.
    The new probe must flag it AND the old one must be shown saying "clean",
    because a fix whose predecessor is not shown failing proves nothing.
    """
    clone = tmp_path / "clone"
    _git("clone", "-q", str(origin), str(clone), cwd=tmp_path)
    _git("config", "user.email", "probe@example.invalid", cwd=clone)
    _git("config", "user.name", "probe", cwd=clone)
    _git("checkout", "-q", "-b", "local-only", cwd=clone)
    _commit(clone, "never-pushed")

    # The mutation landed: the commit exists and no remote-tracking ref holds it.
    reachable = _git("log", "--oneline", "HEAD", "--not", "--remotes", cwd=clone)
    assert "never-pushed" in reachable, "the unpushed commit was not created"

    assert holds_unreachable_commits(clone) is True
    assert old_upstream_probe_says_clean(clone) is True, (
        "the old probe must be demonstrated blind here — if it ever reports the "
        "risk, this test is no longer proving what it claims to prove"
    )


def test_clean_clone_is_not_flagged(origin: Path, tmp_path: Path) -> None:
    """The negative pole. A probe that flags everything gets torn out."""
    clone = tmp_path / "clean"
    _git("clone", "-q", str(origin), str(clone), cwd=tmp_path)

    assert holds_unreachable_commits(clone) is False


def test_unreadable_target_refuses_to_judge(tmp_path: Path) -> None:
    """Not a repository at all: the answer is "I could not tell", never "clean"."""
    plain = tmp_path / "not-a-repo"
    plain.mkdir()

    assert holds_unreachable_commits(plain) is None


# --------------------------------------------------------------------------
# HOLE 2 — the enumeration
# --------------------------------------------------------------------------


def test_enumeration_finds_a_worktree_whose_dotgit_is_a_file(
    origin: Path, tmp_path: Path
) -> None:
    """A registered worktree carries a `.git` FILE. The old sweep walked only
    directories and missed four of them without a word."""
    root = tmp_path / "root"
    root.mkdir()
    main = root / "main"
    _git("clone", "-q", str(origin), str(main), cwd=tmp_path)
    Path(main).rename(root / "main")

    wt = root / "side"
    _git("worktree", "add", "-q", "-b", "side", str(wt), cwd=root / "main")

    dotgit = wt / ".git"
    assert dotgit.is_file(), "fixture must produce a .git FILE, not a directory"

    found = {p.resolve() for p in enumerate_repositories(root)}
    assert wt.resolve() in found, "the worktree form was missed"
    assert (root / "main").resolve() in found, "the ordinary form was missed"

    # And the old form is shown missing it, so the difference is on the record.
    dirs_only = {
        p.parent.resolve()
        for p in root.rglob(".git")
        if p.is_dir()
    }
    assert wt.resolve() not in dirs_only
