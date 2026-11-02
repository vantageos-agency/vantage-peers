"""`.claude/scripts/reap-worktree.sh` — the standalone-clone case, both poles.

A standalone clone directly under /tmp (its own .git, in no worktree list) is
reaped only when the script itself proves there is nothing to lose: clean tree,
no untracked file, a fresh fetch succeeded, HEAD and every local branch tip on
an origin branch, nothing stashed. Everything else is REFUSED, and the
pre-existing perimeter (registered worktree reaped, own checkout refused) is
unchanged.

Every fixture lives in a throwaway root created under /tmp by
`TemporaryDirectory` (removed on exit) and injected as REAP_STANDALONE_ROOT.
The "origin" is a bare repository inside that root, so no test touches the
network or a real leftover. `gh` is shadowed on PATH by a stub that fails, so
the pre-existing branch can never reach GitHub from here either.

The injected root can only NARROW: the script refuses any REAP_STANDALONE_ROOT
whose realpath is not /tmp or under it (pinned below).
"""
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "reap-worktree.sh"


def _git(*args, cwd, env):
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, check=True,
        capture_output=True, text=True, timeout=60,
    ).stdout.strip()


@pytest.fixture
def world():
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="reap-standalone-test-") as d:
        root = Path(d)
        stub = root / "stub-bin"
        stub.mkdir()
        gh = stub / "gh"
        gh.write_text("#!/bin/sh\necho 'gh stubbed out by test' >&2\nexit 1\n")
        gh.chmod(0o755)
        env = dict(
            os.environ,
            PATH=f"{stub}:{os.environ['PATH']}",
            GIT_CONFIG_NOSYSTEM="1",
            GIT_CONFIG_GLOBAL="/dev/null",
            GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
            GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid",
            GIT_TERMINAL_PROMPT="0",
            REAP_STANDALONE_ROOT=str(root),
        )
        env.pop("GIT_DIR", None)
        env.pop("GIT_WORK_TREE", None)

        origin = root / "origin.git"
        seed = root / "seed"
        _git("init", "-q", "--bare", "-b", "main", str(origin), cwd=root, env=env)
        _git("init", "-q", "-b", "main", str(seed), cwd=root, env=env)
        (seed / "README").write_text("seed\n")
        _git("add", "README", cwd=seed, env=env)
        _git("commit", "-q", "-m", "seed", cwd=seed, env=env)
        _git("remote", "add", "origin", str(origin), cwd=seed, env=env)
        _git("push", "-q", "origin", "main", cwd=seed, env=env)

        caller = root / "caller"
        _git("clone", "-q", str(origin), str(caller), cwd=root, env=env)

        def clone(name):
            path = root / name
            _git("clone", "-q", str(origin), str(path), cwd=root, env=env)
            return path

        def reap(target, cwd=None, extra_env=None):
            e = dict(env, **(extra_env or {}))
            return subprocess.run(
                ["bash", str(SCRIPT), str(target)], cwd=cwd or caller, env=e,
                capture_output=True, text=True, timeout=180,
            )

        yield {"root": root, "origin": origin, "caller": caller, "env": env,
               "clone": clone, "reap": reap}


def _refused(proc, needle):
    assert proc.returncode == 2, (proc.returncode, proc.stdout, proc.stderr)
    assert "REFUSED:" in proc.stderr, proc.stderr
    assert needle in proc.stderr, proc.stderr
    assert "REAPED" not in proc.stdout


# ---- ACCEPT pole -----------------------------------------------------------

def test_clean_pushed_standalone_clone_is_reaped_and_gone(world):
    path = world["clone"]("clean")
    proc = world["reap"](path)
    assert proc.returncode == 0, proc.stderr
    assert not path.exists()
    assert proc.stdout.startswith(f"REAPED {path} (was ")
    assert "avail KiB" in proc.stdout
    assert ("perimeter: a clean standalone clone under "
            f"{world['root']} whose content is on origin") in proc.stderr


def test_trailing_slash_is_the_same_path(world):
    path = world["clone"]("slashed")
    proc = world["reap"](f"{path}/")
    assert proc.returncode == 0, proc.stderr
    assert not path.exists()


# ---- REFUSE pole: content that would be lost -------------------------------

def test_dirty_tracked_file_is_refused(world):
    path = world["clone"]("dirty")
    (path / "README").write_text("changed\n")
    _refused(world["reap"](path), "changed or untracked file(s)")
    assert path.exists()


def test_untracked_file_is_refused(world):
    path = world["clone"]("untracked")
    (path / "sub").mkdir()
    (path / "sub" / "new.txt").write_text("x\n")
    _refused(world["reap"](path), "changed or untracked file(s)")
    assert path.exists()


def test_head_on_no_origin_branch_is_refused(world):
    path = world["clone"]("unpushed")
    (path / "README").write_text("local\n")
    _git("commit", "-qam", "local only", cwd=path, env=world["env"])
    _refused(world["reap"](path), "is on no origin branch")
    assert path.exists()


