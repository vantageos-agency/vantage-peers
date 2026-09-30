#!/usr/bin/env python3
"""A secrets file may be SOURCED or READ BY NAME. It may not be PRINTED.

THE DEFECT THIS CLOSES, and it was committed by the author of this file.

On 2026-09-30 a subagent was dispatched with a brief whose words were:
"Never print a secret's value. Name the variable, never its content." The
subagent ran `cat .env.local` as its first step. The production Convex deploy
key, the dev key and the Clerk secret keys were printed into its transcript.
Its own `sed` redaction was applied AFTER, and did not cover that call.

The brief was not ignored. It was obeyed by an agent that had already printed
the file before it reached the part of its work where the rule applied. Nothing
between the instruction and the output could refuse. A second brief saying the
same sentence more firmly would not have changed a character of that outcome.

So the rule stops being a sentence and becomes a refusal.

WHAT IS REFUSED, and it is narrow ON PURPOSE. A guard that blocks every touch
of a secrets file gets turned off within a day, and a guard everyone turns off
protects nothing. Only the forms that put VALUES on stdout are refused:

    cat .env.local                  refused
    head/tail/less/more .env        refused
    grep CONVEX .env.local          refused  (grep prints the whole line)
    awk/cut/jq over a secrets file  refused

WHAT PASSES, because it is how the file is legitimately used:

    set -a && . ./.env.local && set +a     sourcing prints nothing
    CONVEX_DEPLOY_KEY="$KEY_NAME" npx …    using a value by variable name
    grep -oE '^[A-Z_]+=' .env.local        names only, values not captured
    grep -c / test -f / ls -l on the file  existence and counts, not contents
    sed 's/=.*/=<hidden>/' .env.local      redaction applied BEFORE printing

The asymmetry is deliberate and is the safe direction: a command that might
print is refused, and a command that provably cannot is allowed. A refusal
costs one rewrite; a printed production key costs a rotation across a fleet.

OVERRIDE. `# allow-secret-file-read: <reason of 15 characters or more>` — for
the case where a human genuinely must see a value. Fifteen characters because a
reason shorter than that is a word, and a word is not a reason. Each use is a
line in the audit log, which is the whole difference from what happened.
"""

import json
import os
import re
import shlex
import sys

AUDIT_LOG = "/tmp/secret-file-print.log"

# Files whose CONTENTS are secrets. Matched on the basename, so a path prefix
# cannot hide one. `.env.example` and `.env.sample` are deliberately NOT here:
# they carry names with placeholder values and are meant to be read.
SECRET_FILE_RE = re.compile(
    r"""(?x)
    (?:^|[\s"'=/<>])                      # start, separator, or path boundary
    (?P<path>
        [^\s"';|&<>]*                   # optional directory part
        (?:
            \.env(?:\.[A-Za-z0-9_-]+)*  # .env, .env.local, .env.production.local, .env.local.bak
          | id_[rd]sa                   # ssh private keys
          | \.pem
          | auth\.json                  # vercel / npm credential stores
          | credentials(?:\.json)?
          | \.npmrc
        )
    )
    (?=$|[\s"';|&<>)])
    """
)

# Allowed because the placeholder files carry no real value.
PLACEHOLDER_RE = re.compile(r"\.env\.(?:example|sample|template)$")

# Commands that put a file's CONTENTS on stdout.
PRINTERS = (
    "cat", "bat", "head", "tail", "less", "more", "nl", "od", "xxd", "strings",
    "awk", "cut", "jq", "tr", "rev", "sort", "uniq", "tac", "column",
)

# `grep` prints the whole matching LINE, so `grep KEY .env` prints the value.
#
# -c, -l, -L and -q are UNCONDITIONALLY safe: a count, a filename, or nothing.
# Whatever the pattern captures, no byte of the file reaches stdout.
GREP_COUNT_ONLY_RE = re.compile(r"\bgrep\b[^|;&]*?\s-[A-Za-z]*[clLq][A-Za-z]*(?=\s|$)")

