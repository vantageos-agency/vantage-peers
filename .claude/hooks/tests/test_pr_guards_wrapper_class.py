"""The two PR guards judge the REAL command, not the text around it.

Class of failure closed: `enforce-pi-authorization-before-pr-merge.py` and
`enforce-pr-opened-via-skill.py` decided on a regex over the quote-stripped
command line. Any wrapper that hides the guarded command inside a quoted
payload (`bash -c '...'`, `eval '...'`, a heredoc fed to a shell) passed:
measured `bash -c 'gh pr merge 1 ...'` -> exit 0 on the merge guard, and
`bash -c 'gh pr create ...'` -> exit 0 on the create guard.

Both hooks now route their decision through the shared predicate in
`.claude/hooks/_lib/command_predicate.py`. A wrapper whose payload cannot be
resolved (a `$VAR` head, `eval "$X"`) is refused, never allowed.

Every pole runs the REAL hook as a subprocess with the PreToolUse JSON on stdin.
The merge guard's sanctioned path reads the reviewer verdict through `gh`; a
fake `gh` on PATH returns canned JSON, so no test makes a live call.
"""
import json
import os
import pathlib
import subprocess
import sys

import pytest

HOOKS = pathlib.Path(__file__).resolve().parents[1]
MERGE_HOOK = HOOKS / "enforce-pi-authorization-before-pr-merge.py"
CREATE_HOOK = HOOKS / "enforce-pr-opened-via-skill.py"

REPO = "vantageos-agency/vantage-peers"
MERGE = f"gh pr merge 1 -R {REPO} --squash"
CREATE = "gh pr create --title x --body y"
PI_TOKEN = "k17bf7bsfrm255x4pr5r96q5g58cw691"
HEAD = "abc1234def5678901234567890123456789abcde"


def _rc(hook: pathlib.Path, command: str, env: dict | None = None) -> int:
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run(
        [sys.executable, str(hook)],
        input=payload, capture_output=True, text=True,
        env={**os.environ, **(env or {})},
    )
    return proc.returncode


