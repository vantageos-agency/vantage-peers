"""Shared action-predicate tokenizer for fleet Bash-guard hooks.

EXTRACTED (Day 129/130 propagation pass) from `block-deploy-without-qa.py`
VERSION 2.0.0 (branch `fix/block-deploy-without-qa-action-predicate`, head
`8b6375a`'s sibling), which has survived FIVE rounds of adversarial review
(comment injection, wrappers, absolute paths, versioned packages, line
continuation, per-word quoting, value-taking flags on wrappers, positional
wrapper args, runner `--`/verb separators, `env -S`/interpreter recursion).

WHY A SHARED MODULE, NOT A SECOND COPY
---------------------------------------
`enforce-pi-authorization-before-prod-deploy.py` was answering the exact same
question ("does this command actually EXECUTE a sensitive Convex action?")
with its OWN regex ladder, and lost SIX rounds of the identical adversarial
game the tokenizer below already closed. Two independent implementations of
one predicate is not defence in depth -- it is two attack surfaces, and a
bypass found in one never protects the other. This module makes the bypass
corpus SHARED: any hook consuming it inherits every fix and every regression
test below, in one place, forever.

WHAT THIS MODULE DECIDES, AND WHAT IT DELIBERATELY DOES NOT
-------------------------------------------------------------
It decides on the ACTION (the real head-of-command token, after unwrapping
every transparent prefix / interpreter / runner), never on a substring of the
raw text. It does NOT know what "sensitive" means for any particular hook --
that is caller policy (e.g. "convex deploy" vs "npm publish"). Callers use
`iter_real_commands()` to get, for every real invocation found in a shell
command line (including ones nested inside `bash -c`, `eval`, `env -S`,
`script -c`, `watch`, `ssh host "..."`), the ACTUAL argv the shell will run --
already stripped of every transparent wrapper (`sudo`, `env`, `nice`, `npx`,
`bunx`, `exec`, `builtin`, npm/pnpm/yarn/bun/deno `run|exec|dlx|x`, ...) -- and
apply their own head/subcommand test on that argv.

TWO NEW TRANSPARENT PREFIXES ADDED HERE (not present in the QA-guard's
Day-128 vintage): `exec` and `builtin`. `exec convex deploy` / `builtin exec
convex deploy` / `exec -a foo npx convex deploy` replace or spawn the current
shell's argv with the wrapped command -- structurally identical to `sudo` or
`env`: it does not change WHAT runs, only HOW the process table records it.
`-a <name>` (bash's argv0-rename flag) is declared in VALUE_FLAGS["exec"] so
its value token is consumed, never mistaken for the command head.

FAIL-OPEN / FAIL-LOUD DISCIPLINE
---------------------------------
This module does not decide allow/block -- callers do. It surfaces
un-tokenizable segments as `(segment_text, None)` so a caller can apply its
OWN fail-open-vs-fail-closed policy (the QA guard fails CLOSED only when the
raw segment text plausibly mentions its trigger words; a caller with a
narrower/wider trigger vocabulary decides for itself).

Doctrine: measurement-integrity (a false garde is worse than a hole -- do not
paper over an angle mort with a default that merely feels safe).
"""
import os
import re
import shlex

# ---------------------------------------------------------------------------
# Transparent prefixes: they change HOW a command is invoked, never WHAT runs.
# ---------------------------------------------------------------------------
TRANSPARENT = {
    "sudo", "env", "command", "nice", "time", "npx", "bunx", "pnpx",
    "if", "then", "elif", "else", "fi", "while", "until", "do", "done",
    "for", "select", "case", "esac", "in",
    "nohup", "setsid", "stdbuf", "unbuffer", "chronic", "doas",
    "timeout", "flock", "xargs", "ionice", "taskset", "caffeinate", "chrt",
    # `watch` is BICEPHALOUS (Day 131, 8th round). QUOTED (`watch "npx convex
    # deploy"`) it is an INTERPRETER -- its argument is a command STRING, and
    # INTERPRETER_RE already recurses into it. UNQUOTED (`watch npx convex
    # deploy`) it re-joins its remaining argv with spaces and behaves as a
    # plain TRANSPARENT wrapper. It is BOTH, depending on the form -- exactly
    # the exec/command class of error from the previous round. Declaring it in
    # BOTH tables is not a contradiction: the interpreter regex only fires on
    # the quoted form, this set only matters for the unquoted one.
    "watch",
    # Added for the prod-auth propagation pass (Day 129/130): `exec` replaces
    # (or, with `-a`, spawns) the current shell's process image with the
    # wrapped command; `builtin` forces a shell builtin lookup (commonly
    # chained as `builtin exec ...`). Neither changes the ACTION, only its
    # bookkeeping in the process table -- same class as sudo/env/nice.
    "exec", "builtin",
}
RUNNERS = {"npm", "pnpm", "yarn", "bun", "deno"}
RUNNER_VERBS = {"run", "exec", "dlx", "x"}

# Positional (non-flag) arguments consumed by a wrapper BEFORE the real
# command: `timeout 60 <cmd>` (duration), `flock /tmp/lock <cmd>` (lockfile).
POSITIONAL_ARGS = {"timeout": 1, "flock": 1, "chrt": 1}

