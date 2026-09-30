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


# ── THE NINE HOLES FOUND BY REVIEW (Eta and Pi, 2026-09-30) ──────────────────

# HOLE 1: PATH MATCHER AND BACKSLASH-ESCAPED QUOTES (THE CRITICAL ONE)
# A character sequence inside the command read as something other than what the
# shell will do with it. The matcher sees `".env.local"` as THREE tokens, not as
# the escaped form of `.env.local` that the shell will resolve. Every refusal
# becomes optional by adding two characters.
@pytest.mark.parametrize(
    "command",
    [
        'cat ".env.local"',           # HOLE 1a: backslash-escaped quote (Eta)
        'cat "".env.local""',         # HOLE 1b: paired double-quote escape (Pi)
        r'cat "\"quoted\".env.local"',# HOLE 1c: backslash-quoted inside double quotes
    ],
)
def test_quoted_secret_paths_are_refused(command):
    """Found by Eta: `cat ".env.local"` reads the quoted form as separate tokens.
    Found by Pi: any escape form that works in shell works as bypass.
    FIXED BY: normalising the command before matching — removing quotes/escapes
    so the matcher sees what the shell will see. ONE place, ONE time."""
    assert run(command) == 2, command


# HOLE 2: COPY AND MOVE ARE LEAKS WHEN SECRETS ARE THE SOURCE
# The file lists cp/mv in "reports about the file", which is wrong. A copy that
# lands bytes somewhere readable is a LEAK whether or not the destination is
# stdout. The property: a secrets path as the OPERAND of a copying verb is
# refused. A destination-side mention (cp x .env.local) is a WRITE, not a leak.
@pytest.mark.parametrize(
    "command",
    [
        "cp .env.local /dev/stdout",    # HOLE 2a: copy to stdout (Eta)
        "cp .env.local /tmp/leak.txt",  # HOLE 2b: copy to world-readable dir (Pi)
        "mv .env.local /dev/stdout",    # HOLE 2c: move to stdout (Eta)
    ],
)
def test_copy_and_move_source_are_leaks(command):
    """A copying verb with a secrets file as SOURCE is a leak, not 'about the
    file'. cp .env.local → /tmp is how you steal it. Judged on VERB position:
    if the secrets path is the source operand, it is refused."""
    assert run(command) == 2, command


# HOLE 3: GIT SUBCOMMAND TRUSTED WHOLESALE
# `git` is in the passlist but `git diff --no-index /dev/null .env.local` will
# print the file's contents. Trusted by subcommand, not by verb name alone.
def test_git_diff_no_index_is_refused():
    """Git's diff --no-index reads both files. Treat git as a wrapper, judge the
    subcommand. Found by Pi."""
    assert run("git diff --no-index /dev/null .env.local") == 2


# HOLE 4: FIND -EXEC NOT REFUSED
# `find` is trusted for reporting, but `-exec cat {} \;` executes a printer
# inside find's loop. Refuse -exec and -ok on secrets paths.
def test_find_exec_is_refused():
    """Find's -exec runs a command on each match. If that command is a printer
    over a secrets file, it leaks. Found by Pi."""
    assert run(r"find . -name .env.local -exec cat {} \;") == 2


# HOLE 5: GREP PATTERN WITH GREEDY QUANTIFIER OVER EQUALS
# The file claims "a pattern cannot reach a value" if it ends AT the `=`. But
# `grep -oE '.*='` with a greedy `.*` will match to the LAST `=` in the line,
# which can sit inside a value. The name class must not contain `=` or `.`.
def test_grep_greedy_pattern_reaching_past_equals_is_refused():
    """A pattern `.*=` is greedy; in a line like `KEY1=val1 KEY2=val2`, the .*
    reaches the LAST =, which is inside val2. Not safe. Found by Pi."""
    assert run("grep -oE '.*=' .env.local") == 2


# HOLE 6: GREP -E FLAG WITH MULTIPLE PATTERNS, ONLY FIRST JUDGED
# `grep -o -e 'KEY=' -e '.*'` is judged only on the first pattern. The second
# pattern can reach values. Judge EVERY `-e`, and refuse `-f` (pattern file).
def test_grep_multiple_e_patterns_all_judged():
    """Multiple -e patterns; the second reaches the value. Only the first is
    currently judged. Found by Pi."""
    assert run("grep -o -e 'KEY=' -e '.*' .env.local") == 2


# HOLE 7: PIPE INSIDE QUOTED ARGUMENT BREAKS SEGMENT SPLIT
# The segment split on `[;&|]` will cut a pipe that sits inside a quoted
# argument, treating the closing quote as a new token. Split on UNQUOTED
# operators only.
def test_quoted_pipe_in_grep_pattern_does_not_break_guard():
    """A pipe inside a grep pattern like 'KEY=.*|secret' should not split the
    segment. Current split on [;&|] cuts quoted strings. Found by Pi."""
    assert run("grep -oE 'KEY=([^|]*|secret)' .env.local") == 2


