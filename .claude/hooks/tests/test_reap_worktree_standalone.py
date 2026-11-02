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
        # Fails unless a test configures $GH_STUB_DIR (see _gh_merged / _gh_fail). When
        # configured it answers `gh pr list --jq` with "<number> <headRefOid>" lines read
        # from <dir>/<repo basename>__<head branch>; an unknown repo or branch is an empty,
        # successful answer (no merged PR), a FAIL file makes every call exit 1.
        gh.write_text(
            "#!/bin/sh\n"
            'd=${GH_STUB_DIR:-}\n'
            "[ -d \"$d\" ] || { echo 'gh stubbed out by test' >&2; exit 1; }\n"
            "[ ! -e \"$d/FAIL\" ] || { echo 'gh failing by test' >&2; exit 1; }\n"
            "head=; repo=\n"
            "while [ $# -gt 0 ]; do\n"
            "  case $1 in --head) head=$2; shift ;; -R) repo=$2; shift ;; esac\n"
            "  shift\n"
            "done\n"
            "f=\"$d/$(basename \"$repo\")__$(echo \"$head\" | tr / _)\"\n"
            "[ -f \"$f\" ] && cat \"$f\"\n"
            "exit 0\n"
        )
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
            GH_STUB_DIR=str(root / "gh-data"),
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
    _refused(world["reap"](path), "git fetch of every origin head failed")
    assert path.exists()


# ---- (c)/(d) do not depend on the clone's configured refspec ---------------

def _single_branch_clone_on_topic(world, name):
    """A `--single-branch` clone of main whose HEAD is the pushed `topic` branch.

    Its refspec is main-only, so `git fetch origin` never brings back topic and
    refs/remotes/origin/* never contains HEAD.
    """
    env, root, origin = world["env"], world["root"], world["origin"]
    seed = root / "seed"
    if not _git("ls-remote", str(origin), "refs/heads/topic", cwd=root, env=env):
        _git("checkout", "-q", "-b", "topic", cwd=seed, env=env)
        (seed / "topic.txt").write_text("topic\n")
        _git("add", "topic.txt", cwd=seed, env=env)
        _git("commit", "-qm", "topic work", cwd=seed, env=env)
        _git("push", "-q", "origin", "topic", cwd=seed, env=env)
        _git("checkout", "-q", "main", cwd=seed, env=env)
    path = root / name
    _git("clone", "-q", "--single-branch", "-b", "main", str(origin), str(path),
         cwd=root, env=env)
    _git("fetch", "-q", "origin", "topic", cwd=path, env=env)
    _git("checkout", "-q", "-b", "topic", "FETCH_HEAD", cwd=path, env=env)
    refspec = _git("config", "--get-all", "remote.origin.fetch", cwd=path, env=env)
    assert refspec == "+refs/heads/main:refs/remotes/origin/main"
    remotes = _git("for-each-ref", "--contains", "HEAD", "refs/remotes/origin",
                   cwd=path, env=env)
    assert remotes == "", "fixture invalid: refs/remotes/origin already contains HEAD"
    return path


def test_single_branch_clone_on_a_pushed_non_main_branch_is_reaped(world):
    path = _single_branch_clone_on_topic(world, "single")
    proc = world["reap"](path)
    assert proc.returncode == 0, proc.stderr
    assert not path.exists()
    assert proc.stdout.startswith(f"REAPED {path} (was ")


def test_single_branch_clone_with_an_unpushed_commit_is_refused(world):
    path = _single_branch_clone_on_topic(world, "single-unpushed")
    env = world["env"]
    (path / "topic.txt").write_text("local only\n")
    _git("commit", "-qam", "unpushed", cwd=path, env=env)
    _refused(world["reap"](path), "is on no origin branch")
    assert path.exists()


def test_a_leftover_check_namespace_cannot_vouch_and_is_cleared_on_refusal(world):
    path = world["clone"]("planted")
    env = world["env"]
    (path / "README").write_text("local\n")
    _git("commit", "-qam", "local only", cwd=path, env=env)
    _git("update-ref", "refs/reap-check/planted", "HEAD", cwd=path, env=env)
    _refused(world["reap"](path), "is on no origin branch")
    assert path.exists()
    assert _git("for-each-ref", "refs/reap-check/", cwd=path, env=env) == ""


def test_a_stale_remote_tracking_ref_cannot_vouch(world):
    path = world["clone"]("stale")
    env = world["env"]
    (path / "README").write_text("local\n")
    _git("commit", "-qam", "local only", cwd=path, env=env)
    _git("update-ref", "refs/remotes/origin/ghost", "HEAD", cwd=path, env=env)
    _refused(world["reap"](path), "is on no origin branch")
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


# ---- (e) tags: a local-only tag can be the only ref holding a commit -------