# Flags that consume the NEXT token as a value (never a boolean). Declared
# per-wrapper because a flag letter can mean different things on different
# wrappers (`-c` on deno vs `-c` on npx).
VALUE_FLAGS = {
    "npx":  {"-p", "--package", "-c", "--call", "--node-options", "--shell"},
    "bunx": {"-p", "--package"},
    "pnpx": {"-p", "--package"},
    "npm":  {"-p", "--package", "-c", "--call", "--prefix", "-w", "--workspace"},
    "pnpm": {"-p", "--package", "-c", "--filter", "-F", "--dir", "-C"},
    "yarn": {"-p", "--package"},
    "bun":  {"--cwd"},
    "deno": {"--allow-read", "--allow-write", "--cached-only", "--config", "-c"},
    "sudo": {"-u", "--user", "-g", "--group", "-p", "--prompt", "-C",
             "--close-from", "-D", "--chdir", "-R", "--chroot", "-U"},
    "env":  {"-u", "--unset", "-C", "--chdir"},
    "nice": {"-n", "--adjustment"},
    "time": {"-o", "--output", "-f", "--format"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "xargs": {"-I", "-i", "-n", "-P", "-d", "-s", "-a", "-E", "-L", "--replace",
              "--max-args", "--max-procs", "--delimiter", "--arg-file"},
    "doas":  {"-u", "-C"},
    "ionice": {"-c", "-n", "-p"},
    "taskset": {"-c", "--cpu-list"},
    "flock": {"-w", "--wait", "--timeout", "-E", "--conflict-exit-code"},
    # `exec -a <name>` renames argv[0] of the replaced process -- the VALUE is
    # the fake name, never the command head.
    "exec": {"-a"},
    # `watch -n 5 <cmd>` -- the interval is a VALUE. The GLUED form `-n5` is a
    # single token already eaten by the boolean skip, and `-n=5` likewise.
    "watch": {"-n", "--interval"},
    "caffeinate": {"-t", "-w"},
    "chrt": {"-p", "--pid"},
}

# Flags KNOWN to be boolean per wrapper. Used only to distinguish "known
# boolean" from "unknown flag" -- an unknown flag on a known wrapper is an
# angle mort neither hypothesis (boolean vs value-taking) is safe to guess.
KNOWN_BOOLEAN_FLAGS = {
    "npx":  {"-y", "--yes", "-q", "--quiet", "--no-install", "--prefer-online",
             "--prefer-offline", "--ignore-existing", "--silent"},
    "bunx": {"-y", "--yes", "--bun", "--silent"},
    "pnpx": {"-y", "--yes", "--silent"},
    "npm":  {"-y", "--yes", "--silent", "-s", "--quiet", "--no-install", "--offline"},
    "pnpm": {"-y", "--yes", "--silent", "-s", "--offline"},
    "yarn": {"-y", "--yes", "--silent"},
    "bun":  {"--silent", "--bun"},
    "deno": {"-A", "--allow-all", "--allow-net", "--allow-env", "--allow-run",
             "--no-check", "-q", "--quiet", "-r", "--reload"},
    "sudo": {"-E", "--preserve-env", "-n", "--non-interactive", "-k", "-b",
             "-i", "--login", "-s", "--shell", "-H"},
    "env":  {"-i", "--ignore-environment", "-0", "--null", "-v", "--debug",
             "-S", "--split-string"},
    "nice": set(),
    "time": {"-p", "--portability", "-v", "--verbose"},
    "timeout": {"--preserve-status", "--foreground", "-v", "--verbose"},
    "stdbuf": set(),
    "xargs": {"-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-p"},
    "doas":  {"-n", "-s"},
    "nohup": set(),
    "setsid": {"-f", "--fork", "-w", "--wait", "-c", "--ctty"},
    "unbuffer": {"-p"},
    "chronic": {"-e", "-v"},
    "flock": {"-s", "--shared", "-x", "--exclusive", "-n", "--nonblock", "-u",
              "--unlock", "-o", "--close"},
    "ionice": {"-t", "--ignore"},
    "taskset": {"-a", "--all-tasks", "-p", "--pid"},
    "command": {"-p", "-v", "-V"},
    # `exec -c`/`-l` clear the environment / start a login shell -- booleans.
    "exec": {"-c", "-l"},
    "builtin": set(),
    "watch": {"-d", "--differences", "-b", "--beep", "-e", "--errexit",
              "-g", "--chgexit", "-t", "--no-title", "-c", "--color",
              "-x", "--exec", "-p", "--precise", "-q"},
    "caffeinate": {"-d", "-i", "-m", "-s", "-u"},
    "chrt": {"-f", "--fifo", "-r", "--rr", "-o", "--other", "-b", "--batch",
             "-i", "--idle", "-a", "--all-tasks", "-R", "--reset-on-fork"},
}

# Flags that make an otherwise-sensitive invocation inert (simulate / print
# usage only). Caller policy decides WHICH invocations may be exempted by
# these -- this module only offers the vocabulary + a token-aware test.
SAFE_FLAGS = {"--dry-run", "--preview", "--help", "-h"}

# Blind-spot collector: unknown flags seen on a KNOWN wrapper during the LAST
# segment tokenized. Reset per segment by iter_real_commands(); callers read it
# right after each yield to DECLARE the blind spot on stderr (a guard must say
# what it could not see -- it must never guess silently).
UNKNOWN_FLAGS = []

# INTERPRETERS: wrappers whose value is a COMMAND STRING, recursed into
# (never skipped) by iter_real_commands().
INTERPRETER_RE = re.compile(
    r"\b(?:bash|sh|zsh)\s+-[a-zA-Z]*c[a-zA-Z]*\s+(\"[^\"]*\"|'[^']*')"
    r"|\beval\s+(\"[^\"]*\"|'[^']*')"
    r"|\benv\s+(?:-[a-zA-Z]*S|--split-string(?:=)?)\s*(\"[^\"]*\"|'[^']*')"
    r"|\bscript\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*c[a-zA-Z]*\s+(\"[^\"]*\"|'[^']*')"
    r"|\bwatch\s+(?:-\S+\s+)*(\"[^\"]*\"|'[^']*')"
    r"|\bssh\s+(?:-\S+\s+)*\S+\s+(\"[^\"]*\"|'[^']*')"
    # 7th-round hunt (Day 130/131): `npx -c '<cmd>'` / `npx --call '<cmd>'`
    # is documented npx behaviour -- "Execute string as if it was a script's
    # command" -- its quoted argument IS a command the shell runs, exactly
    # like `env -S`/`bash -c`. Before this branch it was swallowed as an
    # OPAQUE VALUE_FLAGS value (consumed, never inspected): `npx --package
    # convex -c 'convex deploy --yes'` tokenized to an EMPTY argv after
    # transparent-stripping and the real deploy inside the quoted string was
    # never seen. Lazily skips any tokens between `npx` and `-c`/`--call` so
    # it still matches with `--package <pkg>` or other flags in between.
    r"|\bnpx\b(?:\s+\S+)*?\s+(?:-c|--call)\s+(\"[^\"]*\"|'[^']*')"
    # Command-string wrappers that are not a shell: `su -c`, `su - u -c`,
    # `su --command=`, `runuser -l u -c`, `sg grp -c`, `flock f -c`. Each hands
    # its quoted argument to a shell, exactly like `bash -c`. Before this branch
    # none of them matched, so the caller's quote-stripping (which only spares
    # a command carrying an interpreter payload) erased the payload and a real
    # production action passed unseen. The flag may sit after any number of
    # unquoted tokens (user, group, lock file, `-l`), and the payload may be
    # glued to the flag (`-c'...'`). The lookbehind keeps `pseudo-su` and
    # `x.su` out; a leading path (`/usr/bin/su`) still matches. Prefixes
    # (`env`, `nohup`, `timeout N`, `nice -n 5`) need no handling here: the
    # pattern is unanchored on the left, as the `bash -c` branch is.
    r"|(?<![\w.-])(?:su|runuser|sg|flock)\b(?:\s+[^\s'\"]+)*?"
    # Long options are matched by FAMILY, not by name: getopt resolves any
    # unambiguous prefix, so `--co`, `--comm`, `--session-command` and
    # `--se` all select a command string on util-linux `su` / `runuser`.
    # No other long option of these heads starts with `c` or `se`.
    r"\s+(?:-[a-zA-Z]*c[a-zA-Z]*\s*|--(?:c[a-z]*|se[a-z-]*)(?:=|\s+))"
    r"(\"[^\"]*\"|'[^']*')"
)


# ---------------------------------------------------------------------------
# THE INVERSION (Day 131, 8th adversarial round) -- FAIL-CLOSED ON THE UNKNOWN.
#
# TRANSPARENT is an ALLOWLIST OF WRAPPERS. Every head nobody thought to write
# into it (`strace`, `proxychains`, `systemd-run`, `parallel`, `runuser`, `su`,
# `at`, ...) resolved to an unrecognised head and the segment passed: rc=0.
# The set of UNIX wrappers is OPEN and INFINITE -- seven rounds of enumeration
# proved it can never be closed that way; each round shipped, each round left a
# next one. Enumeration is the defect, not the missing entry.
#
# So we STOP enumerating wrappers and start enumerating READERS: the commands
# that DO NOT re-execute their arguments (they read, print, search, diff them).
# That set is CLOSED and small. Rule:
#
#   head is a deploy            -> BLOCK   (unchanged, caller policy)
#   head is a known READER      -> PASS    (SAFE_HEADS below)
#   head is ANYTHING ELSE, and the remaining tokens carry the action signature
#   as ADJACENT tokens (`convex` `deploy`)                    -> BLOCK, LOUDLY
#
# The safety of the inversion rests on ONE distinction, and it must hold:
#   grep "convex deploy" f   -> `convex deploy` is ONE quoted token, not two
#                               adjacent ones -> no signature -> PASS.
#   strace npx convex deploy -> `convex` and `deploy` are TWO adjacent tokens
#                               under an unknown head            -> BLOCK.
# Pinned by test_grep_quoted_phrase_is_one_token_not_two.
# ---------------------------------------------------------------------------

# READERS: commands that consume their argv as DATA, never re-executing it.
# A CLOSED set -- this is the whole point. Anything absent from it is treated
# as a potential execution wrapper (fail-CLOSED), not waved through.
SAFE_HEADS = {
    # search / read / print
    "grep", "rg", "egrep", "fgrep", "ag", "ack", "echo", "printf", "cat",
    "bat", "head", "tail", "less", "more", "wc", "tee",
    # transform / inspect
    "sed", "awk", "cut", "tr", "sort", "uniq", "jq", "yq", "diff", "comm",
    "column", "fold", "rev", "base64", "md5sum", "sha256sum",
    # filesystem / navigation
    "ls", "tree", "find", "fd", "stat", "file", "du", "df", "pwd", "cd",
    "realpath", "dirname", "basename", "which", "type", "test", "true",
    "false", "date", "sleep", "mkdir", "touch", "cp", "mv", "rm",
    # shell builtins that STORE a string (a variable value) without running
    # it. The later use of the stored string is judged where it runs
    # (`su -c "$CMD"`, `eval "$CMD"`, a bare `$CMD` head -> unreadable payload).
    # Absent on purpose: `alias` (its body RUNS when the alias is used: a
    # deferred execution, not a read) and `trap` (executes its string). Both
    # fall to the fail-closed branch. A command substitution inside an
    # assignment (`declare -r V="$(<cmd>)"`) executes immediately and is judged
    # by the quote-aware splitter, never by this list.
    "unalias", "export", "declare", "typeset", "local", "readonly",
    # VCS + network read surfaces (the caller still tests the URL itself:
    # prod-auth blocks /api/mutation + /api/action on the segment TEXT, so
    # `curl` being a READER here never weakens the HTTP-write gate)
    "git", "gh", "curl", "wget", "http",
    # script interpreters WITHOUT an inline-eval flag (see EVAL_FLAGS)
    "python", "python3", "node", "ruby", "perl", "php", "man",
}

# Interpreters that only read a FILE -- unless handed inline source, in which
# case they execute a string we cannot statically resolve: they lose their
# reader status and fall back to the fail-closed branch.
SCRIPT_HEADS = {"python", "python3", "node", "ruby", "perl", "php"}
EVAL_FLAGS = {"-c", "-e", "--eval", "--eval-string", "--exec", "-E"}

# Tokens after which a QUOTED argument is a COMMAND STRING, not data:
# `su -c '<cmd>'`, `runuser -c '<cmd>'`, `at now <<< '<cmd>'`, `systemd-run
# --command`. Anchoring on these (instead of inspecting every quoted token)
# is what keeps `cmd = 'npx convex deploy'` (a Python assignment in a heredoc)
# and `alias cvx='npx convex deploy'` OUT of the block decision.
CMD_STRING_ANCHORS = {"-c", "--command", "<<<"}


# A command-string flag, recognised by FAMILY rather than by wrapper name:
# `-c`, a short cluster ending in `c` (`-lc`), `--command`, any getopt prefix
# of it (`--co`, `--comm`), and any long option ending in `command`
# (`--session-command`, `--exec-command`). The value may be attached with `=`.
COMMAND_STRING_FLAG_RE = re.compile(
    r"^(?:-[a-zA-Z]*c|--c[a-z]*|--[a-z][a-z-]*command)(?:=(.*))?$", re.DOTALL
)


def _command_string_values(tokens):
    """Yield the RAW value handed to each command-string flag in `tokens`
    (`-c VALUE`, `--command=VALUE`, `<<< VALUE`), whatever its content."""
    for i, tok in enumerate(tokens):
        value = None
        if tok in CMD_STRING_ANCHORS:
            value = tokens[i + 1] if i + 1 < len(tokens) else None
        else:
            m = COMMAND_STRING_FLAG_RE.match(tok)
            if m:
                value = m.group(1) if m.group(1) is not None else (
                    tokens[i + 1] if i + 1 < len(tokens) else None
                )
        if value:
            yield value


def command_string_payloads(tokens):
    """Yield each tokenized command STRING handed to a command-string flag in
    `tokens` (`-c 'npx convex deploy'`, `--command='...'`, `<<< '...'`).

    Only a value that holds whitespace is a string worth judging: a one-word
    value cannot carry a `convex <verb>` pair. The caller decides what a
    payload means and under which heads; this function never judges."""
    for value in _command_string_values(tokens):
        if " " not in value:
            continue
        try:
            yield shlex.split(value)
        except ValueError:
            continue


# ---------------------------------------------------------------------------
# OUT-OF-GRAMMAR PAYLOADS -- the command-string flag is ONE way a quoted string
# reaches a shell; it is not the only one. The class is defined by the
# mechanism, not by a flag or a head:
#
#   a quoted string that holds a prod action, handed to a head that is not a
#   known READER, is judged -- whatever the head, whatever (or no) flag.
#
# It covers `tmux new -d '<cmd>'`, `watch -n 60 '<cmd>'` (the interval value
# leaves the string as the head), `launcher -c'<cmd>'` (payload glued to the
# flag), and inline programs that embed the string (`perl -e 'system("<cmd>")'`,
# `node -e '...execSync("<cmd>")'`, `python3 -c 'os.system("<cmd>")'`). The
# string is cut into WORDS on whitespace, quotes and the punctuation of the
# embedding language, so `system("npx convex deploy")` yields `npx convex
# deploy` as adjacent words exactly as the shell form would.
#
# The READER list stays the only list: a quoted phrase handed to a reader
# (`grep -c 'convex deploy' f`, `git commit -m "..."`) is data and never reaches
# this code (`carries_prod_action` returns first).
# ---------------------------------------------------------------------------

_WORD_SPLIT_RE = re.compile(r"[\s'\"`()\[\]{};,<>|&]+")


def quoted_string_payloads(tokens):
    """Yield, for every token of `tokens` that holds whitespace (a quoted
    string, an inline program), the list of WORDS it contains. Index 0 is
    included: `watch -n 60 '<cmd>'` leaves the string as the head."""
    for tok in tokens:
        if not re.search(r"\s", tok):
            continue
        words = [w for w in _WORD_SPLIT_RE.split(tok) if w]
        if words:
            yield words


# ---------------------------------------------------------------------------
# UNREADABLE PAYLOADS -- `su -c "$CMD"`, `bash -c "$(cat f)"`. The string the
# shell will run does not exist on the command line, so it cannot be judged.
# DECISION (fail-closed, scoped): the payload is refused ONLY when the same
# line also carries a Convex-capable context -- a `convex` binary token, a
# `CONVEX_*` variable or a `convex.cloud` / `convex.site` host. Reason: with
# such a context the variable may hold the very action this guard governs, and
# a refusal costs one authorization; without it the variable is almost surely
# an unrelated command (`bash -c "$X"` is daily shell work) and a refusal would
# gate every shell in the fleet until the guard is torn out. The residual -- a
# variable set in ANOTHER invocation -- is declared, not hidden: no line-level
# guard can read it.
# ---------------------------------------------------------------------------

_UNREADABLE_VALUE_RE = re.compile(r"(?:^|[;&|(])\s*[\"']?\$|`|\$\(")
_BARE_VARIABLE_RE = re.compile(r"^\$(?:\w+|\{\w+\})$")
_OPEN_EVAL_RE = re.compile(r"^eval\s*[\"']?\$?\s*$")
_CONVEX_HOST_RE = re.compile(r"\bconvex\.(?:cloud|site)\b", re.IGNORECASE)
_OPEN_COMMAND_STRING_RE = re.compile(
    r"\s(?:-[a-zA-Z]*c|--c[a-z]*|--[a-z][a-z-]*command)(?:=|\s+)?[\"']?$"
)


def has_convex_context(command: str, binary: str = "convex") -> bool:
    """True when `command` names the Convex CLI (a `convex` word, version- and
    path-normalised), a `CONVEX_*` variable, or a convex.cloud / convex.site
    host. Decided on WORDS, never on a substring: `ls convex/schema.ts` names a
    path inside the tree, not the binary, and carries no context."""
    if _CONVEX_HOST_RE.search(command):
        return True
    for word in re.split(r"[\s'\"`()\[\]{};,<>|&=:$]+", command):
        if not word:
            continue
        if word.startswith("CONVEX_"):
            return True
        if _strip_version_suffix(os.path.basename(word)) == binary:
            return True
    return False


def has_unreadable_command_string(tokens) -> bool:
    """True when a non-reader head is handed a command string whose content is
    a variable or a substitution (`su -c "$CMD"`): the string cannot be read.
    The CALLER decides whether that refuses (see the DECISION above)."""
    if not tokens or is_safe_head(tokens):
        return False
    head = _strip_version_suffix(os.path.basename(tokens[0]))
    if head == "eval":
        # `eval` re-parses and runs the words it is given: every argument is a
        # command string.
        return any(_UNREADABLE_VALUE_RE.search(t) for t in tokens[1:])
    if _BARE_VARIABLE_RE.match(tokens[0]):
        return True  # `$CMD` as the command itself
    return any(_UNREADABLE_VALUE_RE.search(v) for v in _command_string_values(tokens))


def segment_has_unreadable_command_string(segment: str) -> bool:
    """Text fallback for a segment that did not tokenize: `su -c "$(cat f)"`
    is cut at the substitution, leaving `su -c "` -- a command-string flag
    followed by an opened quote and nothing. Same decision, same reader gate."""
    if _OPEN_EVAL_RE.match(segment.strip()):
        return True  # `eval "$(cat f)"` cut at the substitution
    if not _OPEN_COMMAND_STRING_RE.search(segment):
        return False
    for word in segment.split():
        if "=" in word and not word.startswith("-"):
            continue
        base = _strip_version_suffix(os.path.basename(word))
        if base in TRANSPARENT:
            continue
        return base not in SAFE_HEADS
    return False


def is_safe_head(tokens) -> bool:
    """True if `tokens[0]` is a known READER -- a command that does not
    re-execute its arguments. `python3 script.py` is a reader-from-file for
    our purposes; `python3 -c '<source>'` is NOT (it executes a string), so it
    is demoted and handled by the fail-closed branch."""
    if not tokens:
        return False
    head = _strip_version_suffix(os.path.basename(tokens[0]))
    if head not in SAFE_HEADS:
        return False
    if head in SCRIPT_HEADS and any(t in EVAL_FLAGS for t in tokens[1:]):
        return False
    return True


def _has_adjacent_signature(tokens, binary: str, verb: str) -> bool:
    """True if `binary` (basename- and version-normalized: `convex`,
    `convex@latest`, `/usr/local/bin/convex`) is IMMEDIATELY followed by the
    literal `verb` token. TWO adjacent tokens -- never a substring, never a
    single quoted phrase."""
    for a, b in zip(tokens, tokens[1:]):
        if b == verb and _strip_version_suffix(os.path.basename(a)) == binary:
            return True
    return False


# ---------------------------------------------------------------------------
# THE SECOND INVERSION (Day 131, 9th round) -- THE VERB SET IS OPEN TOO.
#
# The 8th round inverted the WRAPPERS (stop enumerating wrappers, enumerate
# READERS) but wired that inversion to exactly ONE action: `convex deploy`.
# Every other prod-touching verb stayed on the old "recognised verb or nothing"
# path -- fail-OPEN. Measured before this change, not supposed:
#   rc=0  npx convex import --prod data.jsonl     <- DIRECT, no wrapper at all
#   rc=0  npx convex import --replace --prod x    <- WIPES the prod database
#   rc=0  npx convex env remove FOO --prod        <- deletes a prod secret
#   rc=0  npx convex data --prod ; npx convex codegen --prod
#
# Adding those five verbs would have been the SAME defect one level up: the set
# of `convex` subcommands is OPEN -- the next CLI release adds one and the hole
# reopens. An allowlist of READER verbs is no better: it is a SECOND list to
# maintain, and it rots exactly like the first.
#
# So: NO LIST AT ALL. One rule, nothing to maintain:
#
#   a `convex` invocation that TARGETS PROD  ->  the caller must gate it
#   (the caller's audited markers are the only way through).
#
# TARGETS PROD := the whole token `--prod` is present, OR the subcommand is
# `deploy` (which reaches prod through CONVEX_DEPLOY_KEY / CONVEX_DEPLOYMENT
# and has no `--prod` flag at all -- Day-100 hardening, unchanged).
#
# It follows -- deliberately -- that `convex logs --prod` and `convex env list
# --prod` are gated too. Reading prod is a DELIBERATE act; the audited
# `# read-only-query: <reason>` marker exists precisely for it, costs three
# seconds and leaves a trace. Untraced prod reads are not worth a list.
# Everything that does NOT target prod (`convex dev`, `convex env set FOO bar`,
# `convex logs`) passes untouched: daily work is never gated.
# ---------------------------------------------------------------------------

PROD_FLAG = "--prod"
# The two forms of "this pushes CODE to prod" -- the class that NO marker but a
# Pi authorization may ever excuse. `deploy` is the verb; `--push` is the flag
# `convex run` uses to upload code before running (a deploy in a run's
# clothing). This is not a maintenance list of dangerous verbs: it is the
# definition of a deploy. Everything else that targets prod is caught by the
# rule above without being named.
DEPLOY_VERB = "deploy"
DEPLOY_FLAG = "--push"


class ProdAction:
    """A `convex` invocation that TARGETS PROD.

    `is_deploy` = it pushes CODE to prod (`deploy`, or `run --push`): the
    caller must never let a read-only marker excuse it (regression #210)."""

    __slots__ = ("verb_path", "is_deploy")

    def __init__(self, verb_path, is_deploy=False):
        self.verb_path = tuple(verb_path)
        self.is_deploy = is_deploy

    @property
    def label(self) -> str:
        return "convex " + " ".join(self.verb_path)

    def __repr__(self):  # pragma: no cover - debugging aid
        return f"<ProdAction {self.label} is_deploy={self.is_deploy}>"


# `--help` / `-h` print usage for ANY subcommand -- always inert.
# `--dry-run` / `--preview` are REAL flags of `convex deploy` ONLY. On any other
# subcommand they do not exist: `convex env set K v --prod --dry-run` simulates
# NOTHING, and taking an unknown flag as proof of inertness is exactly how a
# guard gets disarmed by a flag its target never had (pinned by
# test_env_set_prod_not_exempted_by_sibling_dry_run). The de-escalation is
# therefore scoped to the one subcommand that actually implements it.
HELP_FLAGS = {"--help", "-h"}


def _classify_convex_invocation(binary_idx, tokens):
    """Classify `tokens[binary_idx:]` (a `convex` binary + its argv).
    Returns a `ProdAction` when the invocation targets prod, else None."""
    rest = list(tokens[binary_idx + 1:])
    if not rest or HELP_FLAGS.intersection(rest):
        return None
    verbs = tuple(t for t in rest if not t.startswith("-"))
    if not verbs:
        return None  # `convex --version` and friends: no subcommand, no action
    if PROD_FLAG not in rest and verbs[0] != DEPLOY_VERB:
        return None  # dev deployment: daily work, never gated
    if verbs[0] == DEPLOY_VERB and has_safe_flag(rest):
        return None  # `convex deploy --dry-run` / `--preview`: genuinely inert
    return ProdAction(verbs, verbs[0] == DEPLOY_VERB or DEPLOY_FLAG in rest)


def head_prod_action(tokens, binary: str = "convex"):
    """Prod action of a HEAD-ANCHORED invocation -- `tokens[0]` IS the binary,
    after transparent-prefix stripping (`npx convex import --prod x`)."""
    if not tokens:
        return None
    if _strip_version_suffix(os.path.basename(tokens[0])) != binary:
        return None
    return _classify_convex_invocation(0, tokens)


def _scan_prod_action(tokens, binary: str = "convex"):
    """First prod action carried by ANY `convex` binary token in `tokens`."""
    for i, tok in enumerate(tokens):
        if _strip_version_suffix(os.path.basename(tok)) != binary:
            continue
        action = _classify_convex_invocation(i, tokens)
        if action:
            return action
    return None


def carries_prod_action(tokens, binary: str = "convex"):
    """FAIL-CLOSED probe -- an UNRECOGNISED head carrying a prod action.

    Same shape as `carries_action_signature` (kept below for the QA guard), but
    it no longer hard-codes `<binary> deploy`: any `convex` invocation that
    targets prod counts -- directly (`eatmydata npx convex import --prod x`,
    `strace npx convex env remove K --prod`) or inside a command-string
    argument anchored by `-c` / `--command` / `<<<` (`su -c 'npx convex env set
    K v --prod' ci`).

    `grep "convex import --prod" f` stays clean on BOTH counts: `grep` is a
    declared READER head, and the phrase is ONE quoted token -- never argv."""
    # NOTE: no blanket `has_safe_flag(tokens)` short-circuit here -- inertness is
    # decided per-invocation by _classify_convex_invocation(), which only honours
    # `--dry-run`/`--preview` on `deploy`. A blanket check would let
    # `strace npx convex import --prod x --dry-run` (a flag `import` does not
    # have) wave the whole segment through.
    if not tokens or is_safe_head(tokens):
        return None
    action = _scan_prod_action(tokens[1:], binary)
    if action:
        return action
    for inner in command_string_payloads(tokens):
        action = _scan_prod_action(inner, binary) or carries_prod_action(inner, binary)
        if action:
            return action
    # Out-of-grammar payloads: ANY quoted string under a non-reader head.
    for words in quoted_string_payloads(tokens):
        action = _scan_prod_action(words, binary)
        if action:
            return action
    return None


def carries_action_signature(tokens, binary: str, verb: str) -> bool:
    """FAIL-CLOSED probe for an UNRECOGNISED wrapper carrying a real action.

    Call it only AFTER your own head test said "not my action". Returns True
    when the head is not a known READER and the argv still carries
    `<binary> <verb>` as two ADJACENT tokens -- either directly (`strace npx
    convex deploy`, `systemd-run npx convex deploy`, `runuser -u ci -- npx
    convex deploy`) or inside a single quoted argument that is itself a
    command string (`su -c 'npx convex deploy' ci`, `at now <<< 'npx convex
    deploy'`) -- because an unknown head is, by construction, a head we cannot
    prove is harmless.

    SAFE_FLAGS (`--dry-run`, `--help`, ...) still de-escalate: an inert
    invocation stays inert under any wrapper."""
    if not tokens or is_safe_head(tokens):
        return False
    if has_safe_flag(tokens):
        return False
    if _has_adjacent_signature(tokens[1:], binary, verb):
        return True
    # A quoted argument may BE a command string handed to an unknown head
    # (`su -c 'npx convex deploy' ci`, `at now <<< 'npx convex deploy'`). We
    # look inside ONLY when the token is ANCHORED by a command-string flag
    # (`-c` / `--command` / here-string `<<<`), and ONLY under a non-reader
    # head. Both restrictions are load-bearing, each pinned by a test:
    #   * without the ANCHOR, `cmd = 'npx convex deploy'` inside a heredoc body
    #     (a Python assignment, pure DATA) would be read as an execution ->
    #     false positive (test_heredoc_body_mentioning_deploy_passes), as would
    #     `alias cvx='npx convex deploy'` (test_alias_indirection_fails_open).
    #   * without the READER gate, `grep -c "convex deploy" f` (-c = count!)
    #     would be read as `sh -c` -> false positive.
    for prev, tok in zip(tokens, tokens[1:]):
        if " " not in tok or prev not in CMD_STRING_ANCHORS:
            continue
        try:
            inner = shlex.split(tok)
        except ValueError:
            continue
        if _has_adjacent_signature(inner, binary, verb) and not has_safe_flag(inner):
            return True
    return False


def strip_comments(cmd: str) -> str:
    """Remove shell comments (# ...) OUTSIDE quotes -- quote-aware, so a '#'
    inside a literal string is never treated as a comment start."""
    out, quote = [], None
    i = 0
    while i < len(cmd):
        ch = cmd[i]
        if quote:
            out.append(ch)
            if ch == quote and (i == 0 or cmd[i - 1] != "\\"):
                quote = None
        elif ch in "\"'":
            quote = ch
            out.append(ch)
        elif ch == "#":
            nl = cmd.find("\n", i)
            if nl == -1:
                break
            out.append("\n")
            i = nl + 1
            continue
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def split_commands(cmd: str):
    """Split into real commands on `; && || | ( ) \\n`, and on backtick /
    `$(...)` command-substitution boundaries -- QUOTE-AWARE throughout, so a
    delimiter char inside a literal string never fractures the command."""
    parts, cur = [], []
    quote = None
    stack = []
    i = 0

    def flush():
        parts.append("".join(cur))
        cur.clear()

    while i < len(cmd):
        ch = cmd[i]
        escaped = i > 0 and cmd[i - 1] == "\\"

        if quote == "'":
            cur.append(ch)
            if ch == "'":
                quote = None
            i += 1
            continue

        if quote == '"':
            if ch == "$" and i + 1 < len(cmd) and cmd[i + 1] == "(" and not escaped:
                flush()
                stack.append('"')
                quote = None
                i += 2
                continue
            if ch == "`" and not escaped:
                flush()
                stack.append('"')
                quote = None
                i += 1
                continue
            cur.append(ch)
            if ch == '"' and not escaped:
                quote = None
            i += 1
            continue

        if ch in "\"'" and not escaped:
            quote = ch
            cur.append(ch)
            i += 1
            continue

        if ch == "`" and not escaped:
            flush()
            quote = stack.pop() if stack else None
            i += 1
            continue

        if ch == ")" and stack and not escaped:
            flush()
            quote = stack.pop()
            i += 1
            continue

        if ch in ";|&()\n" and not escaped:
            flush()
            i += 1
            continue

        cur.append(ch)
        i += 1

    flush()
    return [p.strip() for p in parts if p.strip()]


def _strip_version_suffix(base: str) -> str:
    """`convex@latest` -> `convex`. A leading `@` (scoped package, e.g.
    `@vantageos/foo`) is NOT a version suffix and is left untouched. Deno's
    `npm:`/`jsr:` scheme prefixes are normalized away first."""
    for scheme in ("npm:", "jsr:"):
        if base.startswith(scheme):
            base = base[len(scheme):]
            break
    if "@" in base and not base.startswith("@"):
        return base.split("@", 1)[0]
    return base


def strip_transparent(tokens):
    """Retire sudo/env/VAR=val/npx/exec/builtin/npm-run-etc prefixes until the
    real command head. Tokens are basename-normalized identically to the head
    test below, so `/usr/bin/npx convex deploy` is recognised exactly like
    `npx convex deploy`."""
    i = 0
    while i < len(tokens):
        t = tokens[i]
        base = os.path.basename(t)
        if base in TRANSPARENT:
            i += 1
            i = _skip_wrapper_flags(tokens, i, base)
            for _ in range(POSITIONAL_ARGS.get(base, 0)):
                if i < len(tokens) and not tokens[i].startswith("-"):
                    i += 1
            continue
        if not t.startswith("-") and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t):
            i += 1  # VAR=val
            continue
        if base in RUNNERS:
            i += 1
            i = _skip_wrapper_flags(tokens, i, base)
            if i < len(tokens) and tokens[i] in RUNNER_VERBS:
                i += 1
                i = _skip_wrapper_flags(tokens, i, base)
            continue
        break
    return tokens[i:]