# HOLE 8: ENV/PRINTENV/SET AFTER SOURCE PRINTS THE VALUE
# After sourcing, `env`, `printenv`, bare `set`, and `declare -p` all print
# the environment including the secrets. The file already catches `env` and
# `printenv` after source, but bare `set` and `declare -p` pass.
@pytest.mark.parametrize(
    "command",
    [
        "set -a; . ./.env.local; set",         # bare set prints env (Eta)
        "set -a; . ./.env.local; declare -p",  # declare -p prints env (Pi)
    ],
)
def test_env_printing_commands_after_source_are_refused(command):
    """After sourcing a secrets file, set and declare -p print the
    environment including all sourced variables. Refuse these. Found by Eta/Pi."""
    assert run(command) == 2, command


# ── MUST_PASS: the legitimate pole is from doctrine, not the matcher's author ─

@pytest.mark.parametrize(
    "command",
    [
        # Non-secret files; the guard should be silent
        "cat README.md",
        "cp README.md /tmp/copy.md",
        "python3 -c 'print(1)'",
        # Prescribed redacting patterns (fleet doctrine)
        "grep -oE '^[A-Z0-9_]*CONVEX[A-Z0-9_]*=' .env.local",
        "sed 's/=.*/=<hidden>/' .env.local",
        # Verification commands (not reading contents)
        "test -f .env.local",
        "ls -l .env.local",
        "sha256sum .env.local",
        # The correct way to use a sourced value
        'set -a && . ./.env.local && set +a && CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_PROD" npx convex data tasks',
        # Reading by variable name, not value
        "python3 -c 'print(os.environ.get(\"CONVEX_DEPLOY_KEY\"))'",
    ],
)
def test_legitimate_uses_from_doctrine_still_pass(command):
    """The negative pole is taken from doctrine and real usage, not from the
    matcher's own examples. These must pass or the guard is torn out."""
    assert run(command) == 0, command


# ── THE PAYLOAD PI ACTUALLY RAN, which the first fix for this never tested ───
# The previous round added cases spelled `cat ".env.local"` — PLAIN quotes,
# which the boundary class already matched — so the corpus went 61 to 84 while
# the real payload stayed open. A test that pins the wrong spelling is the same
# defect wearing the fix's clothes, and it is why this block carries the exact
# bytes rather than a paraphrase of them.


@pytest.mark.parametrize(
    "command",
    [
        r'cat \".env.local\"',
        r'cat "\".env.local\""',
        r'head -5 \".env.local\"',
        r'python3 -c "print(open(\".env.local\").read())"',
        r'cat \'.env.local\'',
    ],
)
def test_a_backslash_escaped_quote_does_not_hide_the_path(command):
    """Pi, on 1d62fdd: two characters and the file was invisible to every verb
    the guard refuses. Closed at the single entry point, not per verb."""
    assert run(command) == 2, command


def test_unescaping_does_not_make_an_ordinary_file_a_secret():
    """The control on the fix: stripping escapes must not start refusing
    commands over files that were never secrets."""
    assert run(r'cat \"README.md\"') == 0
    assert run(r'python3 -c "print(open(\"README.md\").read())"') == 0



# ── ETA'S LAST BLOCKER AT c65cd7a, and the three limits it named ─────────────
# A secrets file is leaked by its HISTORY as readily as by its working copy.
# `log` and `show` sat in the safe-subcommand tuple because they usually print
# a diff — but `git show HEAD:.env.local` prints the blob, and `git log -p`
# prints every version it ever had.


@pytest.mark.parametrize(
    "command",
    [
        "git show HEAD:.env.local",
        "git show :.env.local",
        "git log -p -- .env.local",
        "cat .env.l*",                                        # the glob route
        "set -a && . ./.env.local && printenv CONVEX_DEPLOY_KEY_PROD_VP",
    ],
)
def test_etas_remaining_routes_are_refused(command):
    assert run(command) == 2, command


@pytest.mark.parametrize(
    "command",
    [
        "git check-ignore .env.local",   # a FALSE POSITIVE at c65cd7a
        "git ls-files .env.local",
        "git status --short",
        "git log --oneline -3",
        "git add .env.local",
    ],
)
def test_git_subcommands_that_print_no_content_still_pass(command):
    """The control on dropping log and show: a guard that refuses every git
    command naming the path would refuse `git add .env.local`, which is how the
    file gets ignored in the first place."""
    assert run(command) == 0, command