def _clone_with_tag_only_commit(world, name, annotated):
    path = world["clone"](name)
    env = world["env"]
    (path / "README").write_text("tag only\n")
    _git("commit", "-qam", "reachable only from the tag", cwd=path, env=env)
    if annotated:
        _git("tag", "-a", "-m", "local", "v-local", cwd=path, env=env)
    else:
        _git("tag", "v-local", cwd=path, env=env)
    _git("reset", "-q", "--hard", "origin/main", cwd=path, env=env)
    assert _git("status", "--porcelain", cwd=path, env=env) == ""
    return path


@pytest.mark.parametrize("annotated", [False, True], ids=["lightweight", "annotated"])
def test_tag_only_commit_is_refused(world, annotated):
    path = _clone_with_tag_only_commit(world, f"tagonly-{annotated}", annotated)
    proc = world["reap"](path)
    _refused(proc, "standalone: tag v-local (")
    assert "points at commits on no origin branch — content would be lost" in proc.stderr
    assert path.exists()


def test_tag_on_a_pushed_commit_is_still_reaped(world):
    path = world["clone"]("tag-pushed")
    _git("tag", "-a", "-m", "on main", "v-ok", cwd=path, env=world["env"])
    proc = world["reap"](path)
    assert proc.returncode == 0, proc.stderr
    assert not path.exists()


# ---- Ignored entries: not a refusal, but a record --------------------------

def test_non_rebuildable_ignored_entries_are_listed_before_removal(world):
    path = world["clone"]("ignored")
    (path / ".git" / "info" / "exclude").write_text(
        ".env\nnotes/\nnode_modules/\ndist/\n.venv/\n__pycache__/\n")
    (path / ".env").write_text("SECRET=x\n")
    (path / "notes").mkdir()
    (path / "notes" / "a.txt").write_text("a\n")
    for d in ("node_modules/deep", "pkg/dist", ".venv", "src/__pycache__",
              "mixed/node_modules"):
        (path / d).mkdir(parents=True)
        (path / d / "f").write_text("f\n")
    (path / "mixed" / ".env").write_text("SECRET=y\n")
    proc = world["reap"](path)
    assert proc.returncode == 0, proc.stderr
    assert not path.exists()
    listed = sorted(l for l in proc.stdout.splitlines()
                    if l.startswith("ignored (not rebuildable): "))
    assert listed == [
        f"ignored (not rebuildable): {path}/.env",
        f"ignored (not rebuildable): {path}/mixed/.env",
        f"ignored (not rebuildable): {path}/notes/",
    ], proc.stdout
    assert proc.stdout.splitlines()[-1].startswith(f"REAPED {path} (was ")


def test_clean_clone_lists_no_ignored_entry(world):
    path = world["clone"]("noignored")
    proc = world["reap"](path)
    assert proc.returncode == 0, proc.stderr
    assert "ignored (not rebuildable)" not in proc.stdout


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


# ---- Landed without an origin head containing it: merged PR, tag on origin --

def _gh_merged(world, branch, number, sha, repo="origin"):
    """Make the gh stub answer 'PR #number, head <sha>, merged' for repo/branch."""
    data = world["root"] / "gh-data"
    data.mkdir(exist_ok=True)
    (data / f"{repo}__{branch.replace('/', '_')}").write_text(f"{number} {sha}\n")


def _gh_fail(world):
    data = world["root"] / "gh-data"
    data.mkdir(exist_ok=True)
    (data / "FAIL").write_text("")


def _squash_landed_branch(world, name, head_on_feature):
    """A clone with local branch `feat` (never pushed) whose content origin/main got as a
    squash commit (new SHA). Returns (path, feat_tip)."""
    env, root = world["env"], world["root"]
    path = world["clone"](name)
    _git("checkout", "-q", "-b", "feat", cwd=path, env=env)
    (path / "f.txt").write_text("feature\n")
    _git("add", "f.txt", cwd=path, env=env)
    _git("commit", "-qm", "feature work", cwd=path, env=env)
    tip = _git("rev-parse", "HEAD", cwd=path, env=env)
    seed = root / "seed"
    _git("checkout", "-q", "main", cwd=seed, env=env)
    (seed / "f.txt").write_text("feature\n")
    _git("add", "f.txt", cwd=seed, env=env)
    _git("commit", "-qm", "squash of feat", cwd=seed, env=env)
    _git("push", "-q", "origin", "main", cwd=seed, env=env)
    if not head_on_feature:
        _git("checkout", "-q", "main", cwd=path, env=env)
    return path, tip