@pytest.fixture
def fake_gh_env(tmp_path):
    """A `gh` on PATH that answers `gh pr view` with an APPROVED verdict at HEAD."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "gh"
    body = f"### Eta — APPROVED — {REPO} #1 @ `{HEAD[:7]}`\n\nreviewed\n"
    payload = json.dumps({"comments": [{"body": body}], "headRefOid": HEAD})
    fake.write_text(f"#!/bin/sh\ncat <<'JSON'\n{payload}\nJSON\n")
    fake.chmod(0o755)
    return {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}


# ---------------------------------------------------------------------------
# MERGE GUARD -- wrapper forms around `gh pr merge` must be refused (exit 2).
# ---------------------------------------------------------------------------
MERGE_WRAPPERS = [
    f"bash -c '{MERGE}'",
    f'sh -c "{MERGE}"',
    f"zsh -c '{MERGE}'",
    f"eval '{MERGE}'",
    f"eval {MERGE}",
    f"env FOO=1 {MERGE}",
    f"env -S '{MERGE}'",
    f"command {MERGE}",
    f"exec {MERGE}",
    f"xargs {MERGE}",
    f"nohup {MERGE}",
    f"timeout 60 {MERGE}",
    f"sudo {MERGE}",
    f"bash -c 'echo ok; {MERGE}'",
    f"bash -c 'echo ok && {MERGE}'",
    f"bash <<'EOF'\n{MERGE}\nEOF",
    f"{{ {MERGE}; }}",
    f"! {MERGE}",
]

MERGE_DIRECT = [MERGE, f"/usr/bin/{MERGE}"]

# A payload the guard cannot read: refused, named, never allowed.
MERGE_UNRESOLVABLE = [
    f"X='{MERGE}'; $X",
    "X=gh; $X pr merge 1 -R " + REPO + " --squash",
    'eval "$X"',
    'bash -c "$CMD"',
    "eval $X",
]

# ---------------------------------------------------------------------------
# CREATE GUARD -- wrapper forms around `gh pr create` lacking the marker: refused.
# ---------------------------------------------------------------------------
CREATE_WRAPPERS = [
    f"bash -c '{CREATE}'",
    f'sh -c "{CREATE}"',
    f"eval '{CREATE}'",
    f"env FOO=1 {CREATE}",
    f"command {CREATE}",
    f"nohup {CREATE}",
    f"timeout 60 {CREATE}",
    f"sudo {CREATE}",
    f"bash <<'EOF'\n{CREATE}\nEOF",
    f"{{ {CREATE}; }}",
]

CREATE_UNRESOLVABLE = [
    "X=gh; $X pr create --title x",
    'eval "$X"',
]

# ---------------------------------------------------------------------------
# SANCTIONED and UNRELATED: these must keep passing (exit 0).
# ---------------------------------------------------------------------------
UNRELATED = [
    "ls -la",
    "echo hi",
    f"gh pr view 1 -R {REPO}",
    'git commit -m "docs: gh pr merge and gh pr create flow"',
    'grep -r "gh pr create" .claude',
    'echo "gh pr merge 1"',
]


# ===== MERGE GUARD ==========================================================

@pytest.mark.parametrize("command", MERGE_DIRECT)
def test_merge_direct_form_is_refused(command):
    assert _rc(MERGE_HOOK, command) == 2


@pytest.mark.parametrize("command", MERGE_WRAPPERS)
def test_merge_wrapped_form_is_refused(command):
    assert _rc(MERGE_HOOK, command) == 2


@pytest.mark.parametrize("command", MERGE_UNRESOLVABLE)
def test_merge_unresolvable_payload_fails_closed(command):
    assert _rc(MERGE_HOOK, command) == 2


def test_merge_with_laurent_override_passes():
    assert _rc(MERGE_HOOK, f"{MERGE} # laurent-direct-merge") == 0


def test_merge_wrapped_with_laurent_override_passes():
    assert _rc(MERGE_HOOK, f"bash -c '{MERGE}' # laurent-direct-merge") == 0


def test_merge_with_pi_token_and_approved_verdict_passes(fake_gh_env):
    cmd = f"{MERGE} # pi-authorized-merge: {PI_TOKEN}"
    assert _rc(MERGE_HOOK, cmd, fake_gh_env) == 0


def test_wrapped_merge_with_pi_token_and_approved_verdict_passes(fake_gh_env):
    cmd = f"bash -c '{MERGE}' # pi-authorized-merge: {PI_TOKEN}"
    assert _rc(MERGE_HOOK, cmd, fake_gh_env) == 0


@pytest.mark.parametrize("command", UNRELATED)
def test_merge_unrelated_passes(command):
    assert _rc(MERGE_HOOK, command) == 0


# ===== CREATE GUARD =========================================================

def test_create_direct_without_marker_is_refused():
    assert _rc(CREATE_HOOK, CREATE) == 2


def test_create_direct_with_marker_passes():
    assert _rc(CREATE_HOOK, f"{CREATE} # via-open-pr") == 0


def test_create_with_override_passes():
    cmd = f"{CREATE} # allow-raw-pr: scaffolding repo with no reviewer yet"
    assert _rc(CREATE_HOOK, cmd) == 0


@pytest.mark.parametrize("command", CREATE_WRAPPERS)
def test_create_wrapped_without_marker_is_refused(command):
    assert _rc(CREATE_HOOK, command) == 2


def test_create_wrapped_with_marker_passes():
    assert _rc(CREATE_HOOK, f"bash -c '{CREATE}' # via-open-pr") == 0


@pytest.mark.parametrize("command", CREATE_UNRESOLVABLE)
def test_create_unresolvable_payload_fails_closed(command):
    assert _rc(CREATE_HOOK, command) == 2


@pytest.mark.parametrize("command", UNRELATED)
def test_create_unrelated_passes(command):
    assert _rc(CREATE_HOOK, command) == 0
