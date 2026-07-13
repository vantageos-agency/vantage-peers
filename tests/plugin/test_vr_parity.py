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

from vr_plugin_parity import (  # noqa: E402
    DEFAULT_VR_URL,
    VR_TOKEN_ENV,
    VR_URL_ENV,
    VRUnreachableError,
    run_gate,
)


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