def _skip_wrapper_flags(tokens, i, wrapper=None):
    """Advance `i` past the flags of the transparent wrapper that precedes,
    consuming a value-flag's value token too (`sudo -u root`, `npx -p convex`)
    so the value never becomes the mistaken command head.

    Unknown flags on a KNOWN wrapper are recorded in `UNKNOWN_FLAGS` (blind
    spot: we cannot know whether they consume the next token). Callers drain
    it to DECLARE the blind spot on stderr rather than guess silently."""
    value_flags = VALUE_FLAGS.get(wrapper, set()) if wrapper else set()
    bool_flags = KNOWN_BOOLEAN_FLAGS.get(wrapper, set()) if wrapper else set()
    while i < len(tokens) and tokens[i].startswith("-"):
        tok = tokens[i]
        stem = tok.split("=", 1)[0]
        # SHORT ATTACHED form: `-o0` (stdbuf), `-I{}` (xargs), `-n5` (watch).
        # The value is GLUED to a KNOWN flag -- it consumes no separate token.
        # Without recognising it, the guard cried blind-spot on perfectly known
        # forms, and a warning that cries wolf stops being read.
        attached = (len(tok) > 2 and not tok.startswith("--")
                    and (tok[:2] in value_flags or tok[:2] in bool_flags))
        if (wrapper and tok != "--" and not attached
                and stem not in value_flags and stem not in bool_flags):
            UNKNOWN_FLAGS.append((wrapper, tok))
        i += 1
        if tok in value_flags and "=" not in tok:
            if i < len(tokens) and not tokens[i].startswith("-"):
                i += 1  # consume the flag's VALUE
    return i