# -o is NOT safety, and reading it as such was this guard's own defect, found
# by pi at 7013758 in the family the guard exists to close. -o bounds the
# OUTPUT to the match; it never bounds the MATCH to a name. So a pattern
# reaching past the `=` prints the value with the guard's blessing:
#   grep -o 'KEY=.*' .env.local        prints the value
#   grep -oE 'KEY=.*' .env.local       prints the value
#   grep -o 'CONVEX_DEPLOY_KEY=.\+'    prints the value
#   grep -o '.*' .env.local            prints the WHOLE FILE
# It is the same shape as the `jq .` defect fixed above: there another
# command's ARGUMENT was read as a licence, here a FLAG is read as one
# whatever the pattern does. A flag cannot vouch for a pattern.
#
# So -o is safe only when the PATTERN ITSELF cannot reach a value: it must end
# at the `=`, never past it. `^[A-Z_]+=` qualifies; anything with a quantifier
# or a dot after the `=` does not.
GREP_NAMES_ONLY_RE = re.compile(
    r"""(?x)
    \bgrep\b[^|;&]*?\s-[A-Za-z]*o[A-Za-z]*\s+   # an -o form
    (?P<q>['"])                                  # the quoted pattern
    \^?\[?[A-Za-z_\\^\]A-Z-]*\]?[*+]?=          # a name class ending AT the =
    (?P=q)                                       # and closing immediately
    """
)


def grep_is_safe(segment: str) -> bool:
    """A grep over a secrets file is safe when it prints no value.

    Two ways, and only two: it asks for a count/filename/silence, or its
    pattern stops at the `=` so the match cannot contain what follows."""
    if GREP_COUNT_ONLY_RE.search(segment):
        return True
    return bool(GREP_NAMES_ONLY_RE.search(segment))

# `sed`/`perl` are safe when they REDACT before printing: the script replaces
# everything after the first `=`. Anything else with sed is treated as printing.
REDACTING_SED_RE = re.compile(r"s[/|#].*=\.\*[/|#]")

OVERRIDE_RE = re.compile(r"#\s*allow-secret-file-read:\s*(?P<reason>.{15,})")


def _unescape_quotes(text: str) -> str:
    """Remove backslashes that only escape a quote or a space.

    THE FIFTH APPEARANCE of this file's own mechanism, and the one that made
    every other refusal optional. Pi measured it on 1d62fdd:

        cat .env.local        rc=2
        cat \\".env.local\\"    rc=0     two characters, and the file is invisible

    Same verb, same path. The matcher read `\\"` as part of the filename, so any
    verb it refuses became reachable by adding a backslash. It also explains a
    result that looked like an interpreter class and was not: only the
    escaped-double-quote spelling of `python3 -c` passed, never the plain one.
    The discriminator was the quoting, never the language.

    Closed HERE, once, before anything else looks at the command — a per-verb
    patch would have left a sixth spelling for the next reviewer.

    A correction to a correction: the first fix for this shipped a corpus that
    asserted `cat ".env.local"` — plain quotes, which the boundary class ALREADY
    matched — so it passed 84/84 while the real payload stayed open. A test that
    pins the wrong spelling is the same defect wearing the fix's clothes."""
    return re.sub(r"\\([\"' ])", r"\1", text)


def secret_paths(command: str):
    """Every secrets-shaped path the command names, placeholders excluded."""
    found = []
    for m in SECRET_FILE_RE.finditer(_unescape_quotes(command)):
        path = m.group("path")
        if PLACEHOLDER_RE.search(path):
            continue
        found.append(path)
    return found


def _tokens(segment: str):
    """Shell-ish tokens. `cat<.env.local` has no space, so redirections are
    separated first — eta found that exact bypass: `<` was not a boundary."""
    spaced = re.sub(r"([<>])", r" \1 ", _unescape_quotes(segment))
    try:
        return shlex.split(spaced)
    except ValueError:
        return spaced.split()


def _pattern_stops_at_equals(pattern: str) -> bool:
    """Can this grep pattern match PAST the `=`?

    THE PROPERTY, not the spelling. Pi's correction at dc72c16c: the previous
    version hand-typed a character class with no `0-9` and no room for a
    literal fragment, so it refused
        grep -oE '^[A-Z0-9_]*CONVEX[A-Z0-9_]*=' .env.local
    which is the command `.claude/rules/per-project-env-names.md` PRESCRIBES to
    every station. A guard that refuses the fleet's own credential check is the
    guard that gets torn out this week, and then it protects nothing.

    That was a mono-formulation matcher written inside the fix for a
    mono-formulation matcher — one layer down, same disease. So the question is
    no longer how the pattern is spelled but whether anything follows the last
    `=`. Nothing after it, and no match can contain a value.

    HOLE 5 FIX (Pi): A pattern like `.*=` is greedy and will match to the LAST
    `=` in a line like `KEY1=val1 KEY2=val2`, which is inside val2. Reject if
    the part before = contains greedy quantifiers (.*, .+, .?, .[{) or negated
    character classes ([^...]) which can match values."""
    if "=" not in pattern:
        return False
    
    parts = pattern.rsplit("=", 1)
    tail = parts[1]
    before_equals = parts[0]
    
    # The tail must be empty (nothing after the =)
    if tail != "":
        return False
    
    # Check before_equals: reject if it has dangerous patterns
    # Dangerous: .* .+ . [^...] or other wide quantifiers
    
    if ".*" in before_equals or ".+" in before_equals:
        return False
    
    if "\\." in before_equals and "*" in before_equals:  # \.*
        return False
    
    if "[^" in before_equals:  # negated character class can match values
        return False
    
    if re.search(r'[.?](?=[*+{])', before_equals):  # .* .+ .? .{ etc
        return False
    
    return True


