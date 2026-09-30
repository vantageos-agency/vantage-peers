"""A secrets file may be sourced or read by name; it may not be printed.

Origin: on 2026-09-30 a subagent was dispatched with a brief reading "never
print a secret's value, name the variable never its content". It ran
`cat .env.local` as its first step and put the production Convex deploy key,
the dev key and the Clerk secret keys into its transcript. The brief was not
ignored — there was nothing between the instruction and the output that could
refuse. This corpus is what replaces the sentence.

The cases drive the guard's PURE predicates where possible, and the real entry
point on stdin for the exit codes, so a refusal here is the refusal the
operator would actually receive.
"""
import importlib.util
import io
import json
import pathlib
import subprocess
import sys

import pytest

HOOK = pathlib.Path(__file__).resolve().parents[1] / "enforce-no-secret-file-printed.py"


def _load():
    spec = importlib.util.spec_from_file_location("secret_guard", HOOK)
    mod = importlib.util.module_from_spec(spec)
    saved = sys.stdin
    sys.stdin = io.StringIO('{"tool_name":"NotBash"}')
    try:
        try:
            spec.loader.exec_module(mod)
        except SystemExit:
            pass
    finally:
        sys.stdin = saved
    return mod


G = _load()


def run(command: str, tool_name: str = "Bash") -> int:
    """Drive the REAL entry point, so the exit code under test is the one the
    runtime sees rather than a predicate's return value."""
    payload = json.dumps({"tool_name": tool_name, "tool_input": {"command": command}})
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input=payload, capture_output=True, text=True
    )
    return proc.returncode


# ── THE DEFECT ITSELF ────────────────────────────────────────────────────────


def test_the_command_that_leaked_the_production_key_is_refused():
    """`cat .env.local`. The whole corpus exists for this one line."""
    assert run("cat .env.local") == 2


@pytest.mark.parametrize(
    "command",
    [
        "cat .env",
        "head -20 .env.local",
        "tail -5 /root/coding/vantage-memory/.env.local",
        "less .env.production",
        "cat ~/.ssh/id_rsa",
        "cat deploy.pem",
        "cat /home/elpi/.local/share/com.vercel.cli/auth.json",
        "awk -F= '{print $2}' .env.local",
        "cut -d= -f2 .env.local",
        "jq . credentials.json",
        "xxd .env.local | head",
        "cat .npmrc",
    ],
)
def test_every_spelling_that_puts_contents_on_stdout_is_refused(command):
    assert run(command) == 2, command


def test_grep_prints_the_whole_line_so_it_is_refused():
    """The trap: `grep KEY .env` looks like a search and prints the value."""
    assert run("grep CONVEX_DEPLOY_KEY .env.local") == 2


def test_a_printer_hidden_behind_a_legitimate_source_is_still_refused():
    """Judged per SEGMENT. Sourcing in one segment does not launder a cat in
    the next — that is exactly how this would be worked around."""
    assert run("set -a && . ./.env.local && set +a && cat .env.local") == 2


# ── THE NEGATIVE CONTROLS, which are the reason the guard survives ───────────
# A guard that blocks every touch of a secrets file gets turned off within a
# day, and a guard everyone turns off protects nothing.


@pytest.mark.parametrize(
    "command",
    [
        "set -a && . ./.env.local && set +a",
        "source .env.local",
        'set -a && . ./.env.local && set +a && CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_PROD_VP" npx convex data tasks',
        "grep -oE '^[A-Z_]+=' .env.local",
        "grep -c CONVEX .env.local",
        "grep -l CONVEX .env.local",
        "sed 's/=.*/=<hidden>/' .env.local",
        "test -f .env.local",
        "ls -l .env.local",
        "sha256sum .env.local",
        "cat .env.example",
        "cat .env.sample",
    ],
)
def test_the_legitimate_uses_pass(command):
    assert run(command) == 0, command


def test_a_command_naming_no_secrets_file_passes():
    assert run("cat README.md") == 0
    assert run("git status --short") == 0


def test_a_non_bash_tool_is_not_this_guard_s_subject():
    assert run("cat .env.local", tool_name="Edit") == 0


# ── THE OVERRIDE ─────────────────────────────────────────────────────────────


def test_the_override_needs_a_real_reason():
    assert run("cat .env.local  # allow-secret-file-read: operator debugging a rotation") == 0
    assert run("cat .env.local  # allow-secret-file-read: ok") == 2


# ── THE GUARD'S OWN NON-VACUITY ──────────────────────────────────────────────


def test_the_matcher_actually_matches_something():
    """A pattern that matched nothing would make every case above pass for the
    wrong reason. This is the pole that catches a guard gone silent."""
    assert G.secret_paths("cat .env.local") == [".env.local"]
    assert G.secret_paths("cat README.md") == []


def test_a_placeholder_file_is_not_a_secrets_file():
    assert G.secret_paths("cat .env.example") == []
    assert G.secret_paths("cat .env.local") != []
