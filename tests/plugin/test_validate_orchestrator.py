"""validate-orchestrator.py — THREE outcomes, not two (Day 131).

Before this fix, every infrastructure failure that stops this script from
even STANDING UP the instrument -- CONVEX_URL unresolved, the `bun` binary
absent, the MCP server never answering the initialize handshake -- was an
UNCAUGHT Python exception. Python's default exit code for an uncaught
exception is 1, the SAME code `run_tests` uses when a validator genuinely
FAILS. "the server never came up" and "a validator broke" were
indistinguishable on the only signal CI looks at.

MUST_REFUSE cases below remove the instrument (no CONVEX_URL, `bun` not on
PATH, an MCP server that never answers) and assert exit 2 with a message
naming what was missing -- derived by construction (empty PATH / unset env),
not hand-typed strings that can rot.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARD = REPO_ROOT / "scripts" / "validate-orchestrator.py"


def run(env):
    return subprocess.run(
        [sys.executable, str(GUARD), "sigma"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )


def test_must_refuse_missing_convex_url(tmp_path):
    """No CONVEX_URL in env, and no .env.local to fall back to."""
    fake_home = tmp_path  # irrelevant here; ENV_LOCAL is PROJECT_ROOT/.env.local
    env = {k: v for k, v in os.environ.items() if k != "CONVEX_URL"}
    env["PATH"] = os.environ.get("PATH", "")
    env_local = REPO_ROOT / ".env.local"
    if env_local.is_file():
        pytest.skip(
            f"{env_local} exists in this checkout and would supply CONVEX_URL — "
            "cannot construct the 'neither env var nor file' refusal state here."
        )
    p = run(env)
    assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "REFUSAL" in p.stderr
    assert "CONVEX_URL" in p.stderr


def test_must_refuse_missing_bun_binary(tmp_path):
    """CONVEX_URL resolves, but `bun` is not reachable on PATH at all."""
    empty_bin = tmp_path / "emptybin"
    empty_bin.mkdir()
    env = dict(os.environ)
    env["CONVEX_URL"] = "https://example-deployment.convex.cloud"
    env["PATH"] = str(empty_bin)  # no `bun` anywhere on this PATH
    p = run(env)
    assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "REFUSAL" in p.stderr
    assert "bun" in p.stderr.lower() or "spawn" in p.stderr.lower()
