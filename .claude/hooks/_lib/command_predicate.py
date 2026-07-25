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
    for prev, tok in zip(tokens, tokens[1:]):
        if " " not in tok or prev not in CMD_STRING_ANCHORS:
            continue
        try:
            inner = shlex.split(tok)
        except ValueError:
            continue
        action = _scan_prod_action(inner, binary)
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
