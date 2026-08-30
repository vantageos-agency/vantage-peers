#!/usr/bin/env python3
"""Adversarial suite for enforce-backend-doctor-before-deploy.py (D5, task
k17eh5g4p6c4sxjeq40rhxzdhx8cg3np).

Order imposed by hook-doctrine.md: the REFUSE cases (real violations that MUST
block) come BEFORE the PASS cases. A suite that only proves the pass side gets
torn out; a suite that only proves refusals is a rubber stamp. Both poles here.

The gate reads an evidence file `qa/backend-doctor-<sha>.json` keyed to the git
HEAD being deployed. It refuses when:
  * RED-refuse-1: the evidence for HEAD is MECHANICALLY RED (mechanical
    violations > 0, or the doctor could-not-judge, exit 2).
  * RED-refuse-2: the newest evidence pins an EARLIER commit than HEAD (stale
    green -- produced against a version that is not the one being deployed).
  * absent: no evidence file for HEAD at all ("never run against this version").
It PASSES (RED-pass) when the evidence pins HEAD and is mechanically clean.

It must NEVER refuse on a judgement/process rule (those are not mechanical) --
only on mechanical non-conformance.
"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile

HOOK = pathlib.Path(__file__).with_name("enforce-backend-doctor-before-deploy.py")

_spec = importlib.util.spec_from_file_location("_bd_gate", HOOK)
_mod = importlib.util.module_from_spec(_spec)
_mod.__dict__["_TESTING"] = True
_spec.loader.exec_module(_mod)


def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True,
                   capture_output=True, text=True)


def _init_repo(tmp):
    repo = pathlib.Path(tmp)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t.co")
    _git(repo, "config", "user.name", "t")
    (repo / "convex").mkdir()
    (repo / "convex" / "schema.ts").write_text("export default {}\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "c1")
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                          capture_output=True, text=True).stdout.strip()
    (repo / "qa").mkdir()
    return repo, head


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


DEPLOY = "npx convex deploy --yes"


def _run(repo, command=DEPLOY):
    return _mod.run_hook(command, cwd=str(repo))


# ---------------------------------------------------------------------------
# REFUSE FIRST -- real violations.
# ---------------------------------------------------------------------------

def test_red_refuse_1_mechanically_red_report():
    """RED-refuse-1: evidence for HEAD exists but has mechanical violations."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_evidence(repo, head, exit_code=1, mech=3)
        assert _run(repo) == 2


def test_red_refuse_1_could_not_judge_exit2():
    """Doctor exit 2 (unloadable tree) is a mechanical could-not-judge."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_evidence(repo, head, exit_code=2, mech=0)
        assert _run(repo) == 2


def test_red_refuse_2_stale_report_predates_head():
    """RED-refuse-2: newest evidence pins an EARLIER commit than HEAD."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_evidence(repo, head)  # clean, but for the OLD head
        # advance HEAD -- the clean evidence now pins a predecessor
        (repo / "convex" / "schema.ts").write_text("export default { v: 2 }\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "c2")
        assert _run(repo) == 2


def test_refuse_absent_never_run_against_this_version():
    """No evidence file at all -> refuse (never run against this version)."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        assert _run(repo) == 2


def test_refuse_message_is_structured():
    """The refusal names what failed and what to change (no opaque refusal)."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_evidence(repo, head, exit_code=1, mech=2)
        p = subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps({"tool_name": "Bash",
                              "tool_input": {"command": DEPLOY, "cwd": str(repo)}}),
            capture_output=True, text=True, cwd=str(repo),
        )
        assert p.returncode == 2
        out = p.stderr + p.stdout
        assert "backend-doctor" in out
        assert "mechanical" in out.lower()


# ---------------------------------------------------------------------------
# PASS SIDE -- prove the gate lets clean+current work through.
# ---------------------------------------------------------------------------

def test_red_pass_clean_report_keyed_to_head():
    """RED-pass: evidence pins HEAD and is mechanically clean -> ALLOW."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_evidence(repo, head, exit_code=0, mech=0)
        assert _run(repo) == 0


def test_pass_judgement_rules_do_not_refuse():
    """A report clean of MECHANICAL violations but exit 1 from judgement/process
    rules only (mechanical_violations==0) must PASS -- never refuse on a rule a
    human must weigh."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_evidence(repo, head, exit_code=1, mech=0)
        assert _run(repo) == 0


def test_pass_short_sha_evidence_matches_full_head():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_evidence(repo, head[:12], exit_code=0, mech=0)
        assert _run(repo) == 0


# ---------------------------------------------------------------------------
# NON-DEPLOY COMMANDS -- the gate is silent.
# ---------------------------------------------------------------------------

def test_non_deploy_command_ignored():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        assert _run(repo, 'grep -rn "convex deploy" CLAUDE.md') == 0


def test_convex_dev_ignored():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        assert _run(repo, "npx convex dev --once") == 0


def test_dry_run_ignored():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        assert _run(repo, "npx convex deploy --dry-run") == 0


# ---------------------------------------------------------------------------
# OVERRIDE -- documented Laurent-authorized escape.
# ---------------------------------------------------------------------------

def test_override_marker_passes_without_evidence():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        assert _run(
            repo,
            "npx convex deploy --yes  # allow-no-backend-doctor: laurent hotfix incident 9",
        ) == 0


# ---------------------------------------------------------------------------
# FAIL-OPEN STRUCTUREL -- a fleet hook never breaks a session.
# ---------------------------------------------------------------------------

def test_malformed_stdin_does_not_break():
    p = subprocess.run([sys.executable, str(HOOK)], input="not json",
                       capture_output=True, text=True)
    assert p.returncode == 0


def test_other_tool_ignored():
    p = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"tool_name": "Read", "tool_input": {"file_path": "x"}}),
        capture_output=True, text=True)
    assert p.returncode == 0