def test_stash_entry_is_refused(world):
    path = world["clone"]("stashed")
    (path / "README").write_text("stash me\n")
    _git("stash", "push", "-q", "-m", "keep", cwd=path, env=world["env"])
    _refused(world["reap"](path), "stash entr")
    assert path.exists()


def test_extra_local_branch_with_unpushed_commits_is_refused(world):
    path = world["clone"]("sidebranch")
    env = world["env"]
    _git("checkout", "-q", "-b", "feature", cwd=path, env=env)
    (path / "f.txt").write_text("f\n")
    _git("add", "f.txt", cwd=path, env=env)
    _git("commit", "-qm", "feature work", cwd=path, env=env)
    _git("checkout", "-q", "main", cwd=path, env=env)
    _refused(world["reap"](path), "local branch feature")
    assert path.exists()


def test_fetch_failure_is_refused_never_a_pass(world):
    path = world["clone"]("nofetch")
    world["origin"].rename(world["root"] / "origin-gone.git")
    _refused(world["reap"](path), "git fetch --prune origin failed")
    assert path.exists()


def test_clone_with_its_own_linked_worktree_is_refused(world):
    path = world["clone"]("haswt")
    _git("worktree", "add", "-q", "--detach", str(world["root"] / "haswt-wt"),
         cwd=path, env=world["env"])
    _refused(world["reap"](path), "linked worktree(s) of its own")
    assert path.exists()


def test_worktree_of_another_repository_is_refused(world):
    other = world["clone"]("other")
    wt = world["root"] / "other-wt"
    _git("worktree", "add", "-q", "--detach", str(wt), cwd=other, env=world["env"])
    _refused(world["reap"](wt), "no .git directory of its own")
    assert wt.exists()


def test_plain_directory_is_refused(world):
    plain = world["root"] / "plain"
    plain.mkdir()
    _refused(world["reap"](plain), "no .git directory of its own")
    assert plain.exists()


# ---- REFUSE pole: the path itself ------------------------------------------

def test_path_outside_the_root_is_refused(world):
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="reap-outside-") as d:
        outside = Path(d) / "c"
        _git("clone", "-q", str(world["origin"]), str(outside),
             cwd=world["root"], env=world["env"])
        _refused(world["reap"](outside), "outside this station's perimeter")
        assert outside.exists()


def test_nested_path_under_the_root_is_refused(world):
    nested_parent = world["root"] / "deeper"
    nested_parent.mkdir()
    nested = nested_parent / "c"
    _git("clone", "-q", str(world["origin"]), str(nested),
         cwd=world["root"], env=world["env"])
    _refused(world["reap"](nested), "nested path")
    assert nested.exists()


def test_the_root_itself_is_refused(world):
    _refused(world["reap"](world["root"]), "refusing the standalone root itself")
    assert world["root"].exists()


def test_literal_tmp_is_refused_with_the_production_root(world):
    env = {"REAP_STANDALONE_ROOT": ""}
    proc = world["reap"]("/tmp", extra_env=env)
    _refused(proc, "refusing the standalone root itself: /tmp")


def test_symlink_is_refused_and_its_target_survives(world):
    path = world["clone"]("real-clone")
    link = world["root"] / "link"
    link.symlink_to(path)
    _refused(world["reap"](link), "refusing a symlink")
    assert path.exists() and link.is_symlink()


def test_traversal_path_is_refused(world):
    path = world["clone"]("trav")
    _refused(world["reap"](f"{path}/../trav"), "traversing path")
    assert path.exists()


# ---- The injected root can only narrow -------------------------------------

@pytest.mark.parametrize("bad_root", ["/", "/root", "/usr"])
def test_root_outside_tmp_is_refused(world, bad_root):
    # The refusal must be the ROOT check itself, not a later path mismatch.
    path = world["clone"]("narrow")
    proc = world["reap"](path, extra_env={"REAP_STANDALONE_ROOT": bad_root})
    _refused(proc, "the root can only narrow")
    assert path.exists()


def test_traversing_root_is_refused(world):
    path = world["clone"]("narrow2")
    proc = world["reap"](path, extra_env={"REAP_STANDALONE_ROOT": "/tmp/../root"})
    _refused(proc, "traversing standalone root")
    assert path.exists()


# ---- The pre-existing perimeter is unchanged -------------------------------

def test_registered_worktree_is_still_reaped_through_the_existing_branch(world):
    wt = world["root"] / "caller-wt"
    _git("worktree", "add", "-q", "--detach", str(wt), "origin/main",
         cwd=world["caller"], env=world["env"])
    proc = world["reap"](wt)
    assert proc.returncode == 0, proc.stderr
    assert not wt.exists()
    assert "perimeter: a registered worktree of caller" in proc.stderr
    assert "standalone clone" not in proc.stderr


def test_callers_own_checkout_is_still_refused(world):
    _refused(world["reap"](world["caller"]), "refusing this station's own checkout")
    assert world["caller"].exists()
