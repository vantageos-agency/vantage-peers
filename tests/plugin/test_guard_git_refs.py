"""Bipolar probe: a branch name is publication.

Day 128: four branches named after clients reached the PUBLIC repo. The code inside them
was clean. THE LEAK WAS THE NAME — visible in `git ls-remote`, in the PR title, in every
notification e-mail, in the branch dropdown, to anyone on earth.

A ref is the third surface, after file contents and file names, and it is the only one
that publishes itself the instant you type `git push`. No content scan has ever seen it:
it lives in `.git`, never appears in a diff, and survives every purge.

BOTH POLES, or this proves nothing:
  MUST_BLOCK — a client identity in a ref, through EVERY separator a ref can use.
  MUST_PASS  — benign names, including ones that merely contain those letters inside a
               longer word. A guard that blocks `fix/summaries-pagination` is uninstalled
               within the day, and an uninstalled guard blocks nothing at all.

Fictive identity throughout: this file is tracked in a public repo, and describing a leak
by reproducing it republishes it.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARD = REPO_ROOT / "scripts" / "guard_git_refs.py"

FICTIVE = {
    "organizations": ["Zorblatt Holdings"],
    "contacts": ["Marisol Quibberly"],
    "commercial_names": [],
    "aliases": ["quibbernet-9"],
}


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    p = tmp_path / "identities.json"
    p.write_text(json.dumps(FICTIVE), encoding="utf-8")
    monkeypatch.setenv("VANTAGE_CLIENT_IDENTITIES", str(p))
    return p


def run(refs, env_ok=True, tmp_path=None):
    return subprocess.run(
        [sys.executable, str(GUARD), *refs, "--repo", str(REPO_ROOT)],
        capture_output=True, text=True,
    )


MUST_BLOCK = [
    # Every separator a ref can be built out of. `\b` alone is blind to the underscore.
    "fix/marisol-quibberly-drop-global",
    "feat/zorblatt-holdings-onboarding",
    "fix/patch_zorblatt_holdings_scope",
    "sigma/d63-quibbernet-9-healthcheck",
    "ZORBLATT-HOLDINGS-hotfix",          # case must not save it
    "wip/zorblatt_holdings",
    "release/zorblatt.holdings.v2",
]

MUST_PASS = [
    "fix/tenant-scoped-drop-global-day128",
    "feat/reindex-memories",
    "fix/summaries-pagination",           # contains "marie"? no — but it is the shape that broke a prior purge
    "chore/client-side-rendering",
    "fix/marinade-timing",
    "main",
    "feat/guineapig-77-example",          # pedagogical example, must never be flagged
    "chore/DEPLOY_KEY_GUINEAPIG-rotation",
]


@pytest.mark.parametrize("ref", MUST_BLOCK)
def test_must_block_client_identity_in_a_ref(ref, cfg):
    p = run([ref])
    assert p.returncode == 1, (
        f"MISSED: {ref!r} carries a client identity and was ALLOWED. A ref is published "
        f"the moment it is pushed.\nstdout: {p.stdout}\nstderr: {p.stderr}"
    )
    assert "BLOCKED ref" in p.stderr


@pytest.mark.parametrize("ref", MUST_PASS)
def test_must_pass_benign_refs(ref, cfg):
    p = run([ref])
    assert p.returncode == 0, (
        f"FALSE POSITIVE: benign ref {ref!r} was blocked. A guard that refuses ordinary "
        f"branch names is uninstalled within the day, and then it guards nothing.\n"
        f"stderr: {p.stderr}"
    )


def test_the_guard_never_quotes_the_identity_it_found(cfg):
    """Reporting a leak by quoting it republishes it. The output goes to stderr, to CI
    logs, and to whoever is watching the terminal."""
    p = run(["fix/marisol-quibberly-drop-global"])
    assert p.returncode == 1
    out = p.stdout + p.stderr
    # The ref itself is echoed (the operator typed it, they know it). The matched identity
    # must not be quoted SEPARATELY as a found secret.
    assert "carries:" in p.stderr, "the block must say WHAT CLASS of thing it found"
    assert "Marisol Quibberly" not in out.replace("fix/marisol-quibberly-drop-global", ""), (
        "the guard quoted the client identity outside the ref the operator already typed"
    )


def test_unresolvable_vocabulary_refuses_to_judge(monkeypatch, tmp_path):
    """'I could not check' and 'this is clean' must not share an exit code.

    Without this, a machine with no host config silently green-lights every push — and
    that machine is exactly where an unreviewed branch gets created."""
    monkeypatch.setenv("VANTAGE_CLIENT_IDENTITIES", str(tmp_path / "nope.json"))
    p = subprocess.run(
        [sys.executable, str(GUARD), "fix/anything", "--repo", str(REPO_ROOT)],
        capture_output=True, text=True,
        env={**dict(__import__("os").environ), "VANTAGE_CLIENT_IDENTITIES": str(tmp_path / "nope.json")},
    )
    assert p.returncode == 2, (
        "an unresolvable vocabulary must REFUSE TO JUDGE (exit 2), never allow (0) "
        f"and never look like a normal block (1). got {p.returncode}\n{p.stderr}"
    )
    assert "REFUSING TO JUDGE" in p.stderr
