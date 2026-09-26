#!/usr/bin/env python3
"""Bipolar probe for the ANCESTOR-EVIDENCE relaxation of
enforce-backend-doctor-before-deploy.py.

Defect closed here: the doctor gate requires evidence pinned to
`git rev-parse HEAD` at deploy time, but the deploy authorization itself
requires a clean checkout with zero local commits -- so evidence for a
commit cannot be committed AT that commit without either dirtying the tree
or moving HEAD past the commit the evidence names. Measured twice on real
deploy attempts.

The adjustment: evidence pinned to an ANCESTOR of HEAD is accepted for HEAD
*only if* nothing under convex/ changed between that ancestor and HEAD
(`git merge-base --is-ancestor` + `git diff --name-only <sha>..HEAD --
convex/` both green). Anything else -- a sibling commit, a convex/ change in
between, a non-integer mechanical_violations -- still refuses exactly as
before.

Every pole below runs against a REAL temporary git repository (no fixture,
no mocked git). Each pole is declared MUST_PASS or MUST_BLOCK and is run in
isolation so a failure names exactly which pole broke.

Run with:
    python3 -m pytest .claude/hooks/test_enforce_backend_doctor_ancestor_evidence.py -q
"""
import importlib.util
import json
import pathlib
import subprocess
import tempfile

HOOK = pathlib.Path(__file__).with_name("enforce-backend-doctor-before-deploy.py")

_spec = importlib.util.spec_from_file_location("_bd_gate_ancestor", HOOK)
_mod = importlib.util.module_from_spec(_spec)
_mod.__dict__["_TESTING"] = True
_spec.loader.exec_module(_mod)

DEPLOY = "npx convex deploy --yes"


def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True,
                   capture_output=True, text=True)


def _head(repo):
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                           capture_output=True, text=True).stdout.strip()


