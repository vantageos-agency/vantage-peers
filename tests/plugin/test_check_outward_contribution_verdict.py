"""Bipolar probe: an outside contribution with no verdict is silent.

Task k176fxspcaqea13ezm831mzkbx8ez0p9. vantageos-agency/vantage-peers #1306, opened by
`bertux` on 2026-09-21T11:15:53Z, carried no verdict for two days. Nothing went red, no
queue entry aged, no message waited — the coordinator found it by listing pull requests
by hand.

BOTH POLES, or this proves nothing:
  MUST_REPORT — the #1306 state: an outside author, open, and the only fleet comments
                are a gate bounce and its retraction. A detector never shown red on the
                case that motivated it proves nothing.
  MUST_PASS   — the same contribution once ANSWERED (APPROVED and REVISE are both
                answers), and a fleet pull request with no verdict at all (not this
                detector's business).

And the third thing this class is really about: the EMPTY case and the UNREADABLE case
must be distinguishable AT THE OUTPUT. This fleet measured on Day 158 that a passing
check and an absent check render identically — eleven workflow files that could not run,
a branch protection requiring nothing. `test_empty_and_unreadable_are_distinguishable`
is the assertion that keeps this detector out of that set.

Offline throughout: the network poles are run by command and recorded in the task
report; these tests drive the same classifier through `--snapshot` and `--self-test`.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CHECK = REPO_ROOT / "scripts" / "check-outward-contribution-verdict.py"

AS_OF = "2026-09-23T12:00:00Z"

OUTSIDE_PR = {
    "number": 1306,
    "author": "bertux",
    "title": "fix(docs): move a section in the README",
    "url": "https://example.invalid/pull/1306",
    "createdAt": "2026-09-21T11:15:53Z",
    "closedAt": None,
    "mergedAt": None,
    "comments": [
        # A gate bounce, and its retraction four minutes later. Neither is an answer.
        {
            "author": "elpiarthera",
            "createdAt": "2026-09-21T11:20:33Z",
            "body": "NO GATE - SELF-GATE block not filled. Thanks for the contribution.",
        },
        {
            "author": "elpiarthera",
            "createdAt": "2026-09-21T11:24:32Z",
            "body": "A correction: you do not need to fill in the SELF-GATE block.",
        },
    ],
    "reviews": [],
}

FLEET_PR = {
    "number": 1329,
    "author": "elpiarthera",
    "title": "a fleet pull request with no verdict",
    "url": "",
    "createdAt": "2026-09-23T00:00:00Z",
    "closedAt": None,
    "mergedAt": None,
    "comments": [],
    "reviews": [],
}


def snapshot(tmp_path, pulls, members=("elpiarthera", "eta-vantageteam")):
    path = tmp_path / "snapshot.json"
    path.write_text(
        json.dumps(
            {
                "repo": "vantageos-agency/vantage-peers",
                "membersSource": "fixture",
                "members": list(members),
                "pulls": pulls,
            }
        ),
        encoding="utf-8",
    )
    return path


def run(args, env=None):
    return subprocess.run(
        [sys.executable, str(CHECK), *args],
        capture_output=True,
        text=True,
        env=env,
    )


def run_snapshot(path, extra=()):
    return run(["--snapshot", str(path), "--as-of", AS_OF, *extra])


# ── MUST_REPORT ──────────────────────────────────────────────────────────────


def test_the_case_that_motivated_this_reports_red(tmp_path):
    """#1306 in the state the coordinator found it: open, outside, unanswered."""
    result = run_snapshot(snapshot(tmp_path, [OUTSIDE_PR, FLEET_PR]))
    assert result.returncode == 1, result.stdout + result.stderr
    assert "#1306" in result.stdout
    assert "bertux" in result.stdout  # property 3: the output names the AUTHOR
    assert "2d 0h" in result.stdout  # property 3: ...and the AGE


def test_a_gate_bounce_is_not_a_verdict(tmp_path):
    """The NO GATE comment landed five minutes in and was retracted four minutes later.
    Counting it as an answer would render #1306 green for the two days it was silent."""
    only_bounce = {**OUTSIDE_PR, "comments": OUTSIDE_PR["comments"][:1]}
    assert run_snapshot(snapshot(tmp_path, [only_bounce])).returncode == 1


def test_the_author_cannot_answer_their_own_contribution(tmp_path):
    self_verdict = {
        **OUTSIDE_PR,
        "comments": [
            {
                "author": "bertux",
                "createdAt": "2026-09-21T12:01:47Z",
                "body": "This is APPROVED on my side.",
            }
        ],
    }
    assert run_snapshot(snapshot(tmp_path, [self_verdict])).returncode == 1


def test_a_verdict_from_outside_the_fleet_is_not_a_verdict(tmp_path):
    bystander = {
        **OUTSIDE_PR,
        "comments": [
            {
                "author": "some-passer-by",
                "createdAt": "2026-09-21T12:01:47Z",
                "body": "Looks APPROVED to me.",
            }
        ],
    }
    assert run_snapshot(snapshot(tmp_path, [bystander])).returncode == 1


def test_a_verdict_landing_after_the_horizon_does_not_answer_it_before(tmp_path):
    """#1306's real APPROVED arrived at 2026-09-23T14:05Z. At noon it was still silent."""
    late = {
        **OUTSIDE_PR,
        "comments": OUTSIDE_PR["comments"]
        + [
            {
                "author": "elpiarthera",
                "createdAt": "2026-09-23T14:05:41Z",
                "body": "Eta - APPROVED",
            }
        ],
    }
    assert run_snapshot(snapshot(tmp_path, [late])).returncode == 1


