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


def test_exit2_with_zero_mech_now_passes():
    """Eta ruling 2026-08-30: a recorded could-not-judge (exit 2) with zero
    MECHANICAL violations PASSES — abstention is a real backend's normal state
    (D5-gate rules + reviewer-verified markers), and refusing on exit 2 makes the
    gate unsatisfiable. mechanical_violations is the sole refusal driver; the
    abstentions stay counted in the report, only the deploy verdict changed."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_evidence(repo, head, exit_code=2, mech=0)
        assert _run(repo) == 0


def test_exit2_with_nonzero_mech_still_refuses():
    """A non-zero mechanical count refuses REGARDLESS of exit code — the sole
    refusal driver is mechanical_violations, so exit 2 does not launder a real red."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_evidence(repo, head, exit_code=2, mech=3)
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
                              "tool_input": {"command": DEPLOY},
                              "cwd": str(repo)}),
            capture_output=True, text=True, cwd=str(repo),
        )
        assert p.returncode == 2
        out = p.stderr + p.stdout
        assert "backend-doctor" in out
        assert "mechanical" in out.lower()


# ---------------------------------------------------------------------------
# D5 HOLE -- absence/invalid verdict field read as good news. RED-before.
# ---------------------------------------------------------------------------

def _write_partial_evidence(repo, sha, fields):
    """Write an evidence file pinning `sha` with an arbitrary field set (used to
    OMIT or mistype the verdict fields)."""
    base = {
        "sha": sha,
        "cli_commit": "f2f0f687480fa87f99bb348a3accb490d564f254",
        "convex_path": str(repo / "convex"),
        "checked": 47,
        "total": 47,
    }
    base.update(fields)
    (repo / "qa" / f"backend-doctor-{sha}.json").write_text(json.dumps(base))


def test_refuse_omits_mechanical_violations():
    """THE HOLE: evidence pins HEAD but OMITS mechanical_violations -> a defaulted
    0 wrongly certified clean pre-fix. Must REFUSE (exit 2) and name the field."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_partial_evidence(repo, head, {"exit_code": 0})  # no mech field
        assert _run(repo) == 2
        _, msg = _mod.evaluate(str(repo), str(repo))
        assert "mechanical_violations" in msg


def test_refuse_omits_exit_code():
    """Same hole, other field: OMITS exit_code -> REFUSE, names exit_code."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_partial_evidence(repo, head, {"mechanical_violations": 0})
        assert _run(repo) == 2
        _, msg = _mod.evaluate(str(repo), str(repo))
        assert "exit_code" in msg


def test_refuse_non_integer_verdict_fields():
    """Verdict fields present but NON-INTEGER (strings) -> could-not-judge -> REFUSE."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_partial_evidence(
            repo, head, {"exit_code": "0", "mechanical_violations": "0"})
        assert _run(repo) == 2
        _, msg = _mod.evaluate(str(repo), str(repo))
        assert "mechanical_violations" in msg or "exit_code" in msg


def test_refuse_bool_verdict_field_not_treated_as_int():
    """A JSON bool is a Python int subclass; it must NOT satisfy the verdict."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _init_repo(tmp)
        _write_partial_evidence(
            repo, head, {"exit_code": 0, "mechanical_violations": False})
        assert _run(repo) == 2


# ---------------------------------------------------------------------------
# FAIL-CLOSED on crash -- deploy-scoped, not universal.
# ---------------------------------------------------------------------------

def test_fail_closed_on_crash_during_deploy_evaluation(monkeypatch):
    """An unexpected exception while evaluating a DEPLOY command -> REFUSE (2)."""
    def boom(*a, **k):
        raise RuntimeError("injected evaluation crash")
    monkeypatch.setattr(_mod, "evaluate", boom)
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        assert _run(repo) == 2


def test_fail_open_on_crash_for_non_deploy_command(monkeypatch):
    """The SAME injected error path on a NON-deploy command still allows (0):
    the fail-closed is deploy-scoped, not universal."""
    def boom(*a, **k):
        raise RuntimeError("injected evaluation crash")
    monkeypatch.setattr(_mod, "evaluate", boom)
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        # Non-deploy: evaluate() is never reached, so the crash never fires.
        assert _run(repo, "npx convex dev --once") == 0