def normalize_line_continuations(cmd: str) -> str:
    """Collapse `\\` + newline (shell line continuation) to a single space --
    the shell treats it as whitespace, so the tokenizer must too. Without
    this, a real multi-line deploy command fractures across an unterminated
    backslash and a naive segment-splitter mis-tokenizes it."""
    return re.sub(r"\\\r?\n", " ", cmd)


def iter_real_commands(cmd: str):
    """Yield `(segment_text, tokens)` for every REAL command invocation found
    in `cmd`, after: line-continuation collapse, quote-aware comment
    stripping, quote-aware splitting on `; && || | ( ) \\n` and backtick /
    `$(...)` substitution, transparent-wrapper stripping, and RECURSION into
    `bash -c "..."` / `eval "..."` / `env -S "..."` / `script -c "..."` /
    `watch "..."` / `ssh host "..."` interpreter arguments.

    `tokens` is the argv AFTER every transparent prefix has been stripped --
    `tokens[0]` is the real command head. `tokens` is `None` when the segment
    could not be shlex-tokenized (unbalanced quote etc.) -- the caller decides
    its own fail-open/fail-closed policy on `segment_text` in that case.

    `segment_text` is the comment-stripped, quote-PRESERVING piece text (quote
    characters are kept, so a caller doing its own substring test, e.g. a URL
    pattern inside a curl invocation, still matches through quotes).
    """
    cmd = normalize_line_continuations(cmd)
    cmd = strip_comments(cmd)

    for groups in INTERPRETER_RE.findall(cmd):
        for quoted in (groups if isinstance(groups, tuple) else (groups,)):
            if quoted:
                yield from iter_real_commands(quoted[1:-1])

    for piece in split_commands(cmd):
        try:
            tokens = shlex.split(piece)
        except ValueError:
            yield (piece, None)
            continue
        if not tokens:
            continue
        del UNKNOWN_FLAGS[:]  # blind-spot collector, one segment at a time
        tokens = strip_transparent(tokens)
        yield (piece, tokens)


