"""TDD: an Eta approval survives a head-hash change when the reviewed content
did not move.

Class of failure: an approval is bound to a commit SHA. That SHA changes with
no reviewed-content line moving (single-commit/squash merge, or a rebase onto
an advanced main), and the guard demands a fresh approval for zero real change.

Two cases, proven DIFFERENTLY:
  CASE 1 — single-commit (squash) merge: base unchanged, only the commit hash
    differs. The FULL tree is identical -> whole-tree diff is empty.
  CASE 2 — rebase onto an advanced main: the full tree differs LEGITIMATELY
    (it now carries the whole moved repo). A whole-tree diff is worthless here.
    The only valid proof is file-by-file on the TOUCHED files (the files the
    reviewed change actually modified).

Doctrine anchor: .claude/rules/derive-never-type.md — the comparison operates
on the STATE actually queried via git, never on a value passed in a message.

Run: python3 -m pytest .claude/hooks/tests/test_approval_survives_invariant_rebase.py -v
"""
import importlib.util
import pathlib
import subprocess
import tempfile

HOOK = pathlib.Path(__file__).resolve().parents[1] / "enforce-eta-approval-before-npm-publish.py"

spec = importlib.util.spec_from_file_location("eta_approval_hook_rebase", HOOK)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def _git(cwd, *args):
    return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)


def _init_repo(tmpdir):
    _git(tmpdir, "init")
    _git(tmpdir, "config", "user.email", "test@test.com")
    _git(tmpdir, "config", "user.name", "Test")


def _write(tmpdir, name, content):
    with open(pathlib.Path(tmpdir) / name, "w") as f:
        f.write(content)


def _head(tmpdir):
    return _git(tmpdir, "rev-parse", "HEAD").stdout.strip()


# ---------------------------------------------------------------------------
# T1 — CASE 1: single-commit (squash) merge, full tree identical -> CARRIED.
# ---------------------------------------------------------------------------
def test_case1_squash_merge_tree_identical_carries_approval():
    with tempfile.TemporaryDirectory() as tmp:
        _init_repo(tmp)
        _write(tmp, "package.json", '{"name":"pkg","version":"1.0.0"}')
        _git(tmp, "add", ".")
        _git(tmp, "commit", "-m", "initial")
        approved_sha = _head(tmp)

        # Squash-merge: new commit, identical tree (same content, new hash).
        tree_sha = _git(tmp, "rev-parse", "HEAD^{tree}").stdout.strip()
        squash = subprocess.run(
            ["git", "-C", tmp, "commit-tree", tree_sha, "-p", approved_sha, "-m", "squash merge"],
            capture_output=True, text=True,
        ).stdout.strip()
        _git(tmp, "update-ref", "HEAD", squash)
        head_sha = _head(tmp)

        assert approved_sha != head_sha
        ok, reason = mod.validate_commit_sha(approved_sha, head_sha, publish_dir=tmp)
        assert ok, reason
        assert "case1" in reason or "tree-identical" in reason


# ---------------------------------------------------------------------------
# T2 — CASE 2: rebase onto advanced main, whole tree differs (unrelated file
# moved from main) but every TOUCHED file is byte-identical -> CARRIED.
# ---------------------------------------------------------------------------
def test_case2_rebase_touched_files_identical_carries_approval():
    with tempfile.TemporaryDirectory() as tmp:
        _init_repo(tmp)
        _write(tmp, "package.json", '{"name":"pkg","version":"1.0.0"}')
        _write(tmp, "README.md", "unrelated\n")
        _git(tmp, "add", ".")
        _git(tmp, "commit", "-m", "base")
        base_sha = _head(tmp)

        # Reviewed branch: touches only feature.js.
        _write(tmp, "feature.js", "// reviewed feature\n")
        _git(tmp, "add", "feature.js")
        _git(tmp, "commit", "-m", "feature: add reviewed file")
        approved_sha = _head(tmp)

        # Main advances independently (unrelated file, README.md changes).
        _git(tmp, "checkout", base_sha)
        _write(tmp, "README.md", "unrelated but now different\n")
        _git(tmp, "add", "README.md")
        _git(tmp, "commit", "-m", "main: unrelated readme update")
        new_main_sha = _head(tmp)

        # Rebase the reviewed commit onto the advanced main: cherry-pick feature.js
        # unchanged onto new_main_sha (simulates `git rebase` producing a new SHA
        # whose whole tree differs from approved_sha because of the README change,
        # but whose touched file — feature.js — is byte-identical).
        _git(tmp, "checkout", new_main_sha)
        _git(tmp, "cherry-pick", approved_sha)
        assert _git(tmp, "status").returncode == 0
        head_sha = _head(tmp)

        assert approved_sha != head_sha
        # Sanity: whole tree DOES differ (README.md differs) — case 1 must fail.
        whole_tree_diff = subprocess.run(
            ["git", "-C", tmp, "diff", "--quiet", approved_sha, head_sha, "--", tmp],
            capture_output=True,
        )
        assert whole_tree_diff.returncode != 0, "test setup invalid: whole tree must differ"

        ok, reason = mod.validate_commit_sha(approved_sha, head_sha, publish_dir=tmp)
        assert ok, reason
        assert "case2" in reason or "touched-files-identical" in reason


# ---------------------------------------------------------------------------
# T3 — a touched file was actually modified post-approval -> REFUSED, file named.
# ---------------------------------------------------------------------------
def test_touched_file_modified_refuses_and_names_file():
    with tempfile.TemporaryDirectory() as tmp:
        _init_repo(tmp)
        _write(tmp, "package.json", '{"name":"pkg","version":"1.0.0"}')
        _write(tmp, "README.md", "unrelated\n")
        _git(tmp, "add", ".")
        _git(tmp, "commit", "-m", "base")
        base_sha = _head(tmp)

        _write(tmp, "feature.js", "// reviewed feature v1\n")
        _git(tmp, "add", "feature.js")
        _git(tmp, "commit", "-m", "feature: add reviewed file")
        approved_sha = _head(tmp)

        # Main advances (unrelated) AND the touched file is modified post-approval.
        _git(tmp, "checkout", base_sha)
        _write(tmp, "README.md", "unrelated but now different\n")
        _git(tmp, "add", "README.md")
        _git(tmp, "commit", "-m", "main: unrelated readme update")
        new_main_sha = _head(tmp)

        _git(tmp, "checkout", new_main_sha)
        _git(tmp, "cherry-pick", approved_sha)
        # Post-approval edit to the reviewed file — new commit, not part of what Eta saw.
        _write(tmp, "feature.js", "// reviewed feature v1 -- CHANGED AFTER APPROVAL\n")
        _git(tmp, "add", "feature.js")
        _git(tmp, "commit", "-m", "post-review change to feature.js")
        head_sha = _head(tmp)

        assert approved_sha != head_sha
        ok, reason = mod.validate_commit_sha(approved_sha, head_sha, publish_dir=tmp)
        assert not ok
        assert "feature.js" in reason