def test_fail_closed_when_detection_raises_with_deploy_signal(monkeypatch):
    """If deploy DETECTION itself raises and a deploy signal is in the raw text,
    fail CLOSED (2). If no deploy signal, fail open (0)."""
    def boom(*a, **k):
        raise RuntimeError("injected detection crash")
    monkeypatch.setattr(_mod, "is_backend_deploy", boom)
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        assert _run(repo, "npx convex deploy --yes") == 2
        assert _run(repo, "echo hello world") == 0


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


def test_chained_bypass_build_then_deploy_refuses():
    """Eta's pole: `bun run build && npx convex deploy --yes` must be caught by
    the shared tokenizer (chained deploy) -> REFUSE when no evidence exists."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        assert _run(repo, "bun run build && npx convex deploy --yes") == 2


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


# ---------------------------------------------------------------------------
# v1.1.0 -- `convex run` with CONVEX_DEPLOY_KEY in the environment is NOT a
# deploy (operator ruling 2026-09-15). The untokenisable / raw fallback keys on
# WORDS, never on substrings of an env var name. MUST_BLOCK first. Every case
# asserts its payload carries what it claims to test (landing).
# ---------------------------------------------------------------------------

FIXTURE = HOOK.with_name("tests") / "fixtures" / "catalogue-write-convex-run.sh"

MUST_BLOCK = [
    "npx convex deploy --yes",
    "CONVEX_DEPLOY_KEY=x npx convex deploy --yes",
    "bunx convex deploy",
    "echo 'unclosed ; npx convex deploy",
    "npx --yes convex deploy",
    'sh -c "npx convex deploy"',
]

MUST_PASS = [
    "CONVEX_DEPLOY_KEY=x node_modules/.bin/convex run hookContent:upsertHookContent '{\"name\":\"a\"}'",
    "grep CONVEX_DEPLOY_KEY .env.local",
    "npx convex dev --once",
]


def test_must_block_still_a_deploy():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        for cmd in MUST_BLOCK:
            assert "convex deploy" in cmd
            assert _mod.is_backend_deploy(cmd) is True, cmd
            assert _run(repo, cmd) == 2, cmd


def test_must_block_untokenisable_case_exercises_the_fallback():
    segs = list(_mod.iter_real_commands("echo 'unclosed ; npx convex deploy"))
    assert any(tokens is None for _, tokens in segs), segs


def test_must_pass_convex_run_and_reads():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        for cmd in MUST_PASS:
            assert _mod.is_backend_deploy(cmd) is False, cmd
            assert _run(repo, cmd) == 0, cmd


def test_must_pass_refused_catalogue_write_shape():
    payload = FIXTURE.read_text()
    assert 'CONVEX_DEPLOY_KEY="${K#*=}"' in payload
    assert "node_modules/.bin/convex run" in payload
    assert "python3 -c '" in payload and "pub()" in payload
    # landing: the shape really goes through the untokenisable fallback
    assert any(t is None for _, t in _mod.iter_real_commands(payload))
    assert _mod.is_backend_deploy(payload) is False
    with tempfile.TemporaryDirectory() as tmp:
        repo, _head = _init_repo(tmp)
        assert _run(repo, payload) == 0


def test_untokenisable_convex_run_push_stays_closed():
    # `--push` lifts the `run` exemption: with a deploy word present, the
    # untokenisable segment still fails closed.
    cmd = "CONVEX_DEPLOY_KEY=x npx convex run --push fn deploy 'unclosed"
    assert any(t is None for _, t in _mod.iter_real_commands(cmd))
    assert _mod.is_backend_deploy(cmd) is True
    assert _mod.is_backend_deploy(cmd.replace("--push ", "")) is False


def test_raw_signal_words_not_substrings():
    sig = _mod._raw_has_deploy_signal
    assert sig("npx convex deploy --yes") is True
    assert sig("npx convex@latest deploy") is True
    assert sig("node_modules/.bin/convex deploy") is True
    assert sig("CONVEX_DEPLOY_KEY=x npx convex dev") is False
    assert sig("DEPLOY_KEY=1 convex dev") is False
    assert sig("CONVEX_DEPLOY_KEY=x convex run fn '{\"deploy\":1}'") is False
    assert sig("convex run --push fn") is False  # no deploy word at all
    assert sig("convex run --push fn deploy") is True


def test_must_refuse_unreadable_input_unchanged():
    p = subprocess.run([sys.executable, str(HOOK)],
                       input="not json npx convex deploy",
                       capture_output=True, text=True)
    assert p.returncode == 2
    assert "could not parse the hook payload" in p.stderr
    p = subprocess.run([sys.executable, str(HOOK)], input="not json",
                       capture_output=True, text=True)
    assert p.returncode == 0
    assert "[hook warning]" in p.stderr


# ---------------------------------------------------------------------------
# RULING 6 (task k172fnxzt4f71yj801mqjcdgnx8fr0md) -- the ratchet baseline.
# Select with `-k ratchet`.
#
# The baseline is the COMMITTED data file `.claude/config/backend-doctor-
# baseline.json` (copied into each temp repo, never re-typed here). The
# measured evidence below is the file backend-doctor@1bda92f wrote for
# vantage-peers e85618d:
#   cd <backend-doctor@1bda92f> && npx tsx src/cli.ts <vp@e85618d>/convex \
#       --json-evidence <scratch>/
# plus `mechanical_rule_counts`, the per-rule field the gate requires. The
# doctor at 1bda92f does NOT emit that field; its values are the doctor's own
# stdout count lines for that run (`R-53: 113 site(s) VIOLATE`, ...). `sha` is
# rewritten to the temp repo's HEAD so the evidence pins the tree deployed.
# ---------------------------------------------------------------------------

BASELINE_REL = pathlib.Path(".claude/config/backend-doctor-baseline.json")
REAL_BASELINE = pathlib.Path(__file__).resolve().parents[2] / BASELINE_REL
# The ratchet MECHANISM is tested against the baseline as merged at 760b5d7
# (#1476), frozen here, because the committed baseline is meant to go DOWN with
# every lane PR: a test reading the live file as its fixture would turn red at
# the first lowering, which is exactly the change the ratchet exists to allow.
# The live file is checked separately: same command provenance, and no value
# above this frozen measurement.
E85618D_BASELINE = (pathlib.Path(__file__).resolve().parent / "tests" / "fixtures"
                    / "backend-doctor-baseline-e85618d.json")

MEASURED_E85618D = {
    "sha": "e85618d056f0dd0a39ea57ea70a3b85190a17bde",
    "cli_commit": "1bda92f854f8f851ea38af11511968df0c7042e5",
    "convex_path": "/root/coding/vantage-memory/.claude/worktrees/agent-a234d7faa2d009387/convex",
    "exit_code": 1,
    "checked": 51,
    "total": 52,
    "mechanical_violations": 7,
}
MEASURED_E85618D_RULE_COUNTS = {
    "R-2": 6, "R-8": 2, "R-13": 108, "R-28": 7, "R-31": 18, "R-52": 4, "R-53": 113,
}
# The live baseline was re-measured on ONE instrument (Pi order 2026-10-10, task
# k17d9dgcsjvwggvr1kc9daa32x8g0m6t): backend-doctor 0.3.0 @622caff on vantage-peers
# 6cc7950, `npx tsx src/cli.ts <vp@6cc7950>/convex --json-evidence <dir>/` ->
# `MECHANICAL RULE COUNTS: CR-2 251, R-5 62, R-53 254`. The live file may never exceed it.
MEASURED_6CC7950_RULE_COUNTS = {
    "R-2": 0, "R-8": 0, "R-13": 0, "R-28": 0, "R-31": 0, "R-52": 0, "R-53": 254, "R-5": 62,
    "CR-2": 251,
}


def _ratchet_repo(tmp, main_baseline=None, head_baseline=None):
    """Temp repo whose origin/main carries `main_baseline` (default: the real
    committed baseline) and whose HEAD carries `head_baseline` (default: same)."""
    repo, _ = _init_repo(tmp)
    real = json.loads(E85618D_BASELINE.read_text())
    on_main = real if main_baseline is None else main_baseline
    path = repo / BASELINE_REL
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(on_main, indent=2))
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "baseline")
    _git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    if head_baseline is not None:
        path.write_text(json.dumps(head_baseline, indent=2))
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "baseline edit")
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                          capture_output=True, text=True).stdout.strip()
    return repo, head


def _copy_baseline():
    return json.loads(E85618D_BASELINE.read_text())


def _write_measured(repo, head, counts=None, extra=None, mech=None):
    ev = dict(MEASURED_E85618D)
    ev["sha"] = head
    if counts is not False:
        ev["mechanical_rule_counts"] = dict(
            MEASURED_E85618D_RULE_COUNTS if counts is None else counts)
    if mech is not None:
        ev["mechanical_violations"] = mech
    if extra:
        ev.update(extra)
    (repo / "qa" / f"backend-doctor-{head}.json").write_text(json.dumps(ev))


def test_ratchet_baseline_values_carry_their_command():
    frozen = _copy_baseline()
    assert set(frozen["rules"]) == set(MEASURED_E85618D_RULE_COUNTS)
    for rule, entry in frozen["rules"].items():
        assert entry["count"] == MEASURED_E85618D_RULE_COUNTS[rule]
        assert entry["cli_commit"] == "1bda92f854f8f851ea38af11511968df0c7042e5"


def test_ratchet_live_baseline_carries_its_command_and_never_rose():
    live = json.loads(REAL_BASELINE.read_text())
    assert set(live["rules"]) <= set(MEASURED_6CC7950_RULE_COUNTS)
    for rule, entry in live["rules"].items():
        assert entry["command"].startswith("cd ")
        assert "npx tsx src/cli.ts" in entry["command"]
        assert entry["output_line"].startswith(f"{rule}: {entry['count']} ")
        assert entry["cli_commit"]
        assert entry["count"] <= MEASURED_6CC7950_RULE_COUNTS[rule], rule


def test_ratchet_block_one_more_r53_site():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _ratchet_repo(tmp)
        counts = dict(MEASURED_E85618D_RULE_COUNTS, **{"R-53": 114})
        _write_measured(repo, head, counts=counts)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "ratchet" and "R-53" in msg and "114" in msg
        assert _run(repo) == 2


def test_ratchet_block_raised_baseline_vs_origin_main():
    with tempfile.TemporaryDirectory() as tmp:
        raised = _copy_baseline()
        raised["rules"]["R-53"]["count"] = 114
        repo, head = _ratchet_repo(tmp, head_baseline=raised)
        counts = dict(MEASURED_E85618D_RULE_COUNTS, **{"R-53": 114})
        _write_measured(repo, head, counts=counts)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "ratchet" and "origin/main" in msg and "R-53" in msg
        assert _run(repo) == 2


def test_ratchet_block_new_rule_added_to_baseline_vs_origin_main():
    with tempfile.TemporaryDirectory() as tmp:
        widened = _copy_baseline()
        widened["rules"]["R-3"] = dict(widened["rules"]["R-2"], count=1)
        repo, head = _ratchet_repo(tmp, head_baseline=widened)
        _write_measured(repo, head,
                        counts=dict(MEASURED_E85618D_RULE_COUNTS, **{"R-3": 1}),
                        mech=8)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "ratchet" and "R-3" in msg
        assert _run(repo) == 2


def test_ratchet_block_reopened_zero_lane_vs_origin_main():
    with tempfile.TemporaryDirectory() as tmp:
        lane = _copy_baseline()
        lane["rules"]["R-53"]["modules"] = {"convex/diary.ts": 0}
        reopened = _copy_baseline()  # the zero lane deleted on the branch
        repo, head = _ratchet_repo(tmp, main_baseline=lane, head_baseline=reopened)
        _write_measured(repo, head)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "ratchet" and "convex/diary.ts" in msg
        assert _run(repo) == 2


def test_ratchet_block_red_mechanical_rule_not_in_baseline():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _ratchet_repo(tmp)
        _write_measured(repo, head,
                        counts=dict(MEASURED_E85618D_RULE_COUNTS, **{"R-3": 1}),
                        mech=8)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "ratchet" and "R-3" in msg
        assert "not in the baseline" in msg
        assert _run(repo) == 2


def test_ratchet_block_raw_doctor_evidence_without_per_rule_counts():
    """backend-doctor@1bda92f's evidence carries only the TOTAL (7 red rules).
    A total cannot show which rules are red nor how many sites each has, so the
    gate refuses rather than compare totals."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _ratchet_repo(tmp)
        _write_measured(repo, head, counts=False)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "incomplete" and "mechanical_rule_counts" in msg
        assert _run(repo) == 2


