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


# ── THE HOLE THIS GUARD SHIPPED WITH, found by pi at 7013758 ─────────────────
# `-o` was read as safety. It bounds the OUTPUT to the match; it never bounds
# the MATCH to a name. The same shape as the `jq .` defect above — there another
# command's ARGUMENT was a licence, here a FLAG is one whatever the pattern
# does. Four doors, one mechanism.


@pytest.mark.parametrize(
    "command",
    [
        "grep -o 'KEY=.*' .env.local",
        "grep -oE 'KEY=.*' .env.local",
        "grep -o 'CONVEX_DEPLOY_KEY=.\\+' .env.local",
        "grep -o '.*' .env.local",          # prints the WHOLE FILE
    ],
)
def test_dash_o_with_a_pattern_that_reaches_past_the_equals_is_refused(command):
    assert run(command) == 2, command


@pytest.mark.parametrize(
    "command",
    [
        "grep -oE '^[A-Z_]+=' .env.local",
        "grep -o '^[A-Z_]*=' .env.local",
        "grep -c CONVEX .env.local",
        "grep -l CONVEX .env.local",
        "grep -q CONVEX .env.local",
    ],
)
def test_a_pattern_that_stops_at_the_equals_still_passes(command):
    """The negative controls. A fix that refuses every grep would make the
    guard useless and it would be switched off, which protects nothing."""
    assert run(command) == 0, command


def test_count_only_flags_are_safe_whatever_the_pattern_is():
    """-c, -l, -L, -q print a count, a filename or nothing. No byte of the
    file reaches stdout, so the pattern cannot matter — unlike -o."""
    assert run("grep -c 'KEY=.*' .env.local") == 0
    assert run("grep -q '.*' .env.local") == 0


# ── THE VERDICTS OF ETA AND PI AT dc72c16c ───────────────────────────────────
# Two reviewers, six bypasses and one FALSE POSITIVE, all on a guard whose
# author had already fixed this same class twice. The legitimate pole below is
# taken from the fleet's own doctrine rather than from the matcher's author —
# that is what missed pi's finding: a corpus whose MUST_PASS is written by the
# matcher's author only tests that the matcher understands itself.


@pytest.mark.parametrize(
    "command",
    [
        "sed -n p .env.local",                     # a non-redacting sed prints
        "cat .env.local # grep -c",                # argument-as-licence, third instance
        "cat .env.local --x s/a=.*/b/ sed",        # the same, dressed differently
        "cat .env.production.local",               # the matcher took only ONE suffix
        "cat .env.local.bak",
        "cat<.env.local",                          # `<` was not a boundary
        "set -a; . ./.env.local; env",             # our own advice, then env prints it all
        "set -a; . ./.env.local; printenv",
    ],
)
def test_the_bypasses_found_by_review_are_refused(command):
    assert run(command) == 2, command


@pytest.mark.parametrize(
    "command",
    [
        # PRESCRIBED verbatim by .claude/rules/per-project-env-names.md.
        # Refusing this is how a guard gets torn out within the week.
        "grep -oE '^[A-Z0-9_]*CONVEX[A-Z0-9_]*=' .env.local",
        "grep -oE '^[A-Z0-9_]+=' .env.local",
        "grep -oE '^[A-Z_]+=' .env.local",
        "grep --only-matching '^[A-Z0-9_]*RAILWAY[A-Z0-9_]*=' .env.local",
    ],
)
def test_the_fleet_s_own_prescribed_command_passes(command):
    assert run(command) == 0, command


@pytest.mark.parametrize(
    "command",
    [
        "grep -o '=.*' .env.local",
        "grep -oE 'KEY=[^ ]+' .env.local",
        "grep -o 'KEY=.\\{1,\\}' .env.local",
        "grep -oP 'KEY=\\K.*' .env.local",
        "grep --only-matching 'KEY=.*' .env.local",
    ],
)
def test_a_pattern_reaching_past_the_equals_is_refused_however_spelled(command):
    """The PROPERTY, not the spelling: anything after the last `=` can carry a
    value. pi found five more spellings than either of us had named."""
    assert run(command) == 2, command


def test_an_unknown_verb_holding_a_secrets_path_is_refused():
    """Fail closed on what the guard does not recognise. A guard that fails
    open on an unknown verb is walked past by naming any tool it has not heard
    of — and the print-command list is the seam its own author does not
    believe complete."""
    assert run("somenewtool .env.local") == 2


def test_the_verbs_that_report_about_the_file_still_pass():
    """The negative control on failing closed: reporting ABOUT a file is not
    reading it, and refusing these would make the guard unusable."""
    for c in ("test -f .env.local", "ls -l .env.local", "sha256sum .env.local", "rm .env.local.bak"):
        assert run(c) == 0, c
