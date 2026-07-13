"""VR <-> packaged plugin parity gate (Day 130 incident close).

Wraps scripts/vr_plugin_parity.py in a pytest that fails CI loudly on any
divergence, missing-from-VR item, or VR-unreachable condition. See
scripts/vr_plugin_parity.py module docstring for the full design rationale
and non-negotiable constraints (coverage-from-artifact, no silent third
state, fail-loud, anti-silence sanity check).
"""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import vr_plugin_parity  # noqa: E402
from vr_plugin_parity import (  # noqa: E402
    DEFAULT_VR_URL,
    VR_TOKEN_ENV,
    VR_URL_ENV,
    VRUnreachableError,
    run_gate,
)

# ---------------------------------------------------------------------------
# OFFLINE bite tests — the two properties the gate exists for.
#
# Eta's review of PR #1087 caught this, and it is the same blind spot he caught
# on #1086 two hours earlier: neutralising the gate's failure condition
# (`ParityResult.ok` -> always True) reddened NOT ONE test. Every green test
# belonged to the leak guard. Against a CLEAN VR, the live test only ever
# asserts that everything MATCHes — it never exercises DIVERGED or
# MISSING_FROM_VR. So the gate's two central properties were guarded by nothing.
#
# A manual probe proves the gate bites TODAY. A test proves it bites TOMORROW.
# A guard that is placed but never proven to bite is indistinguishable from a
# guard that is absent — my own argument, turned back on me, correctly.
#
# These run OFFLINE (no token, no network): they serve a fake VR by patching
# fetch_vr_content, so CI exercises the failure paths even without the secret.
# ---------------------------------------------------------------------------


def _fake_vr(monkeypatch, responder):
    """Serve a fake VR. `responder(item_name) -> dict` (VR's inner payload)."""
    def _fetch(url, token, tool_name, item_name):  # noqa: ARG001
        return responder(item_name)

    monkeypatch.setattr(vr_plugin_parity, "fetch_vr_content", _fetch)


def test_gate_fails_and_names_a_diverged_item(monkeypatch):
    """A packaged file that does not match its canonical -> FAIL, naming it."""
    def responder(item_name):
        # Every canonical returns content the packaged file cannot possibly equal.
        return {
            "content": f"### canonical body for {item_name} that the package does not have\n",
            "contentHash": "deadbeef" * 8,
            "contentVersion": "9.9.9",
        }

    _fake_vr(monkeypatch, responder)
    results, passed = run_gate("http://fake-vr.invalid/mcp", "fake-token")

    assert not passed, "gate passed while every packaged file diverged from canonical"
    diverged = [r for r in results if r.verdict == "DIVERGED"]
    assert diverged, f"no DIVERGED verdict produced; got {sorted({r.verdict for r in results})}"
    # It must NAME what it found — "something is wrong" is not actionable.
    assert all(r.name for r in diverged)
    assert any(r.kind == "skill" for r in diverged)


def test_gate_fails_and_names_an_item_missing_from_vr(monkeypatch):
    """A packaged item absent from VR, with no written exemption -> FAIL, naming it.

    `session-end.py` is the one legitimately-absent item and carries a written
    reason, so it must stay SKIPPED and must not be what makes this test pass.
    """
    def responder(item_name):
        # This is the shape fetch_vr_content returns for an item VR does not have.
        return {"__absent__": True, "error": f"VR has no content registered for {item_name!r}"}

    _fake_vr(monkeypatch, responder)
    results, passed = run_gate("http://fake-vr.invalid/mcp", "fake-token")

    assert not passed, "gate passed while packaged items were absent from VR"
    missing = [r for r in results if r.verdict == "MISSING_FROM_VR"]
    assert missing, f"no MISSING_FROM_VR verdict produced; got {sorted({r.verdict for r in results})}"
    assert all(r.name for r in missing)
    # The written-reason exemption must not be the thing carrying this test.
    assert any(r.name != "session-end.py" for r in missing)


def _require_token() -> str:
    token = os.environ.get(VR_TOKEN_ENV)
    if not token:
        pytest.fail(
            f"{VR_TOKEN_ENV} not set. The VR parity gate cannot authenticate "
            "and must not silently pass without checking. Set the secret in CI."
        )
    return token


def test_packaged_plugin_matches_vr_canonical():
    token = _require_token()
    url = os.environ.get(VR_URL_ENV, DEFAULT_VR_URL)

    try:
        results, passed = run_gate(url, token)
    except VRUnreachableError as exc:
        pytest.fail(f"VR parity gate could not resolve source of truth: {exc}")

    lines = [f"{r.kind:6} {r.name:30} {r.verdict}" for r in results]
    report = "\n".join(lines)

    if not passed:
        failing = [r for r in results if not r.ok]
        detail = "\n\n".join(
            f"{r.kind} {r.name}: {r.verdict}\n{r.reason or ''}\n{r.diff or ''}"
            for r in failing
        )
        pytest.fail(
            f"Packaged plugin sources diverged from VantageRegistry canonical:\n{detail}\n\n"
            f"Full report:\n{report}"
        )


def test_gate_fails_when_vr_unreachable():
    """RED probe: point at an unreachable endpoint, gate must FAIL not pass.

    Uses a closed local port (connection-refused, fails fast) rather than a
    blackholed routable address (which can hang for the full socket timeout
    and slow CI) -- both are "VR unreachable", but this one is fast and
    deterministic.

    Per-item VR failures are caught inside check_item() and surfaced as
    VR_UNREACHABLE verdicts (not a raised exception) so the report still
    names every item -- run_gate() only raises for the artifact-level
    failures (zero packaged items / coverage gap). Fail-loud here means
    `passed` must be False and every result must be tagged VR_UNREACHABLE,
    never silently MATCH/SKIPPED.
    """
    token = _require_token()
    results, passed = run_gate("http://127.0.0.1:1/mcp-unreachable", token)
    assert passed is False, "gate must not pass when VR is unreachable"
    assert results, "gate must still enumerate + report items even when VR is unreachable"
    assert any(r.verdict == "VR_UNREACHABLE" for r in results), (
        "at least one item must report VR_UNREACHABLE -- a gate that cannot reach "
        "its source of truth must say so, not silently pass"
    )
    # SECRECY > PARITY: the local leak check runs BEFORE the VR fetch, so a
    # packaged file that itself leaks is reported as LEAK_IN_PACKAGED even when
    # VR is down (correctly -- a live disclosure does not need VR's opinion).
    # The one thing that must never happen is a green verdict without VR.
    for r in results:
        assert r.verdict in ("VR_UNREACHABLE", "LEAK_IN_PACKAGED"), (
            f"{r.kind} {r.name} got verdict {r.verdict!r} with VR unreachable "
            "-- no item may be validated as MATCH/SKIPPED without the source of truth"
        )
