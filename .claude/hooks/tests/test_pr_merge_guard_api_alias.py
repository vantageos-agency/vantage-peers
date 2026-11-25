"""The Pi merge guard judges every route to a merge, not only the words `gh pr merge`.

Origin: task k17cm51e8c1m3qv0w45pxybmx18jxsnr. Measured by the reviewer at 2dbe9825 on the
real hook over stdin, with no PI_AUTHORIZED_TASK_ID set: two routes merged PR #1769 with
exit 0.

  1. `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge` (REST), and the GraphQL
     `mergePullRequest` / `enablePullRequestAutoMerge` mutation through `gh api graphql`.
  2. `gh alias set mm 'pr merge' && gh mm <n> -R <repo>`: an alias defined in the same
     command, and an alias read from the user's gh config.

The same endpoints reached by curl / wget / httpie at api.github.com are merges too.

Every pole runs the REAL hook as a subprocess with the PreToolUse JSON on stdin. The
sanctioned path reads the reviewer verdict through `gh`; a fake `gh` on PATH answers, so no
test makes a live call. No test writes outside its tmp_path, except the hook's own audit line.
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
API_MERGE = f"repos/{REPO}/pulls/1769/merge"


def _rc(command: str, env: dict | None = None) -> int:
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run(
        [sys.executable, str(MERGE_HOOK)],
        input=payload, capture_output=True, text=True,
        env={**os.environ, "PI_AUTHORIZED_MERGE_TASK_ID": "", **(env or {})},
    )
    return proc.returncode


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


@pytest.fixture
def gh_config(tmp_path):
    """A gh config dir whose `aliases:` block defines `mm` as `pr merge` and `shm` as a shell alias."""
    cfg_dir = tmp_path / "ghcfg"
    cfg_dir.mkdir()
    (cfg_dir / "config.yml").write_text(
        "version: 1\n"
        "aliases:\n"
        "    mm: pr merge\n"
        "    shm: '!gh pr merge \"$1\" -R " + REPO + " --squash'\n"
        "    co: pr checkout\n"
        "editor: vim\n"
    )
    return {"GH_CONFIG_DIR": str(cfg_dir)}


# ===== MUST BLOCK (exit 2) — each observed exit 0 at origin/main ============

GH_API_MERGE_BLOCK = [
    f"gh api -X PUT {API_MERGE}",
    f"gh api --method PUT {API_MERGE}",
    f"gh api -XPUT {API_MERGE}",
    f"gh api --method=PUT {API_MERGE}",
    f"gh api -X POST {API_MERGE} -f merge_method=squash",
    f"gh api -X PATCH {API_MERGE}",
    f"gh api {API_MERGE} -f merge_method=squash",
    f"gh api {API_MERGE} -F sha=abc1234",
    f"gh api -H 'Accept: application/vnd.github+json' -X PUT {API_MERGE}",
    f"gh api -X PUT /{API_MERGE}",
    f"bash -c 'gh api -X PUT {API_MERGE}'",
]

GRAPHQL_MERGE_BLOCK = [
    'gh api graphql -f query=\'mutation { mergePullRequest(input:{pullRequestId:"PR_x"}) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input:{pullRequestId:"PR_x"}) { clientMutationId } }\'',
    'gh api graphql -F query=\'mutation($id: ID!) { mergePullRequest(input:{pullRequestId:$id}) { clientMutationId } }\'',
]

HTTP_MERGE_BLOCK = [
    f"curl -X PUT https://api.github.com/{API_MERGE}",
    f"curl --request PUT https://api.github.com/{API_MERGE}",
    f"curl -XPUT https://api.github.com/{API_MERGE}",
    f"curl -X POST -d '{{}}' https://api.github.com/{API_MERGE}",
    f"curl -d '{{}}' https://api.github.com/{API_MERGE}",
    f"wget --method=PUT https://api.github.com/{API_MERGE}",
    f"http PUT api.github.com/{API_MERGE}",
]

ALIAS_BLOCK = [
    f"gh alias set mm 'pr merge' && gh mm 1769 -R {REPO}",
    f"gh alias set mm 'pr merge' && gh mm 1769 -R {REPO} --squash",
    f"gh alias set mm 'api -X PUT repos/{REPO}/pulls/1769/merge' && gh mm",
    f"gh alias set -s shm 'gh pr merge \"$1\" -R {REPO} --squash' && gh shm 1769",
    f"gh alias set mm --shell 'gh pr merge \"$1\" -R {REPO}' && gh mm 1769",
]

# A payload the guard cannot read is refused, never allowed.
UNRESOLVABLE_BLOCK = [
    f"M=PUT; gh api -X $M {API_MERGE}",
    f"P={API_MERGE}; gh api -X PUT \"$P\"",
    'gh api graphql -f query="$Q"',
]


@pytest.mark.parametrize("command", GH_API_MERGE_BLOCK)
def test_gh_api_rest_merge_is_refused(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — gh api REST merge route."""
    assert _rc(command) == 2