def _init_repo(tmp):
    repo = pathlib.Path(tmp)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t.co")
    _git(repo, "config", "user.name", "t")
    (repo / "convex").mkdir()
    (repo / "convex" / "schema.ts").write_text("export default {}\n")
    (repo / "README.md").write_text("readme\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "c1")
    (repo / "qa").mkdir()
    return repo


def _write_evidence(repo, sha, exit_code=0, mech=0):
    p = repo / "qa" / f"backend-doctor-{sha}.json"
    p.write_text(json.dumps({
        "sha": sha,
        "cli_commit": "f2f0f687480fa87f99bb348a3accb490d564f254",
        "convex_path": str(repo / "convex"),
        "exit_code": exit_code,
        "checked": 47,
        "total": 47,
        "mechanical_violations": mech,
    }))


def _run(repo, command=DEPLOY):
    return _mod.run_hook(command, cwd=str(repo))


# ---------------------------------------------------------------------------
# Pole 1 -- MUST_PASS: evidence at an ancestor, nothing under convex/ changed
# between it and HEAD.
# ---------------------------------------------------------------------------

def test_pole_1_ancestor_evidence_no_convex_change_passes():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_repo(tmp)
        ancestor = _head(repo)
        _write_evidence(repo, ancestor, exit_code=0, mech=0)
        # Advance HEAD with a change OUTSIDE convex/ -- the evidence still
        # describes the exact convex/ tree being deployed.
        (repo / "README.md").write_text("readme v2\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "c2 (docs only)")
        assert _run(repo) == 0


# ---------------------------------------------------------------------------
# Pole 2 -- MUST_BLOCK: evidence at an ancestor, but convex/ changed since.
# ---------------------------------------------------------------------------

def test_pole_2_ancestor_evidence_with_convex_change_blocks():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_repo(tmp)
        ancestor = _head(repo)
        _write_evidence(repo, ancestor, exit_code=0, mech=0)
        (repo / "convex" / "schema.ts").write_text("export default { v: 2 }\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "c2 (convex change)")
        assert _run(repo) == 2


def test_pole_2_names_the_changed_convex_file():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_repo(tmp)
        ancestor = _head(repo)
        _write_evidence(repo, ancestor, exit_code=0, mech=0)
        (repo / "convex" / "schema.ts").write_text("export default { v: 2 }\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "c2 (convex change)")
        _, msg = _mod.evaluate(str(repo), str(repo))
        assert "convex/schema.ts" in msg


# ---------------------------------------------------------------------------
# Pole 3 -- MUST_BLOCK: evidence at a commit that is NOT an ancestor of HEAD
# (a sibling branch).
# ---------------------------------------------------------------------------

def test_pole_3_sibling_commit_evidence_blocks():
    """Sibling evidence must block even when convex/ is IDENTICAL on both
    branches -- isolates the ancestor check from the convex/ diff check
    (a sibling with no convex/ diff is exactly the case a diff-only check
    would wrongly wave through)."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_repo(tmp)
        base = _head(repo)
        _git(repo, "checkout", "-q", "-b", "sibling")
        (repo / "OTHER.md").write_text("sibling-only file\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "sibling commit (no convex/ touch)")
        sibling_sha = _head(repo)
        _write_evidence(repo, sibling_sha, exit_code=0, mech=0)
        _git(repo, "checkout", "-q", base)
        _git(repo, "checkout", "-q", "-b", "mainline")
        (repo / "README.md").write_text("mainline change\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "mainline commit (no convex/ touch)")
        assert _run(repo) == 2


# ---------------------------------------------------------------------------
# Pole 4 -- MUST_PASS: evidence sha equals HEAD exactly (unchanged behaviour).
# ---------------------------------------------------------------------------

def test_pole_4_exact_head_match_still_passes():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_repo(tmp)
        head = _head(repo)
        _write_evidence(repo, head, exit_code=0, mech=0)
        assert _run(repo) == 0


# ---------------------------------------------------------------------------
# Pole 5 -- MUST_BLOCK: mechanical_violations non-zero with an otherwise
# perfect ancestor match. The relaxation is about WHICH TREE the evidence
# describes, never about what it says.
# ---------------------------------------------------------------------------

def test_pole_5_dirty_ancestor_evidence_still_blocks():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_repo(tmp)
        ancestor = _head(repo)
        _write_evidence(repo, ancestor, exit_code=1, mech=2)
        (repo / "README.md").write_text("docs only\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "c2 (docs only)")
        assert _run(repo) == 2


# ---------------------------------------------------------------------------
# Pole 6 -- MUST_BLOCK: a payload cwd that is not a git repository.
# ---------------------------------------------------------------------------

def test_pole_6_non_repo_cwd_blocks_naming_the_path():
    with tempfile.TemporaryDirectory() as tmp:
        non_repo = pathlib.Path(tmp) / "not-a-repo"
        non_repo.mkdir()
        p = subprocess.run(
            ["python3", str(HOOK)],
            input=json.dumps({
                "tool_name": "Bash",
                "tool_input": {"command": DEPLOY},
                "cwd": str(non_repo),
            }),
            capture_output=True, text=True,
        )
        assert p.returncode == 2
        assert str(non_repo) in (p.stderr + p.stdout)


if __name__ == "__main__":
    import sys as _sys
    failures = []
    tests = [
        ("pole1_ancestor_pass", test_pole_1_ancestor_evidence_no_convex_change_passes),
        ("pole2_convex_diverged_block", test_pole_2_ancestor_evidence_with_convex_change_blocks),
        ("pole2_names_file", test_pole_2_names_the_changed_convex_file),
        ("pole3_sibling_block", test_pole_3_sibling_commit_evidence_blocks),
        ("pole4_exact_head_pass", test_pole_4_exact_head_match_still_passes),
        ("pole5_dirty_ancestor_block", test_pole_5_dirty_ancestor_evidence_still_blocks),
        ("pole6_non_repo_cwd_block", test_pole_6_non_repo_cwd_blocks_naming_the_path),
    ]
    passed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
            passed += 1
        except AssertionError as e:
            print(f"FAIL {name}: {e}")
            failures.append(name)
        except Exception as e:
            print(f"ERROR {name}: {e}")
            failures.append(name)
    print(f"\n{passed}/{len(tests)} passed")
    if failures:
        _sys.exit(1)