# ── MUST_PASS ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "body",
    [
        "Eta - APPROVED - vantageos-agency/vantage-peers #1306 at cc6dc91",
        "Eta - REVISE - please split this in two.",
        "CHANGES_REQUESTED: the test is missing its red pole.",
        "[MERGE-APPROVED]",
    ],
)
def test_any_verdict_is_an_answer(tmp_path, body):
    """Property 2: APPROVED and REVISE are both answers; only silence is the defect."""
    answered = {
        **OUTSIDE_PR,
        "comments": OUTSIDE_PR["comments"]
        + [{"author": "elpiarthera", "createdAt": "2026-09-22T09:00:00Z", "body": body}],
    }
    result = run_snapshot(snapshot(tmp_path, [answered]))
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_github_review_state_is_an_answer_without_body_text(tmp_path):
    reviewed = {
        **OUTSIDE_PR,
        "reviews": [
            {
                "author": "eta-vantageteam",
                "submittedAt": "2026-09-22T09:00:00Z",
                "state": "CHANGES_REQUESTED",
                "body": "",
            }
        ],
    }
    assert run_snapshot(snapshot(tmp_path, [reviewed])).returncode == 0


def test_a_merged_contribution_is_not_open(tmp_path):
    merged = {
        **OUTSIDE_PR,
        "closedAt": "2026-09-22T00:00:00Z",
        "mergedAt": "2026-09-22T00:00:00Z",
    }
    assert run_snapshot(snapshot(tmp_path, [merged])).returncode == 0


def test_a_fleet_pull_request_is_not_this_detectors_business(tmp_path):
    assert run_snapshot(snapshot(tmp_path, [FLEET_PR])).returncode == 0


# ── the empty case, the unreadable case, and the gap between them ────────────


def test_the_empty_run_states_the_scope_it_examined(tmp_path):
    """A clean run over nothing must SAY it read nothing, never print nothing."""
    result = run_snapshot(snapshot(tmp_path, [FLEET_PR]))
    assert result.returncode == 0
    assert "SCOPE: vantageos-agency/vantage-peers" in result.stdout
    assert "open pull requests examined: 1" in result.stdout
    assert "outside contributions among them: 0" in result.stdout
    assert "fleet membership: 2 login(s)" in result.stdout


def test_an_unreadable_scope_refuses_rather_than_passing(tmp_path):
    """No `gh` on PATH: the repository cannot be read. That is not a clean run."""
    env = {"PATH": str(tmp_path), "HOME": str(tmp_path)}
    result = run(["--repo", "vantageos-agency/vantage-peers"], env=env)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "REFUSING TO JUDGE" in result.stderr
    assert "gh" in result.stderr  # names what it could not read with


def test_a_membership_read_that_resolves_nobody_is_a_refusal(tmp_path):
    result = run_snapshot(snapshot(tmp_path, [OUTSIDE_PR], members=()))
    assert result.returncode == 2
    assert "REFUSING TO JUDGE" in result.stderr


def test_no_scope_at_all_is_a_refusal():
    result = run([])
    assert result.returncode == 2
    assert "no scope to examine" in result.stderr


def test_a_malformed_as_of_is_a_refusal(tmp_path):
    result = run(["--snapshot", str(snapshot(tmp_path, [])), "--as-of", "last tuesday"])
    assert result.returncode == 2
    assert "ISO-8601" in result.stderr


def test_empty_and_unreadable_are_distinguishable(tmp_path):
    """THE assertion of this file. A passing check and an absent check must not render
    identically — that equivalence is the whole defect class."""
    empty = run_snapshot(snapshot(tmp_path, [FLEET_PR]))
    unreadable = run(
        ["--repo", "vantageos-agency/vantage-peers"],
        env={"PATH": str(tmp_path), "HOME": str(tmp_path)},
    )
    assert empty.returncode != unreadable.returncode
    assert (empty.stdout + empty.stderr) != (unreadable.stdout + unreadable.stderr)
    assert "REFUSING TO JUDGE" not in (empty.stdout + empty.stderr)
    assert "CLEAN" not in (unreadable.stdout + unreadable.stderr)


# ── the probe itself ─────────────────────────────────────────────────────────


def test_self_test_passes_both_poles():
    result = run(["--self-test"])
    assert result.returncode == 0, result.stdout + result.stderr
    assert "SELF-TEST PASS" in result.stdout


def test_self_test_is_red_provable(tmp_path):
    """Blunt the verdict vocabulary and the probe must FAIL. A self-test that cannot
    fail is a green light wired to nothing."""
    source = CHECK.read_text(encoding="utf-8")
    blunted = source.replace(
        'VERDICT_PATTERNS = [\n    r"\\bAPPROVED\\b",',
        'VERDICT_PATTERNS = [\n    r"\\bNO GATE\\b",',
        1,
    )
    assert blunted != source, "the mutation did not apply — fix this test, not the script"
    mutant = tmp_path / "mutant.py"
    mutant.write_text(blunted, encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(mutant), "--self-test"], capture_output=True, text=True
    )
    assert result.returncode == 1
    assert "SELF-TEST FAIL" in result.stderr