def raw_carries_action_words(text: str, binary: str, verb: str,
                             skip_subcommands=frozenset()) -> bool:
    """Last-resort probe on RAW text, for a segment the tokenizer could not
    split (`tokens is None`) or a payload that could not be parsed at all.

    Before this helper each deploy gate carried its own `"convex" in low and
    "deploy" in low` substring test, and the env var NAME `CONVEX_DEPLOY_KEY`
    alone satisfied both substrings: a catalogue write (`CONVEX_DEPLOY_KEY=...
    convex run <fn> "$(cat args.json)"`, whose `"$(...)"` leaves an orphan quote
    in the piece split_commands yields) was refused as a code deploy.

    The rule here is WORDS, not substrings:
      * `binary` must be a standalone word (a path prefix `node_modules/.bin/`
        and a version suffix `@latest` are allowed; an identifier fragment
        such as `CONVEX_DEPLOY_KEY`, `convex.json` or `$convex` is not).
      * `verb` must be a standalone word AFTER that binary word (never part of
        `DEPLOY_KEY`, `deployKey`, `deploy.sh`, `scripts/deploy`, `DEPLOY=1`).
      * a binary word whose next word is in `skip_subcommands` (e.g. `run`)
        is not the action -- unless `--push` follows, which uploads code.
    It stays FAIL-CLOSED in intent: any binary word NOT followed by a skipped
    subcommand, with the verb word anywhere after it, returns True."""
    low = (text or "").lower()
    binary_re = re.compile(
        r"(?<![\w.$-])" + re.escape(binary) + r"(?:@[^\s'\"]*)?(?![\w.=-])"
    )
    verb_re = re.compile(r"(?<![\w./$-])" + re.escape(verb) + r"(?![\w.=-])")
    for m in binary_re.finditer(low):
        after = low[m.end():]
        nxt = re.match(r"""[\s'"]*([^\s'"]+)""", after)
        if (nxt and nxt.group(1) in skip_subcommands
                and not re.search(r"(?<!\S)" + re.escape(DEPLOY_FLAG) + r"(?![\w-])", after)):
            continue
        if verb_re.search(after):
            return True
    return False


