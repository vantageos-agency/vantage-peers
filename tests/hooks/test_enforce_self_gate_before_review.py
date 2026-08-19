"""Bipolar bite-probe for enforce-self-gate-before-review.py.

Held to the hook-vitality-bite-probe standard: every MUST-REFUSE pole is shown
able to go red, every MUST-PASS pole green, and — the point of task
k172efyv1rrd8az0dxwhm74snx8cshk5 — the unreadable-body refusal NAMES the timing
(the guard reads --body-file BEFORE the command runs) and the separate-step
remedy, not merely "could not read".

The hook reads a PreToolUse payload on stdin and exits 2 to block, 0 to allow.
It is invoked here as a subprocess on its real path, the way the harness calls it.
"""

import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(
    os.path.dirname(__file__), "..", "..", ".claude", "hooks",
    "enforce-self-gate-before-review.py",
)

FILLED_SELF_GATE = (
    "## Summary\nDoes a thing.\n\n"
    "SELF-GATE:\n"
    "- refs: repo owner/name, branch x, base main, commit deadbeef\n"
    "- counts: 2 files changed, +10 -1; tests 5/5\n"
    "- standard: reuse-first; RED-before-GREEN; frontier named\n"
    "- scope: the one thing; not the other. I do not merge.\n\n"
    "Orchestrator: Sigma — VantagePeers | 2026-08-19\n"
)


def run(command: str):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    p = subprocess.run(
        [sys.executable, HOOK],
        input=payload, capture_output=True, text=True,
    )
    return p.returncode, p.stderr


# ---- MUST REFUSE (exit 2) ---------------------------------------------------

def test_refuse_body_file_missing():
    code, err = run('gh pr create -R o/r --title t --body-file /tmp/does-not-exist-xyz.md  # via-open-pr')
    assert code == 2, err
    # The obligation this task adds: the refusal names the timing and the remedy.
    low = err.lower()
    assert "before the command runs" in low, f"refusal must name the timing:\n{err}"
    assert "separate step" in low, f"refusal must name the separate-step remedy:\n{err}"


def test_refuse_no_body_flag_at_all():
    code, err = run('gh pr create -R o/r --title t  # via-open-pr')
    assert code == 2, err


def test_refuse_inline_body_without_self_gate():
    code, err = run('gh pr create -R o/r --title t --body "just a summary, no gate"  # via-open-pr')
    assert code == 2, err


# ---- MUST PASS (exit 0) -----------------------------------------------------

def test_pass_body_file_written_in_a_separate_step():
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
        fh.write(FILLED_SELF_GATE)
        path = fh.name
    try:
        code, err = run(f'gh pr create -R o/r --title t --body-file {path}  # via-open-pr')
        assert code == 0, err
    finally:
        os.unlink(path)


def test_pass_inline_body_with_filled_gate():
    body = FILLED_SELF_GATE.replace('"', "'")
    code, err = run(f'gh pr create -R o/r --title t --body "{body}"  # via-open-pr')
    assert code == 0, err


def test_pass_override_marker():
    code, err = run('gh pr create -R o/r --title t --body-file /tmp/nope.md  # allow-self-gate-skip: scaffolding-only PR')
    assert code == 0, err


def test_pass_not_a_pr_create():
    code, err = run('git status')
    assert code == 0, err


# ---- The refusal text is capable of going red (RED-before-GREEN evidence) ----

def test_timing_language_is_a_real_assertion():
    """If the refusal reverted to the old symptom-only wording, the timing
    assertion in test_refuse_body_file_missing would fail — proving that test
    measures the new obligation, not a tautology."""
    _, err = run('gh pr create -R o/r --title t --body-file /tmp/does-not-exist-xyz.md  # via-open-pr')
    old_symptom_only = (
        "A review is never requested without a readable, filled SELF-GATE\n"
        "block. Run the `self-gate` skill first, then pass the resulting\n"
        "body via --body or a readable --body-file.\n"
    )
    assert "before the command runs" not in old_symptom_only.lower()
    assert "before the command runs" in err.lower()


# ---- FOREIGN MATERIAL (Eta REVISE #1210) ------------------------------------
# The fifth-line poles the delivered probe LACKED — proven on omega's real #323
# body (not the matcher author's own vocabulary), sub-fields blanked one at a
# time, the exact material Pi/Eta/omega reproduced the hole on. These fixtures
# are vendored under fixtures/ so the probe is reproducible off this station.

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def run_body_file(path: str):
    return run(f'gh pr create -R o/r --title t --body-file {path}  # via-open-pr')


def test_refuse_foreign_323_all_fields_blank():
    """Omega's real #323 body with ALL FOUR SELF-GATE sub-fields blanked. Before
    the `[ \\t]` fix this walked through at exit 0: `\\s` crossed the newline, so
    each blank field's `(.*)` captured its successor's line and none read empty.
    MUST refuse, naming every field."""
    code, err = run_body_file(os.path.join(FIXTURES, "selfgate-323-blank-all.md"))
    assert code == 2, f"all-blank foreign body must refuse:\n{err}"
    low = err.lower()
    for field in ("refs", "counts", "standard", "scope"):
        assert field in low, f"refusal must name the empty field '{field}':\n{err}"


def test_refuse_foreign_323_scope_blank():
    """The same real #323 body with only `- scope:` blanked (the last field, whose
    borrowed successor was the signature line). MUST refuse, naming scope."""
    code, err = run_body_file(os.path.join(FIXTURES, "selfgate-323-blank-scope.md"))
    assert code == 2, f"scope-blank foreign body must refuse:\n{err}"
    assert "scope" in err.lower(), f"refusal must name scope:\n{err}"


def test_pass_foreign_323_full_body():
    """The SAME real #323 body, unblanked — MUST still pass. Proves the `[ \\t]`
    fix refuses the blanks without over-refusing a genuinely filled foreign body."""
    code, err = run_body_file(os.path.join(FIXTURES, "selfgate-323-full.md"))
    assert code == 0, f"a real filled foreign body must pass:\n{err}"


def test_refuse_undecodable_body_file():
    """A non-UTF-8 --body-file. UnicodeDecodeError is a ValueError, not an
    OSError, so before the fix it escaped extract_body to the top-level
    `except Exception: allowing` and passed at exit 0 — a bypass with no override
    marker, against the guard's own fail-loud contract. MUST refuse."""
    with tempfile.NamedTemporaryFile("wb", suffix=".md", delete=False) as fh:
        fh.write(b"\xff\xfe\x00\x01 not valid utf-8 \x80\x81\x82 SELF-GATE:")
        path = fh.name
    try:
        code, err = run_body_file(path)
        assert code == 2, f"an undecodable body file must refuse, not allow:\n{err}"
    finally:
        os.unlink(path)