def _grep_is_safe(tokens) -> bool:
    """A grep over a secrets file prints no value in exactly two cases."""
    long_flags = [t for t in tokens if t.startswith("--")]
    # SHORT flags only. Joining the long ones in too made `--only-matching`
    # match the count-only pattern on the `c` of "matching" — a flag NAME's
    # letters read as flag LETTERS, which is the same argument-as-licence
    # mistake one more level down. Pi's `--only-matching 'KEY=.*'` found it.
    flags = "".join(t for t in tokens if t.startswith("-") and not t.startswith("--"))
    # -c, -l, -L, -q are UNCONDITIONAL: a count, a filename, or nothing. The
    # pattern cannot matter because no byte of the file reaches stdout.
    if re.search(r"-[A-Za-z]*[clLq]", flags) or any(
        f in ("--count", "--files-with-matches", "--files-without-match", "--quiet", "--silent")
        for f in long_flags
    ):
        return True
    # -o bounds the OUTPUT to the match, never the MATCH to a name. So it is
    # safe only when the PATTERN itself cannot reach past the `=`.
    has_o = bool(re.search(r"-[A-Za-z]*o", flags)) or "--only-matching" in long_flags
    if not has_o:
        return False

    # HOLE 6 FIX (Pi): Check ALL -e patterns, not just the first. Multiple -e
    # patterns should all be checked; if any can reach a value, it's unsafe.
    # Also refuse -f (pattern file that we cannot read).
    has_f = bool(re.search(r"-[A-Za-z]*f", flags)) or "--file" in long_flags
    if has_f:
        return False  # Pattern file: we cannot judge its contents

    patterns = []
    i = 1  # Skip the 'grep' command itself
    while i < len(tokens):
        t = tokens[i]
        if t in ("-e", "--regexp"):
            if i + 1 < len(tokens):
                patterns.append(tokens[i + 1])
                i += 2
            else:
                i += 1
        elif t.startswith("-"):
            i += 1
        elif secret_paths(t):
            i += 1
        else:
            # Non-flag, non-secret-path token might be a pattern
            patterns.append(t)
            i += 1

    # Check all collected patterns
    for pattern in patterns:
        if not _pattern_stops_at_equals(pattern):
            return False
    return True


def _sed_is_redacting(tokens) -> bool:
    """A sed over a secrets file is safe only when its SCRIPT replaces
    everything after the first `=`. Eta's bypass at dc72c16c: `sed -n p`
    prints, and the docstring claimed any non-redacting sed was caught while
    the code only looked for a redaction ANYWHERE in the segment."""
    for t in tokens[1:]:
        if t.startswith("-") or secret_paths(t):
            continue
        return bool(REDACTING_SED_RE.search(t))
    return False


def _git_subcommand_is_safe(segment: str) -> bool:
    """Git is trusted by SUBCOMMAND, not by verb name alone. Some subcommands
    like `diff --no-index` will print file contents."""
    tokens = _tokens(segment)
    if not tokens or tokens[0] not in ("git", "/usr/bin/git"):
        return False

    # Dangerous subcommands: diff (can print file contents)
    if len(tokens) > 1 and tokens[1] in ("diff",):
        # git diff --no-index /dev/null .env.local prints the file
        return False

    # git add, git commit, git log, git show, git status are safe with secrets paths
    # git status, git add, git commit, etc. don't print the file contents
    if len(tokens) > 1 and tokens[1] in ("add", "commit", "status", "log", "show"):
        return True

    # Any other git subcommand with a secrets path is refused
    if secret_paths(segment):
        return False

    return True