def head_matches(tokens, name: str) -> bool:
    """True if `tokens[0]`, basename- and version-suffix-normalized, equals
    `name` literally -- never a substring match."""
    if not tokens:
        return False
    return _strip_version_suffix(os.path.basename(tokens[0])) == name


def has_safe_flag(segment_or_tokens) -> bool:
    """True if a SAFE_FLAGS token is present as a real, whitespace-delimited
    word (string form) or a real token (list form) -- never a substring match
    on quoted prose."""
    if isinstance(segment_or_tokens, str):
        pattern = r"(?:^|\s)(?:" + "|".join(re.escape(f) for f in SAFE_FLAGS) + r")(?:\s|$)"
        return bool(re.search(pattern, segment_or_tokens))
    return any(t in SAFE_FLAGS for t in segment_or_tokens)


# ---------------------------------------------------------------------------
# STDIN INTO A SHELL -- `echo '<cmd>' | sh`, `printf '%s' '<cmd>' | bash -s`.
# The producer is a READER (`echo`, `printf`) and the consumer is a bare shell
# whose argv holds no string at all, so judged one segment at a time NEITHER
# half carries the action. The unit of judgement is the PIPELINE: when a stage
# is a shell that reads its program from stdin, every earlier stage of the same
# pipeline is judged for a prod action regardless of its reader status -- a
# reader that feeds a shell is a carrier, not data.
#
# A shell given a script file (`... | bash install.sh`) reads the pipe as DATA
# and is not a consumer. `xargs` with no command (or a shell as its command)
# executes the words it reads and is one.
# ---------------------------------------------------------------------------

SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "csh", "tcsh"}
# Binaries that carry a shell as an applet: the shell is their first argument.
MULTIPLEXERS = {"busybox", "toybox"}
# Shell options that take the NEXT token as a value, never a script path.
SHELL_VALUE_FLAGS = {"-o", "+o", "-O", "+O", "--rcfile", "--init-file"}
STDIN_PATHS = {"/dev/stdin", "/dev/fd/0"}
_SHELL_CMD_FLAG_RE = re.compile(r"^-[a-zA-Z]*c[a-zA-Z]*$")
_DOT_SOURCE_RE = re.compile(r"(?:^|[;&|(\n])\s*\.\s+[</]")
_SHELL_WORDS = SHELLS | MULTIPLEXERS | {"source"}


def _pipelines(cmd: str):
    """Split `cmd` into pipelines, each a list of stage texts. Quote-aware.
    `|` and `|&` separate stages; `;`, `&&`, `||`, `&` and newline separate
    pipelines. The `&` of a redirection (`2>&1`, `&>f`) is not a separator."""
    pipelines = [[]]
    cur = []
    quote = None
    i, n = 0, len(cmd)

    def end_stage():
        pipelines[-1].append("".join(cur))
        cur.clear()

    while i < n:
        ch = cmd[i]
        if quote:
            cur.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < n:
                cur.append(cmd[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            cur.append(ch)
            cur.append(cmd[i + 1])
            i += 2
            continue
        if ch in "\"'":
            quote = ch
            cur.append(ch)
        elif ch == "|":
            end_stage()
            if i + 1 < n and cmd[i + 1] == "|":
                pipelines.append([])
                i += 1
            elif i + 1 < n and cmd[i + 1] == "&":
                i += 1
        elif ch == "&" and ((i > 0 and cmd[i - 1] in "<>") or (i + 1 < n and cmd[i + 1] == ">")):
            cur.append(ch)
        elif ch in ";&\n":
            end_stage()
            pipelines.append([])
        else:
            cur.append(ch)
        i += 1
    end_stage()
    return [p for p in pipelines if len(p) > 1]


def _stage_tokens(stage: str):
    stage = stage.strip().lstrip("({ ").rstrip(")} ;")
    try:
        return shlex.split(stage)
    except ValueError:
        return stage.split()


def _reads_program_from_stdin(tokens) -> bool:
    """True when the stage (transparent prefixes already stripped) is a shell
    that takes its program from stdin, or `xargs` executing what it reads."""
    if not tokens:
        return False
    head = _strip_version_suffix(os.path.basename(tokens[0]))
    args = tokens[1:]
    if head in MULTIPLEXERS:
        # `busybox sh`, `toybox sh`, `/bin/busybox ash`: the applet is the shell.
        return _reads_program_from_stdin(args)
    if head in {"source", "."}:
        return any(a in STDIN_PATHS for a in args)
    if head not in SHELLS:
        return False
    if any(_SHELL_CMD_FLAG_RE.match(a) for a in args):
        return False  # a command string, judged by the command-string path
    positional, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a in SHELL_VALUE_FLAGS:
            skip = True
        elif not a.startswith(("-", "+")):
            positional.append(a)
    if "-s" in args or "-" in args:
        return True
    return not positional or all(a in STDIN_PATHS for a in positional)


def prod_action_piped_into_shell(cmd: str, binary: str = "convex"):
    """The prod action carried by a pipeline whose last consumer is a shell
    reading stdin (or `xargs` running its input), else None. `cmd` is the raw
    command line -- quote characters intact, heredoc bodies already removed."""
    cmd = strip_comments(normalize_line_continuations(cmd))
    for stages in _pipelines(cmd):
        for idx, stage in enumerate(stages):
            if idx == 0:
                continue
            raw = _stage_tokens(stage)
            stripped = strip_transparent(list(raw))
            is_xargs = bool(raw) and os.path.basename(raw[0]) == "xargs" and (
                not stripped or _reads_program_from_stdin(stripped)
                or _strip_version_suffix(os.path.basename(stripped[0])) in SHELLS
            )
            if not (_reads_program_from_stdin(stripped) or is_xargs):
                continue
            for prior in stages[:idx]:
                toks = _stage_tokens(prior)
                candidates = [toks, *quoted_string_payloads(toks)]
                for words in candidates:
                    action = _scan_prod_action(words, binary)
                    if action:
                        return action
    return None


def prod_action_in_process_substitution(cmd: str, binary: str = "convex"):
    """A process substitution `<(...)` whose output a shell can run: `bash <(...)`,
    `bash < <(...)`, `exec 3< <(...); bash <&3`. The redirect or descriptor that
    carries the output to the shell can sit anywhere on the line, so the unit is
    the LINE: when it holds a `<(` and any shell word (`sh`, `bash`, `source`,
    `busybox`, ...), the text after each `<(` is judged word by word. A line with
    no shell (`diff <(a) <(b)`) is data and passes."""
    cmd = strip_comments(normalize_line_continuations(cmd))
    if "<(" not in cmd:
        return None
    line_words = [w for w in _WORD_SPLIT_RE.split(cmd) if w]
    if not (
        any(_strip_version_suffix(os.path.basename(w)) in _SHELL_WORDS for w in line_words)
        or _DOT_SOURCE_RE.search(cmd)
    ):
        return None
    for m in re.finditer(r"<\(", cmd):
        words = [w for w in _WORD_SPLIT_RE.split(cmd[m.end():]) if w]
        action = _scan_prod_action(words, binary)
        if action:
            return action
    return None


_HEREDOC_BODY_RE = re.compile(r"<<-?\s*(['\"]?)(\w+)\1([^\n]*)\n(.*?)\n[ \t]*\2\b", re.DOTALL)


def prod_action_in_heredoc_to_shell(cmd: str, binary: str = "convex"):
    """`sh <<EOF ... EOF`, `cat <<EOF | bash ... EOF`: the heredoc body is the
    PROGRAM a stdin-reading shell runs, not data. A heredoc consumed by anything
    else (`cat`, `python3`, `tee`) stays data. `cmd` is the raw line, heredoc
    bodies still in place -- the caller strips them AFTER this probe."""
    for m in _HEREDOC_BODY_RE.finditer(cmd):
        owner = re.split(r"[;&\n]", cmd[: m.start()])[-1]
        line = owner + " " + m.group(3)
        for stage in re.split(r"(?<!\|)\|(?!\|)", line):
            toks = strip_transparent(_stage_tokens(stage))
            if _reads_program_from_stdin(toks):
                words = [w for w in _WORD_SPLIT_RE.split(m.group(4)) if w]
                action = _scan_prod_action(words, binary)
                if action:
                    return action
    return None
