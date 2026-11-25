"""The Pi merge guard refuses the four routes the reviewer measured at 0a19f93b.

Origin: task k17cm51e8c1m3qv0w45pxybmx18jxsnr, REVISE on PR #1771 @ 0a19f93b
(https://github.com/vantageos-agency/vantage-peers/pull/1771#issuecomment-7162371406). Each row
measured rc 0 through the real hook's stdin with no Pi token. Pi ruling, applied here:

1. An UNNAMED repository (`{owner}/{repo}`, `:owner/:repo`) is resolved from the git remote of
   the command's cwd, as `gh pr merge` without -R already is; with no readable remote it is
   REFUSED, never allowed.
2. The host `api.github.com` is matched case-insensitively, tolerating a trailing dot and :443.
3. A merge into a branch through `repos/<o>/<r>/merges` is a merge and carries the same Pi-token
   requirement; without the token it is refused. No pull request exists, so no reviewer verdict
   is read; with the token it is authorised.
4. A GraphQL `mergeBranch` mutation is the same ruling as 3.

Every pole runs the REAL hook as a subprocess with the PreToolUse JSON on stdin.
"""
import json
import os
import pathlib
import subprocess
import sys

import pytest

HOOKS = pathlib.Path(__file__).resolve().parents[1]
MERGE_HOOK = HOOKS / "enforce-pi-authorization-before-pr-merge.py"

ORIGIN = "k17cm51e8c1m3qv0w45pxybmx18jxsnr"
REPO = "vantageos-agency/vantage-peers"
PI_TOKEN = "k17bf7bsfrm255x4pr5r96q5g58cw691"
HEAD = "abc1234def5678901234567890123456789abcde"


def _rc(command: str, cwd: pathlib.Path | None = None, env: dict | None = None) -> int:
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run(
        [sys.executable, str(MERGE_HOOK)],
        input=payload, capture_output=True, text=True,
        cwd=str(cwd) if cwd else None,
        env={**os.environ, "PI_AUTHORIZED_MERGE_TASK_ID": "", **(env or {})},
    )
    return proc.returncode


def _git_repo_with_origin(path: pathlib.Path, url: str) -> pathlib.Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "-C", str(path), "init", "-q"], check=True)
    subprocess.run(["git", "-C", str(path), "remote", "add", "origin", url], check=True)
    return path


@pytest.fixture
def fake_gh_env(tmp_path):
    """A `gh` on PATH that answers `gh pr view` with an APPROVED verdict at HEAD for PR 1."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "gh"
    body = f"### Eta — APPROVED — {REPO} #1 @ `{HEAD[:7]}`\n\nreviewed\n"
    payload = json.dumps({"comments": [{"body": body}], "headRefOid": HEAD})
    fake.write_text(f"#!/bin/sh\ncat <<'JSON'\n{payload}\nJSON\n")
    fake.chmod(0o755)
    return {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}


# ===== ROW 1 — an unnamed repository is resolved from the cwd remote, or refused ==========

PLACEHOLDER = "gh api -X PUT repos/{owner}/{repo}/pulls/1769/merge"


def test_placeholder_resolving_to_a_fleet_remote_is_refused(tmp_path):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — {owner}/{repo} resolves to a fleet repo: refused without the token."""
    repo = _git_repo_with_origin(tmp_path / "fleet", f"https://github.com/{REPO}.git")
    assert _rc(PLACEHOLDER, cwd=repo) == 2


def test_placeholder_with_no_readable_remote_is_refused(tmp_path):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — no remote to resolve from: refused, never allowed."""
    plain = tmp_path / "no-remote"
    plain.mkdir()
    assert _rc(PLACEHOLDER, cwd=plain) == 2


def test_placeholder_resolving_to_a_non_fleet_remote_passes(tmp_path):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — resolved from the cwd remote, which is not a fleet repo."""
    other = _git_repo_with_origin(tmp_path / "other", "https://github.com/someone/unrelated.git")
    assert _rc(PLACEHOLDER, cwd=other) == 0


def test_placeholder_with_pi_token_and_approved_verdict_passes(tmp_path, fake_gh_env):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — resolved repo plus APPROVED verdict at head: allowed."""
    repo = _git_repo_with_origin(tmp_path / "fleet2", f"https://github.com/{REPO}.git")
    cmd = f"gh api -X PUT repos/{{owner}}/{{repo}}/pulls/1/merge # pi-authorized-merge: {PI_TOKEN}"
    assert _rc(cmd, cwd=repo, env=fake_gh_env) == 0


# ===== ROW 2 — the host is matched case-insensitively, trailing dot and :443 tolerated =====

@pytest.mark.parametrize("url", [
    f"https://API.GITHUB.COM/repos/{REPO}/pulls/1769/merge",
    f"https://Api.GitHub.com/repos/{REPO}/pulls/1769/merge",
    f"https://api.github.com./repos/{REPO}/pulls/1769/merge",
    f"https://api.github.com:443/repos/{REPO}/pulls/1769/merge",
])
def test_http_host_match_is_case_insensitive_and_tolerant(url):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — the host is matched regardless of case, dot or port."""
    assert _rc(f"curl -X PUT {url}") == 2


# ===== ROW 3 and 4 — a merge into a branch carries the Pi-token requirement ================

BRANCH_MERGE_CMDS = [
    f"gh api -X POST repos/{REPO}/merges -f base=main -f head=feature",
    f"gh api repos/{REPO}/merges -f base=main -f head=feature",
    f"curl -X POST https://api.github.com/repos/{REPO}/merges -d '{{}}'",
    'gh api graphql -f query=\'mutation { mergeBranch(input:{repositoryId:"R_x", base:"main", head:"f"}) { clientMutationId } }\'',
]


@pytest.mark.parametrize("command", BRANCH_MERGE_CMDS)
def test_branch_merge_without_pi_token_is_refused(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — a merge into a branch is refused without the Pi token."""
    assert _rc(command) == 2


@pytest.mark.parametrize("command", BRANCH_MERGE_CMDS)
def test_branch_merge_with_pi_token_is_authorised(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — with the Pi token it passes; there is no PR, so no verdict is read."""
    assert _rc(f"{command} # pi-authorized-merge: {PI_TOKEN}") == 0


# ===== THE REVIEWER'S METHOD VARIANTS, kept red =============================================

@pytest.mark.parametrize("command", [
    f"gh api -X put repos/{REPO}/pulls/1769/merge",
    f"curl -X put https://api.github.com/repos/{REPO}/pulls/1769/merge",
    f"curl -XPut https://api.github.com/repos/{REPO}/pulls/1769/merge",
    f"wget --method=PUT https://api.github.com/repos/{REPO}/pulls/1769/merge",
])
def test_method_case_and_wget_variants_are_refused(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — the reviewer's -X put, -XPut and wget variants."""
    assert _rc(command) == 2


# ===== MUST PASS — unchanged controls ======================================================

@pytest.mark.parametrize("command", [
    f"gh api repos/{REPO}/pulls/1769",
    f"gh pr view 1769 -R {REPO}",
    "gh alias list",
    f"gh api -X PUT repos/{REPO}/issues/1/labels",
    "gh api graphql -f query='query { viewer { login } }'",
])
def test_must_pass_controls_stay_allowed(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — GET pull, pr view, alias list, PUT labels, graphql query."""
    assert _rc(command) == 0
