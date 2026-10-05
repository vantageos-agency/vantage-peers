#!/usr/bin/env python3
"""HEAD evidence wins over glob order in enforce-backend-doctor-before-deploy.py.

Defect closed here: the gate walked `qa/backend-doctor-*.json` in glob order
and returned on the FIRST file that covered HEAD -- exact match OR an ancestor
with an unchanged convex/ tree. With dozens of historical evidence files in
qa/, an ancestor's verdict could decide the deploy while evidence pinning HEAD
itself was present and said something different. Pi's ruling: evidence for
HEAD decides, never the first file in glob order. Only when no HEAD evidence
exists does the ancestor relaxation apply.

Glob order is filesystem order, not alphabetical. To make "the ancestor sorts
first" deterministic, every pole patches the hook's `glob.glob` to return
SORTED results and names the ancestor file so it sorts before HEAD's. Without
the fix, the ancestor is therefore always the first match.

Every pole runs against a REAL temporary git repository.

Run with:
    python3 -m pytest .claude/hooks/test_enforce_backend_doctor_head_evidence_wins.py -q
"""
import glob as _glob
import importlib.util
import json
import pathlib
import subprocess
import tempfile

import pytest

HOOK = pathlib.Path(__file__).with_name("enforce-backend-doctor-before-deploy.py")

_spec = importlib.util.spec_from_file_location("_bd_gate_head_wins", HOOK)
_mod = importlib.util.module_from_spec(_spec)
_mod.__dict__["_TESTING"] = True
_spec.loader.exec_module(_mod)

DEPLOY = "npx convex deploy --yes"
# Sorts before every hex-named file: "000-" beats any sha not starting "000",
# and against one that does, "-" (0x2d) sorts before every hex digit.
ANCESTOR_NAME = "backend-doctor-000-ancestor.json"


@pytest.fixture(autouse=True)
def _sorted_glob(monkeypatch):
    real = _glob.glob
    monkeypatch.setattr(_mod.glob, "glob", lambda p, *a, **k: sorted(real(p, *a, **k)))


def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True,
                   capture_output=True, text=True)


def _head(repo):
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                          capture_output=True, text=True).stdout.strip()


def _payload(repo, sha, exit_code=0, mech=0):
    return {
        "sha": sha,
        "cli_commit": "f2f0f687480fa87f99bb348a3accb490d564f254",
        "convex_path": str(repo / "convex"),
        "exit_code": exit_code,
        "checked": 47,
        "total": 47,
        "mechanical_violations": mech,
    }