def prints_contents(command: str) -> bool:
    """Does any segment put a secrets file's contents on stdout?

    JUDGED ON THE VERB WHOSE OPERAND IS THE SECRETS PATH — eta's correction,
    and it closes a whole family at once. The previous version judged the
    SEGMENT, so anything appearing anywhere in it could vouch for anything
    else: `cat .env.local # grep -c` passed because a safe grep form was
    present in the text. That is the argument-as-licence class for the third
    time in this file, which is why the predicate is now structural rather
    than another pattern.

    Two further things a verb cannot see, handled beside it:
      - `set -a; . ./.env.local; env` — sourcing is safe and `env` is not;
        the value never passes through a file operand, it passes through the
        environment. Eta found it, and it is the shape our own advice creates.
      - a redirection with no space, `cat<.env.local`, tokenised above."""
    for segment in re.split(r"[;&|]+|\n", command):
        if not secret_paths(segment):
            # `env` / `printenv` after a source in an EARLIER segment prints
            # everything that source loaded. Judged across the command, since
            # by construction the path is not in this segment.

            # HOLE 8 FIX (Eta/Pi): Also catch bare `set` and `declare -p`
            if re.match(r"^\s*(?:env|printenv|set)\s*$|^\s*declare(?:\s+[-+]?[pfxar]+)?\s*$", segment) and any(
                re.match(r"\s*(?:source|\.)\s+\S", s) and secret_paths(s)
                for s in re.split(r"[;&|]+|\n", command)
            ):
                return True
            continue

        tokens = _tokens(segment)
        if not tokens:
            continue
        verb = os.path.basename(tokens[0])

        if verb in ("source", ".") or (verb == "set" and "." in tokens):
            continue
        if verb == "grep":
            if _grep_is_safe(tokens):
                continue
            return True
        if verb in ("sed", "perl"):
            if _sed_is_redacting(tokens):
                continue
            return True

        # HOLE 3 FIX (Pi): Git is judged by subcommand
        if verb == "git":
            if _git_subcommand_is_safe(segment):
                continue
            return True

        if verb in PRINTERS:
            return True

        # HOLE 2 FIX (Eta/Pi): cp and mv with secrets as SOURCE are leaks.
        # These are no longer in the passlist; they're checked specially.
        if verb in ("cp", "mv"):
            # If the first file operand (after flags) is a secrets path, it's a leak
            for i, t in enumerate(tokens[1:], 1):
                if t.startswith("-"):
                    continue
                # First non-flag argument is the source
                if secret_paths(t):
                    return True
                break
            continue

        # HOLE 4 FIX (Pi): find with -exec or -ok that runs a printer is a leak
        if verb == "find":
            has_exec = any(t in ("-exec", "-ok") for t in tokens)
            if has_exec:
                return True
            # find without -exec is just reporting, which is safe
            continue

        # A verb that reports ABOUT the file without revealing its contents.
        if verb in ("test", "[", "ls", "stat", "wc", "sha256sum", "md5sum",
                    "rm", "chmod", "chown", "touch"):
            continue

        # An UNKNOWN verb holding a secrets path as an operand is refused. A
        # guard that fails open on what it does not recognise is a guard that
        # can be walked past by naming any tool it has never heard of.
        return True
    return False


def audit(entry: dict) -> None:
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # a log that cannot be written never blocks a command


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0  # unreadable payload: this guard has nothing to judge

    if data.get("tool_name") != "Bash":
        return 0
    command = data.get("tool_input", {}).get("command", "")
    if not command:
        return 0

    paths = secret_paths(command)
    if not paths or not prints_contents(command):
        return 0

    override = OVERRIDE_RE.search(command)
    if override:
        audit({
            "verdict": "allow",
            "reason": "override",
            "override_reason": override.group("reason").strip()[:200],
            "paths": paths[:5],
        })
        return 0

    audit({"verdict": "block", "paths": paths[:5], "command": command[:200]})
    named = ", ".join(sorted(set(paths))[:5])
    print(
        f"BLOCKED: this command would print the CONTENTS of a secrets file: {named}\n"
        "\n"
        "A secrets file may be SOURCED or read BY VARIABLE NAME. It may not be\n"
        "printed. On 2026-09-30 a subagent whose brief said 'never print a secret's\n"
        "value' ran `cat .env.local` as its first step and put a production deploy\n"
        "key into its transcript. The brief was not ignored — nothing could refuse.\n"
        "\n"
        "What to do instead, in order of preference:\n"
        "  set -a && . ./.env.local && set +a      # source it; prints nothing\n"
        "  CONVEX_DEPLOY_KEY=\"$SOME_KEY_NAME\" ...   # use the value by its NAME\n"
        "  grep -oE '^[A-Z_]+=' .env.local         # the names, never the values\n"
        "  sed 's/=.*/=<hidden>/' .env.local       # redact BEFORE printing\n"
        "  test -f / ls -l / sha256sum             # facts about it, not its contents\n"
        "\n"
        "If a human genuinely must see a value, say why in the command:\n"
        "  <your command>  # allow-secret-file-read: <reason, 15 characters or more>\n"
        "\n"
        f"Audit trail: {AUDIT_LOG}\n",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