def test_ratchet_block_counts_disagree_with_mechanical_violations():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _ratchet_repo(tmp)
        counts = {k: v for k, v in MEASURED_E85618D_RULE_COUNTS.items()
                  if k != "R-31"}
        _write_measured(repo, head, counts=counts)  # 6 red listed, total says 7
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "incomplete" and "mechanical_violations" in msg
        assert _run(repo) == 2


def test_ratchet_block_site_in_zero_lane_module():
    with tempfile.TemporaryDirectory() as tmp:
        lane = _copy_baseline()
        lane["rules"]["R-53"]["modules"] = {"convex/diary.ts": 0}
        repo, head = _ratchet_repo(tmp, main_baseline=lane)
        _write_measured(repo, head, extra={
            "mechanical_rule_module_counts": {"R-53": {"convex/diary.ts": 1}},
        })
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "ratchet" and "convex/diary.ts" in msg
        assert _run(repo) == 2


def test_ratchet_block_zero_lane_without_module_counts():
    with tempfile.TemporaryDirectory() as tmp:
        lane = _copy_baseline()
        lane["rules"]["R-53"]["modules"] = {"convex/diary.ts": 0}
        repo, head = _ratchet_repo(tmp, main_baseline=lane)
        _write_measured(repo, head)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "incomplete"
        assert "mechanical_rule_module_counts" in msg
        assert _run(repo) == 2