def _repo_with_ancestor(tmp, ancestor_mech):
    """c1 (ancestor, evidence written under ANCESTOR_NAME) -> c2 (docs-only).
    convex/ is byte-identical, so the ancestor relaxation WOULD accept the
    ancestor file for HEAD. Returns (repo, head_sha)."""
    repo = pathlib.Path(tmp)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t.co")
    _git(repo, "config", "user.name", "t")
    (repo / "convex").mkdir()
    (repo / "convex" / "schema.ts").write_text("export default {}\n")
    (repo / "README.md").write_text("readme\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "c1")
    ancestor = _head(repo)
    (repo / "README.md").write_text("readme v2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "c2 (docs only)")
    head = _head(repo)
    (repo / "qa").mkdir()
    (repo / "qa" / ANCESTOR_NAME).write_text(
        json.dumps(_payload(repo, ancestor, exit_code=0 if ancestor_mech == 0 else 1,
                            mech=ancestor_mech)))
    return repo, head


def _assert_ancestor_sorts_first(repo):
    files = _mod.glob.glob(str(repo / _mod.EVIDENCE_GLOB))
    assert pathlib.Path(files[0]).name == ANCESTOR_NAME, files


def _run(repo):
    return _mod.run_hook(DEPLOY, cwd=str(repo))


# Pole A -- MUST_BLOCK: green ancestor sorts first, HEAD evidence is RED.
def test_head_red_beats_green_ancestor_sorted_first():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _repo_with_ancestor(tmp, ancestor_mech=0)
        (repo / "qa" / f"backend-doctor-{head}.json").write_text(
            json.dumps(_payload(repo, head, exit_code=1, mech=3)))
        _assert_ancestor_sorts_first(repo)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "red", (verdict, msg)
        assert f"backend-doctor-{head}.json" in msg
        assert _run(repo) == 2


# Pole B -- MUST_PASS: red ancestor sorts first, HEAD evidence is GREEN.
def test_head_green_beats_red_ancestor_sorted_first():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _repo_with_ancestor(tmp, ancestor_mech=4)
        (repo / "qa" / f"backend-doctor-{head}.json").write_text(
            json.dumps(_payload(repo, head, exit_code=0, mech=0)))
        _assert_ancestor_sorts_first(repo)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "pass", (verdict, msg)
        assert _run(repo) == 0


# Pole C -- MUST_BLOCK: HEAD evidence is unparseable JSON; a green ancestor
# must NOT stand in for it.
def test_head_evidence_unparseable_refuses_no_ancestor_fallback():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _repo_with_ancestor(tmp, ancestor_mech=0)
        (repo / "qa" / f"backend-doctor-{head}.json").write_text("{not json")
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "incomplete", (verdict, msg)
        assert f"backend-doctor-{head}.json" in msg
        assert _run(repo) == 2


# Pole D -- MUST_BLOCK: HEAD evidence parses but omits a verdict field; a
# green ancestor must NOT stand in for it.
def test_head_evidence_missing_verdict_refuses_no_ancestor_fallback():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _repo_with_ancestor(tmp, ancestor_mech=0)
        body = _payload(repo, head)
        del body["mechanical_violations"]
        (repo / "qa" / f"backend-doctor-{head}.json").write_text(json.dumps(body))
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "incomplete", (verdict, msg)
        assert "mechanical_violations" in msg
        assert _run(repo) == 2


# Pole E -- MUST_BLOCK: a file NAMED for HEAD whose sha field is missing or not
# a sha certifies nothing; a green ancestor must NOT stand in for it.
def test_head_named_file_with_bad_sha_field_refuses():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _repo_with_ancestor(tmp, ancestor_mech=0)
        body = _payload(repo, head)
        body["sha"] = "not-a-sha"
        (repo / "qa" / f"backend-doctor-{head[:12]}.json").write_text(json.dumps(body))
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "incomplete", (verdict, msg)
        assert _run(repo) == 2


# Pole F -- MUST_PASS: no HEAD evidence at all -> the ancestor relaxation
# still applies, unchanged.
def test_no_head_evidence_ancestor_relaxation_unchanged():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _ = _repo_with_ancestor(tmp, ancestor_mech=0)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "pass", (verdict, msg)
        assert "pins ancestor" in msg


# ---------------------------------------------------------------------------
# Several ancestors, no HEAD evidence: the NEAREST ancestor decides (fewest
# commits from HEAD, `git rev-list --count <sha>..HEAD`), never the first
# glob match. Equal distance between distinct commits is a could-not-judge.
# ---------------------------------------------------------------------------

FAR_NAME = "backend-doctor-000-far.json"      # sorts before NEAR_NAME
NEAR_NAME = "backend-doctor-001-near.json"


def _init_bare(tmp):
    repo = pathlib.Path(tmp)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t.co")
    _git(repo, "config", "user.name", "t")
    (repo / "convex").mkdir()
    (repo / "convex" / "schema.ts").write_text("export default {}\n")
    (repo / "README.md").write_text("r0\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "c0")
    return repo


def _docs_commit(repo, text):
    (repo / "README.md").write_text(text + "\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", text)
    return _head(repo)


def _two_ancestors(tmp, far_mech, near_mech):
    """far (c0) -> near (c1) -> HEAD (c2), docs-only commits, so convex/ is
    byte-identical across all three. FAR's file sorts first."""
    repo = _init_bare(tmp)
    far = _head(repo)
    near = _docs_commit(repo, "c1")
    _docs_commit(repo, "c2")
    (repo / "qa").mkdir()
    (repo / "qa" / FAR_NAME).write_text(json.dumps(
        _payload(repo, far, exit_code=1 if far_mech else 0, mech=far_mech)))
    (repo / "qa" / NEAR_NAME).write_text(json.dumps(
        _payload(repo, near, exit_code=1 if near_mech else 0, mech=near_mech)))
    files = _mod.glob.glob(str(repo / _mod.EVIDENCE_GLOB))
    assert pathlib.Path(files[0]).name == FAR_NAME, files
    return repo, far, near


# Pole G -- MUST_BLOCK: far ancestor green and sorted first, near one red.
def test_nearest_ancestor_red_beats_farther_green_sorted_first():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _, near = _two_ancestors(tmp, far_mech=0, near_mech=3)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "red", (verdict, msg)
        assert near[:12] in msg
        assert _run(repo) == 2


# Pole H -- MUST_PASS: far ancestor red and sorted first, near one green and
# convex-identical.
def test_nearest_ancestor_green_beats_farther_red_sorted_first():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _, near = _two_ancestors(tmp, far_mech=4, near_mech=0)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "pass", (verdict, msg)
        assert near[:12] in msg
        assert _run(repo) == 0


# Pole I -- MUST_BLOCK: the nearest ancestor is green but convex/ differs
# between it and HEAD; the byte-identical rule applies to the CHOSEN ancestor,
# and a farther green one whose convex/ happens to match HEAD (c1 changed
# convex/, c2 reverted it) does not rescue it.
def test_nearest_ancestor_convex_diverged_refuses():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_bare(tmp)
        far = _head(repo)
        (repo / "convex" / "schema.ts").write_text("export default { v: 2 }\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "c1 convex change")
        near = _head(repo)
        (repo / "convex" / "schema.ts").write_text("export default {}\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "c2 convex revert")
        (repo / "qa").mkdir()
        (repo / "qa" / FAR_NAME).write_text(json.dumps(_payload(repo, far)))
        (repo / "qa" / NEAR_NAME).write_text(json.dumps(_payload(repo, near)))
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "diverged", (verdict, msg)
        assert _run(repo) == 2


# Pole J -- MUST_BLOCK: two distinct ancestors at the SAME distance (the two
# parents of a merge commit), both green -> tie -> could-not-judge.
def test_equidistant_ancestors_tie_refuses():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_bare(tmp)
        base = _head(repo)
        _git(repo, "checkout", "-q", "-b", "left")
        left = _docs_commit(repo, "left")
        _git(repo, "checkout", "-q", base)
        _git(repo, "checkout", "-q", "-b", "right")
        (repo / "OTHER.md").write_text("right\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "right")
        right = _head(repo)
        _git(repo, "merge", "-q", "--no-edit", "left")
        (repo / "qa").mkdir()
        (repo / "qa" / FAR_NAME).write_text(json.dumps(_payload(repo, left)))
        (repo / "qa" / NEAR_NAME).write_text(json.dumps(_payload(repo, right)))
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "ambiguous", (verdict, msg)
        assert left[:12] in msg and right[:12] in msg
        assert _run(repo) == 2