@pytest.mark.parametrize("head_on_feature", [True, False], ids=["HEAD", "side-branch"])
def test_squash_merged_branch_whose_tip_is_the_merged_head_is_reaped(world, head_on_feature):
    path, tip = _squash_landed_branch(world, f"sq-{head_on_feature}", head_on_feature)
    _gh_merged(world, "feat", 7, tip)
    proc = world["reap"](path)
    assert proc.returncode == 0, proc.stderr
    assert not path.exists()
    assert f"proof: merged PR #7 at {tip}" in proc.stderr


@pytest.mark.parametrize("head_on_feature", [True, False], ids=["HEAD", "side-branch"])
def test_local_commit_ahead_of_the_merged_head_is_refused(world, head_on_feature):
    path, tip = _squash_landed_branch(world, f"ahead-{head_on_feature}", head_on_feature)
    _gh_merged(world, "feat", 7, tip)
    env = world["env"]
    _git("checkout", "-q", "feat", cwd=path, env=env)
    (path / "f.txt").write_text("later local work\n")
    _git("commit", "-qam", "after the PR merged", cwd=path, env=env)
    if not head_on_feature:
        _git("checkout", "-q", "main", cwd=path, env=env)
    proc = world["reap"](path)
    _refused(proc, "on no origin branch" if head_on_feature else "local branch feat")
    assert "proof: merged PR" not in proc.stderr
    assert path.exists()


def test_merged_pr_of_a_different_branch_is_refused(world):
    path, tip = _squash_landed_branch(world, "otherbranch", True)
    _gh_merged(world, "some-other-branch", 7, tip)
    _refused(world["reap"](path), "is on no origin branch")
    assert path.exists()


def test_merged_pr_of_a_different_repo_is_refused(world):
    path, tip = _squash_landed_branch(world, "otherrepo", True)
    _gh_merged(world, "feat", 7, tip, repo="not-this-repo")
    _refused(world["reap"](path), "is on no origin branch")
    assert path.exists()


def test_gh_failure_is_a_refusal_never_a_pass(world):
    path, tip = _squash_landed_branch(world, "ghfail", True)
    _gh_merged(world, "feat", 7, tip)
    _gh_fail(world)
    proc = world["reap"](path)
    _refused(proc, "is on no origin branch")
    assert "gh pr list failed" in proc.stderr
    assert path.exists()


def test_unconfigured_gh_is_a_refusal(world):
    path, _tip = _squash_landed_branch(world, "ghdown", True)
    _refused(world["reap"](path), "gh pr list failed")
    assert path.exists()


def _tag_only_commit_clone(world, name, annotated, push_tag):
    path = _clone_with_tag_only_commit(world, name, annotated)
    if push_tag:
        _git("push", "-q", "origin", "refs/tags/v-local", cwd=path, env=world["env"])
    return path


@pytest.mark.parametrize("annotated", [False, True], ids=["lightweight", "annotated"])
def test_local_tag_with_the_same_object_on_origin_is_reaped(world, annotated):
    path = _tag_only_commit_clone(world, f"tagon-{annotated}", annotated, True)
    proc = world["reap"](path)
    assert proc.returncode == 0, proc.stderr
    assert not path.exists()
    assert "proof: tag v-local on origin" in proc.stderr


@pytest.mark.parametrize("annotated", [False, True], ids=["lightweight", "annotated"])
def test_local_tag_with_a_different_object_on_origin_is_refused(world, annotated):
    env, root = world["env"], world["root"]
    path = world["clone"](f"tagdiff-{annotated}")
    seed = root / "seed"
    (seed / "other.txt").write_text("other\n")
    _git("add", "other.txt", cwd=seed, env=env)
    _git("commit", "-qm", "other commit", cwd=seed, env=env)
    if annotated:
        _git("tag", "-a", "-m", "origin", "v-local", cwd=seed, env=env)
    else:
        _git("tag", "v-local", cwd=seed, env=env)
    _git("push", "-q", "origin", "refs/tags/v-local", cwd=seed, env=env)
    _git("reset", "-q", "--hard", "origin/main", cwd=seed, env=env)
    (path / "README").write_text("tag only\n")
    _git("commit", "-qam", "reachable only from the tag", cwd=path, env=env)
    if annotated:
        _git("tag", "-a", "-m", "local", "v-local", cwd=path, env=env)
    else:
        _git("tag", "v-local", cwd=path, env=env)
    _git("reset", "-q", "--hard", "origin/main", cwd=path, env=env)
    proc = world["reap"](path)
    _refused(proc, "standalone: tag v-local (")
    assert "proof: tag" not in proc.stderr
    assert path.exists()


def test_local_tag_absent_on_origin_is_refused(world):
    path = _tag_only_commit_clone(world, "tagabsent", True, False)
    proc = world["reap"](path)
    _refused(proc, "standalone: tag v-local (")
    assert "proof: tag" not in proc.stderr
    assert path.exists()