def test_ratchet_block_baseline_absent_on_origin_main():
    """An unmerged baseline certifies nothing: it has never been reviewed."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, _ = _init_repo(tmp)
        _git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        path = repo / BASELINE_REL
        path.parent.mkdir(parents=True)
        path.write_text(E85618D_BASELINE.read_text())
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "unmerged baseline")
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                              capture_output=True, text=True).stdout.strip()
        _write_measured(repo, head)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "ratchet" and "origin/main" in msg
        assert _run(repo) == 2


def test_ratchet_pass_measured_e85618d_at_baseline():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _ratchet_repo(tmp)
        _write_measured(repo, head)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "pass", msg
        assert _run(repo) == 0


def test_ratchet_pass_lowered_count():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _ratchet_repo(tmp)
        counts = dict(MEASURED_E85618D_RULE_COUNTS, **{"R-53": 112})
        _write_measured(repo, head, counts=counts)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "pass", msg
        assert "R-53" in msg and "112" in msg  # names room to lower the baseline
        assert _run(repo) == 0


def test_ratchet_pass_lowered_baseline_vs_origin_main():
    with tempfile.TemporaryDirectory() as tmp:
        lowered = _copy_baseline()
        lowered["rules"]["R-53"]["count"] = 112
        repo, head = _ratchet_repo(tmp, head_baseline=lowered)
        _write_measured(repo, head,
                        counts=dict(MEASURED_E85618D_RULE_COUNTS, **{"R-53": 112}))
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "pass", msg
        assert _run(repo) == 0


def test_ratchet_pass_rule_gone_green_drops_out():
    with tempfile.TemporaryDirectory() as tmp:
        repo, head = _ratchet_repo(tmp)
        counts = dict(MEASURED_E85618D_RULE_COUNTS, **{"R-8": 0})
        _write_measured(repo, head, counts=counts, mech=6)
        verdict, msg = _mod.evaluate(str(repo), str(repo))
        assert verdict == "pass", msg
        assert _run(repo) == 0
