"""Bipolar probe for the Layer-2 fresh-state hook (artifacts/, not installed).

The hook re-reads a state TYPED in a message and refuses the send when the prose
contradicts reality. The danger is not that it misses something — Layer 1 (server-side
state tokens) is what actually closes the class. The danger is that it blocks something
LEGITIMATE, because a guard you must route around in order to tell the truth is a guard
that gets ripped out, and then it guards nothing.

So this probe has TWO poles, and the MUST_PASS pole is the one that matters here.

The first version of the hook scanned the WHOLE message body and blocked this:

    finding: at the time I gated it, PR #870 -> OPEN — that is what I cited, and it
             was true.

Exact. Lawful. Honest. Refused, because the PR had merged since. The sentence says
"at the time"; the guard heard only the current tree.

Worse, the hook's own docstring PROMISED that carve-out, on the theory that past-tense
prose says "was" and never "->". The theory was false: the arrow IS our proof syntax,
quoted in past-tense narration constantly, precisely because it is the form the proof
was produced in. A guard documenting an exemption it does not grant is a lying contract
inside the guard itself.

The fix is SCOPE, not grammar: only `evidence:` — where a live state is ASSERTED — is
scanned. `finding:` / `action:` / `next:` are where one NARRATES, and are never touched.

Caught by Eta on PR #1094. He proved the false positive before asking for the fix.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
HOOK = REPO_ROOT / "artifacts" / "enforce-fresh-state-in-messages.py"

REPO = "vantageos-agency/vantage-peers"


def run_hook(content: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"tool_input": {"content": content}}),
        capture_output=True,
        text=True,
    )


def test_hook_artifact_exists():
    assert HOOK.is_file(), (
        f"{HOOK} is missing. A probe that cannot find its subject passes vacuously — "
        "which is the failure this whole suite exists to prevent."
    )


# ─── MUST_PASS ────────────────────────────────────────────────────────────────
# The pole that decides whether this guard survives contact with real reviewers.

MUST_PASS = [
    pytest.param(
        f"evidence:  ratio 788/788\n"
        f"finding:   at the time I gated it, PR #870 ({REPO}) -> OPEN — that is what I "
        f"cited, and it was true.\n",
        id="historical-citation-in-arrow-form (the exact case that used to break)",
    ),
    pytest.param(
        f"evidence:  npx vitest run -> 788/788 ; git rev-parse HEAD -> f972cd9\n"
        f"finding:   the mutation compiles, so the red is behavioural.\n",
        id="content-proofs-only (ratios, SHAs — these do not expire)",
    ),
    pytest.param(
        f"action:    ETA -> re-gate PR #1091 ({REPO}) when the branch settles.\n",
        id="arrow-in-action-field (routing, not a state assertion)",
    ),
    pytest.param(
        "finding:   we are making progress.\n",
        id="no-claim-at-all",
    ),
]


@pytest.mark.parametrize("content", MUST_PASS)
def test_must_pass_legitimate_messages_are_never_blocked(content):
    proc = run_hook(content)
    assert proc.returncode == 0, (
        "FALSE POSITIVE — the hook blocked a legitimate message:\n"
        f"{content}\nstderr: {proc.stderr}\n\n"
        "A reviewer who cannot quote his own evidence will route around this hook, "
        "and then it guards nothing at all."
    )


# ─── MUST_BLOCK ───────────────────────────────────────────────────────────────
# Without this pole, the fix above would be indistinguishable from deleting the guard.


def test_must_block_stale_live_state_asserted_in_evidence():
    """A state ASSERTED as current, in the field reserved for assertions, that
    contradicts reality -> refused, citing BOTH values."""
    content = f"evidence:  PR #1092 ({REPO}) -> MERGED\n"
    proc = run_hook(content)

    if proc.returncode == 0 and "cannot verify" in (proc.stderr or "").lower():
        pytest.skip(
            "GitHub unreachable from this runner — the hook correctly declined to "
            "conclude rather than blocking on a network failure. Not a pass; a "
            "stated inability, which is exactly what it must do."
        )

    assert proc.returncode != 0, (
        "MISSED — a stale live-state assertion in `evidence:` was allowed through. "
        "Narrowing the scan scope must not amount to switching the guard off:\n"
        f"stderr: {proc.stderr}"
    )
    assert "MERGED" in proc.stderr and "OPEN" in proc.stderr, (
        "The block must name BOTH values — the one typed and the one that is real. "
        f"A refusal that does not say what it saw is not actionable.\nstderr: {proc.stderr}"
    )