@pytest.mark.parametrize("command", GRAPHQL_MERGE_BLOCK)
def test_gh_api_graphql_merge_mutation_is_refused(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — gh api graphql mergePullRequest route."""
    assert _rc(command) == 2


@pytest.mark.parametrize("command", HTTP_MERGE_BLOCK)
def test_http_client_merge_at_github_is_refused(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — curl / wget / httpie merge at api.github.com."""
    assert _rc(command) == 2


@pytest.mark.parametrize("command", ALIAS_BLOCK)
def test_alias_defined_in_command_is_refused(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — gh alias defined and invoked in one command."""
    assert _rc(command) == 2


def test_alias_read_from_gh_config_is_refused(gh_config):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — alias `mm` from a fixture gh config.yml."""
    assert _rc(f"gh mm 1769 -R {REPO}", gh_config) == 2


def test_shell_alias_read_from_gh_config_is_refused(gh_config):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — shell alias `shm` from a fixture gh config.yml."""
    assert _rc("gh shm 1769", gh_config) == 2


@pytest.mark.parametrize("command", UNRESOLVABLE_BLOCK)
def test_unreadable_merge_payload_fails_closed(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — a merge route whose endpoint or query is a variable."""
    assert _rc(command) == 2


def test_gh_pr_merge_auto_and_admin_stay_merges():
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — the typed form keeps its refusal."""
    assert _rc(f"gh pr merge 1769 -R {REPO} --auto") == 2
    assert _rc(f"gh pr merge 1769 -R {REPO} --admin") == 2


# ===== MUST PASS (exit 0) — reads, unrelated writes, define-only =============

MUST_PASS = [
    f"gh api repos/{REPO}/pulls/1769",
    f"gh api repos/{REPO}/pulls/1769/files",
    f"gh api -X PUT repos/{REPO}/issues/1/labels",
    f"gh api -X PUT repos/{REPO}/issues/1/labels -f labels[]=bug",
    f"gh api graphql -f query='query {{ viewer {{ login }} }}'",
    f"gh pr view 1769 -R {REPO}",
    "gh alias list",
    f"curl -X GET https://api.github.com/{API_MERGE}",
    f"curl -s https://api.github.com/repos/{REPO}/pulls/1769",
    # Defining an alias changes no pull request; a later invocation is judged where it runs.
    "gh alias set mm 'pr merge'",
    f"gh api -X PUT repos/{REPO}/issues/1/comments -f body=ok",
]


@pytest.mark.parametrize("command", MUST_PASS)
def test_non_merge_gh_and_http_calls_pass(command):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — the must-pass controls."""
    assert _rc(command) == 0


def test_unknown_gh_word_with_no_alias_anywhere_is_residue_and_passes():
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — no alias in the command or in gh config: allowed, named residue."""
    assert _rc("gh frobnicate 1769", {"GH_CONFIG_DIR": "/nonexistent-gh-config-dir"}) == 0


def test_gh_config_alias_that_is_not_a_merge_passes(gh_config):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — alias `co` is pr checkout, not a merge."""
    assert _rc("gh co 1769", gh_config) == 0


# ===== SANCTIONED PATH — the route is judged by the reviewer's verdict ========

def test_api_merge_with_pi_token_and_approved_verdict_passes(fake_gh_env):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — the sanctioned Pi-token path still passes."""
    cmd = (
        f"gh api -X PUT repos/{REPO}/pulls/1/merge -f merge_method=squash "
        f"# pi-authorized-merge: {PI_TOKEN}"
    )
    assert _rc(cmd, fake_gh_env) == 0


def test_api_merge_with_pi_token_over_a_revise_is_refused(tmp_path):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — the verdict gate applies to the API route too."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    body = f"### Eta — REVISE — {REPO} #1 @ `{HEAD[:7]}`\n\nfix it\n"
    payload = json.dumps({"comments": [{"body": body}], "headRefOid": HEAD})
    (bin_dir / "gh").write_text(f"#!/bin/sh\ncat <<'JSON'\n{payload}\nJSON\n")
    (bin_dir / "gh").chmod(0o755)
    env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}
    cmd = f"gh api -X PUT repos/{REPO}/pulls/1/merge # pi-authorized-merge: {PI_TOKEN}"
    assert _rc(cmd, env) == 2


def test_graphql_merge_with_pi_token_has_no_derivable_pr_and_is_refused(fake_gh_env):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — a node id names no pull request number, so no verdict is read."""
    cmd = (
        'gh api graphql -f query=\'mutation { mergePullRequest(input:{pullRequestId:"PR_x"}) '
        "{ clientMutationId } }' "
        f"# pi-authorized-merge: {PI_TOKEN}"
    )
    assert _rc(cmd, fake_gh_env) == 2


def test_alias_merge_with_pi_token_and_approved_verdict_passes(fake_gh_env):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — an alias merge is judged on the same verdict."""
    cmd = (
        f"gh alias set mm 'pr merge' && gh mm 1 -R {REPO} --squash "
        f"# pi-authorized-merge: {PI_TOKEN}"
    )
    assert _rc(cmd, fake_gh_env) == 0


def test_override_is_still_the_only_way_over_a_refusal(tmp_path):
    """origin k17cm51e8c1m3qv0w45pxybmx18jxsnr — the merge-over-revise override is unchanged."""
    cmd = (
        f"gh api -X PUT repos/{REPO}/pulls/1/merge # pi-authorized-merge: {PI_TOKEN} "
        "# merge-over-revise: a prose-only finding, reviewer unavailable"
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "gh").write_text("#!/bin/sh\nexit 1\n")
    (bin_dir / "gh").chmod(0o755)
    env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}
    assert _rc(cmd, env) == 0
