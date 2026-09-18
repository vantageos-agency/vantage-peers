#!/usr/bin/env python3
"""
PreToolUse hook : enforce Pi-signed authorization before Convex prod deploy.

Blocks Bash commands containing `npx convex deploy --prod` (or equivalents)
unless one of:
  - Env var PI_AUTHORIZED_TASK_ID is set to a valid VP task ID (k...)
  - Command includes explicit flag `--pi-authorized-task=k...`
  - Comment on same line `# pi-authorized: k...`
  - Laurent override comment `# laurent-direct-deploy`
  - For a READ-ONLY `convex run --prod` query (NOT a deploy): audited comment
    `# read-only-query: <reason>` (k174v3sw, Day-111). Scoped to convex-run
    only -- a `convex deploy` can NEVER bypass via this marker.

Whichever form carries the id, the hook FETCHES the referenced VP task via the
Convex HTTP public API (no CLI auth required -- workspace-agnostic) and
validates it before allowing:
  - [PROD-DEPLOY-AUTHORIZED] must appear in the task TITLE or its tags
    (every token actually issued carries it in the title; tags is null)
  - Task must have been created within the last 60 minutes (TTL)
  - Task must be assigned to the caller, checked ONLY when the caller is
    declared via env PI_AUTH_ORCHESTRATOR (the audit line records whether the
    check ran)
A fetch that fails, or a task that cannot be read, is a REFUSAL.

A `convex deploy` whose inline CONVEX_DEPLOY_KEY names the DEV environment is
not a prod deploy and passes without a token (see deploy_key_env()).

Reason: Day 82 doctrine (2026-05-26) -- Pi becomes fleet authority for prod
deploys. System autonomous, not Laurent-dependent.

Standing rule canonique:
  memory j57bkwc99fnwp348m52d9rw5p987ggq6 (global/feedback)
  mission k57a32vgtyy9x2gjqe456n6hhs87er7v (pi-autonomous-prod-deploy-authorization-v1)

Fix Day 90 (2026-06-02): fetch_task() uses urllib HTTP instead of subprocess
`npx convex run tasks:get` -- resolves cross-workspace auth failure.
Convex arg name: taskId (not id). Evidence: curl 200 verified.
VP task k17ev2zndfqgsq0w1tvqzaxhxs87w3b2.

Fix Day 127 (task k176wtgmtefh1143kzfkx9cxen8a9gkz): the predicate decides on
the ACTION, never on the deployment NAME. The old URL-only pattern blocked
read-only curls to /api/query (Eta, Pi) while the equivalent Python request
passed -- a guard that hinders honest work without stopping the forbidden
action disarms itself. Now: /api/mutation AND /api/action block (an action
runs server-side and can runMutation — same write surface, Eta REVISE
survivor B), /api/query and bare deployment URLs pass, `convex env set
--prod` blocks, `bash -c '<deploy>'` AND `eval '<deploy>'` are scanned
recursively (eval is the shell sibling of bash -c — survivor A), heredoc
bodies are stripped (data, not commands). Residual boundary, stated: a
heredoc piped INTO an interpreter as a script is not analyzed.

Fix Day 128 (SURVIVOR C — Eta BLOCKER, reproduced by Pi against the canonical
@26a4bb26 that had been reviewed, approved AND propagated fleet-wide): shell
COMMENTS were not stripped, so a `# --dev` in a comment — or any prose
containing `--dev` — disarmed the bare-deploy negative lookahead entirely and a
REAL production deploy passed WITHOUT Pi authorization. See strip_comments().
The contentHash proved the file's IDENTITY, never its CORRECTNESS.

Fix Day 129 (AXIS 5 — Eta REVISE #253, reproduced against the reconciled hook
AND the canonical @a619f547 already propagated to 43 repos + the client plugin):
a `@<version>` suffix on the `convex` binary (`npx convex@latest deploy`,
`convex@1.16.0 deploy`, `bunx convex@latest deploy`) broke the whitespace
adjacency every DEPLOY_PATTERNS / CONVEX_RUN_PATTERNS regex assumed between
`convex` and its subcommand, so `is_prod_deploy()` returned False and the
gate never fired. `npx convex@latest deploy` is the CANONICAL form in the
Convex docs -- the single most likely way a developer types a deploy -- and
it sailed through with ZERO authorization on both lineages, unseen until
Eta's audit. Every `convex` / `npx convex` / `bunx convex` token in every
pattern now accepts an optional version-pin suffix via CONVEX_VERSION_RE
(see source), scoped to stop at a shell separator so it cannot swallow a
chained command. The
read-only marker CANNOT be abused to excuse a versioned deploy: DEPLOY_PATTERNS
always wins over CONVEX_RUN_PATTERNS regardless of the `@version` suffix,
because is_convex_run_only() re-tests the SAME (now version-tolerant)
DEPLOY_PATTERNS list.

Fix (k174v3sw, Pi Day-111, #210, restored here after divergence reconciliation):
a READ-ONLY `convex run --prod` query is not a deploy -- it does not mutate
code/schema/data the way a deploy does. Adds an audited `# read-only-query:
<reason>` opt-out (reason >= 3 chars, greppable), SCOPED to convex-run only via
is_convex_run_only(): a `convex deploy` / bare deploy / cloud-URL push / env-set
/api-mutation / api-action can NEVER bypass via this marker -- the deploy class
always wins over the run-only class. has_readonly_marker() reads the RAW
command (same discipline as has_pi_authorization / has_laurent_override) --
NEVER a sanitized one, or the marker (which lives in a comment) would blind
itself the same way SURVIVOR C blinded the old bare-deploy lookahead.

Fix Day 130/131 (tokenizer migration -- fleet propagation target): this hook
decided on TEXT via a regex ladder (DEPLOY_PATTERNS / CONVEX_RUN_PATTERNS) and
lost SIX rounds of adversarial review (comment injection, wrappers, absolute
paths, versioned packages, line continuation, per-word quoting). Its sibling
`block-deploy-without-qa.py` carries a real ACTION tokenizer that survived
FIVE rounds of the same game. That tokenizer is now extracted to
`.claude/hooks/_lib/command_predicate.py` and this hook is its first
consumer: `is_prod_deploy()` / `is_convex_run_only()` now walk
`iter_real_commands()` (transparent-prefix stripping, interpreter recursion,
version-suffix normalization, quote-aware comment/segment splitting) and
decide on the real command HEAD, never a substring of the raw text. No new
regex was added here -- only the three comment-borne markers
(`has_pi_authorization` / `has_laurent_override` / `has_readonly_marker`)
still read the RAW, unstripped command, by design: they live in comments, and
the tokenizer strips comments before analysis.

Fix (task k17ehjnazhx88ctt8mkf9cyj218b3fga): the fail-closed fallback for an
UN-TOKENIZABLE segment decided on two INDEPENDENT substrings ("convex"
anywhere AND "deploy" anywhere). The environment variable name
CONVEX_DEPLOY_KEY supplies both on its own, so every command that posed the
production key was refused -- including a pure READ (`convex data`,
`convex dashboard`) and even a bare `export CONVEX_DEPLOY_KEY="$(...)"` with
no convex subcommand at all. The fallback now requires the words ADJACENT as
an ACTION (UNTOKENIZABLE_DEPLOY_RE), pinned-version suffix included, and the
`--prod` leg requires `convex` as a whole word (UNTOKENIZABLE_PROD_RE), so a
real prod action hidden in an un-parsable segment still blocks while a
variable NAME no longer fires.

Fix (union of the two lineages of this file): the allow path used to accept
the SPELLING of `# pi-authorized: k...` -- validate_task() existed but was
never called, so an invented, expired or foreign id passed. The allow path now
fetches the task and validates it (title marker, TTL, optional declared
assignee), and a failed fetch refuses. The stdin entrypoint reads stdin ONCE
into a variable and, if the decision logic crashes on a command that is a
prod action, exits 2 instead of failing open (see main()). The DEV door, the
shared reader-inversion predicate, the read-only-query and
laurent-direct-deploy escapes are kept. One DEV-door narrowing: the dev key
is now read from the deploy's OWN segment (deploy_is_dev_keyed()), quoted
values included, and every assignment in that segment must name dev. Before,
`CONVEX_DEPLOY_KEY=dev:x true; npx convex deploy` -- or an unquoted
`dev:x|secret`, whose `|` is a pipe -- was waved through as DEV while the
deploy itself ran with the ambient key.

Override discipline: PI_AUTHORIZED_TASK_ID is meant for one-shot pre-validated
deploy. Set, run command once, unset. Never persist in shell rc.

Audit trail: /tmp/pi-auth-prod-deploy.log (append-only per call).

Exit 0 = allow
Exit 2 = block
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# The shared module is imported INSIDE a guard of its own. A module-level
# import that fails exits 1, and 1 is not a blocking code here: the deploy then
# proceeds with no authorization at all. That is precisely the half-landed
# station this file exists to protect — a guard present, named correctly, and
# unable to run. A refusal that cannot be reached is not a refusal.
try:
    from _lib.command_predicate import (  # noqa: E402
        INTERPRETER_RE,
        carries_prod_action,
        head_prod_action,
        iter_real_commands,
    )
except Exception as _import_error:  # pragma: no cover - exercised by the probe
    def _refuse_unjudgeable() -> None:
        """Refuse a production deploy we cannot analyse; allow everything else.

        Read stdin ONCE here, because the normal entrypoint below never runs.
        The decision is deliberately crude — text, not the tokenizer, which is
        the thing that failed to load — and it errs towards refusing: a command
        naming a convex deploy is refused, anything else passes.

        Three corrections measured on this path, all by the reviewer. Requiring
        the two words ADJACENT missed every command that puts a flag between
        them, so the words are now required in ORDER and not side by side. The
        words were invisible inside quotes, so quotes are resolved first. And
        the resolution here is NOT the healthy path's whitespace rule: quote
        CHARACTERS are removed and every body is kept, whatever it contains.

        The whitespace rule keeps a quoted PHRASE inert, which is right where a
        tokenizer can then tell a search from a command. Here nothing can, and
        an interpreter payload IS a quoted phrase — so treating phrases as
        prose let `bash -c "…deploy…"` through, the exact form this path exists
        to catch. Refusing prose that merely names the action is the price, and
        it is the declared direction of this world: a station that cannot judge
        refuses and says which module it could not load. A search naming the
        action passes in the healthy world and is refused here; that asymmetry
        is deliberate, not an oversight.
        """
        import json as _json
        import re as _re

        try:
            _raw = sys.stdin.read()
        except Exception:
            _raw = ""
        try:
            _cmd = _json.loads(_raw or "{}").get("tool_input", {}).get("command", "")
        except Exception:
            _cmd = _raw or ""

        # Quotes are DELETED, never replaced by a space. The shell concatenates
        # adjacent quoted runs into one word, so a space here splits the very
        # word the shell will run: `"con"'vex'` is the binary, and a space-strip
        # reads two fragments and finds none. Deleting reproduces what the shell
        # does, which is the only reading that can be right.
        _cmd = (_cmd or "").replace('"', "").replace("'", "")
        if _re.search(
            r"\bconvex(?:@[\w.\-]+)?\b.*\bdeploy\b", _cmd or "", _re.IGNORECASE
        ):
            print(
                "REFUSING TO JUDGE: the authorization guard could not load its "
                f"command module ({_import_error}).\n"
                "This station has the guard but not the module it needs, so nothing "
                "here can tell an authorized deploy from an unauthorized one.\n"
                '"I could not check" and "this is authorized" are different answers.\n'
                "Restore .claude/hooks/_lib/command_predicate.py beside this file.\n",
                file=sys.stderr,
            )
            sys.exit(2)
        sys.exit(0)

    if not globals().get("_TESTING"):
        _refuse_unjudgeable()
    raise

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The deployment the tokens live on. Overridable so the tests can point the
# fetch at a local stub (never at a real deployment). The override is read from
# the HOOK process environment, which an inline `VP_CONVEX_URL=... cmd` prefix
# on the Bash command does not reach. Declared residual: whoever controls the
# hook process environment and a server that answers `tasks:get` with a valid
# token could make the guard allow -- the same trust already placed in that
# environment for PI_AUTHORIZED_TASK_ID.
VP_CONVEX_URL = os.environ.get(
    "VP_CONVEX_URL", "https://compassionate-goldfinch-737.convex.cloud"
)
HTTP_TIMEOUT_SEC = 10
TASK_TTL_SEC = 3600  # 60 minutes
PROD_DEPLOY_TAG = "[PROD-DEPLOY-AUTHORIZED]"
AUDIT_LOG = "/tmp/pi-auth-prod-deploy.log"

# Raw HTTP WRITE surfaces to a Convex deployment. These are not process
# invocations (no argv head to test) -- they are URL substrings inside a
# curl/fetch command, so they stay a direct regex test on the segment TEXT
# `iter_real_commands()` yields, same as before the tokenizer migration.
# The predicate is the ACTION (/api/mutation, /api/action), never the
# deployment NAME: a bare convex.cloud URL or /api/query is a READ and must
# pass (Day 127 -- the URL-only pattern false-fired on Eta's and Pi's
# read-only curls while the equivalent Python request passed, so the guard
# disarmed itself). /api/action is a WRITE vector too: a Convex action runs
# server-side and can call ctx.runMutation + external services (Eta REVISE
# Day 127, survivor B).
URL_MUTATION_RE = re.compile(r"https://[a-z0-9-]+\.convex\.cloud/api/mutation\b")
URL_ACTION_RE = re.compile(r"https://[a-z0-9-]+\.convex\.cloud/api/action\b")

# ---------------------------------------------------------------------------
# DEV vs PROD discrimination for a `convex deploy` (Day-142, task k17256kq).
#
# A `convex deploy` has NO `--prod` flag: it reaches whatever deployment its
# CONVEX_DEPLOY_KEY names. The shared tokenizer classifies the `deploy` VERB
# as prod-surface unconditionally (correct for `block-deploy-without-qa`, which
# gates dev AND prod on QA) -- so this Pi-authorization guard, whose intention
# is "no PROD deploy without Pi", must NOT inherit that verb-only verdict for
# the deploy case. It reads the DEPLOY TARGET from the command text, exactly
# as `.claude/rules/deploy-target-explicit.md` requires the target be NAMED in
# the command, never inherited.
#
#   CONVEX_DEPLOY_KEY=dev:...   -> DEV  -> ALLOW (zero friction, "dev d'abord")
#   CONVEX_DEPLOY_KEY=prod:...  -> PROD -> require Pi authorization
#   opaque ($VAR / absent / no recognized prefix) -> CONSERVATIVE -> require auth
#
# A convex deploy key is `<env>:<deployment-name>|<secret>`; only the `<env>`
# prefix is read here -- the secret value is NEVER inspected, matched, or
# printed. The inline assignment may be bare (`CONVEX_DEPLOY_KEY=dev:x cmd`) or
# `env`-wrapped (`env CONVEX_DEPLOY_KEY=dev:x cmd`); both put the assignment as
# a literal `CONVEX_DEPLOY_KEY=<val>` token in the command text.
#
# The key is read from the deploy's OWN segment, never from anywhere on the
# line: `CONVEX_DEPLOY_KEY=dev:x true; npx convex deploy` assigns the key to
# `true`, and the deploy runs with the ambient key -- which may be prod.
#
# This discrimination is SCOPED to the `deploy` verb only. An EXPLICIT prod
# surface -- a `--prod` flag (`env set --prod`, `import --prod`), a `--push`
# code upload, or a raw `/api/mutation` / `/api/action` HTTP write -- names
# prod on its own and is NEVER downgraded by a dev key.
# ---------------------------------------------------------------------------
# The value may be single-quoted, double-quoted or bare. A real key contains a
# `|`, so it has to be quoted to reach the command at all: unquoted, the `|` is a
# PIPE, the assignment stays in the first pipeline stage and the deploy in the
# next stage runs with whatever key is ambient.
DEPLOY_KEY_ASSIGN_RE = re.compile(
    r"\bCONVEX_DEPLOY_KEY=(?:'([^']*)'|\"([^\"]*)\"|([^\s'\";|&]*))"
)

# Fallback for a segment the tokenizer cannot parse (command substitution,
# unbalanced quoting). It must still fail closed on a REAL prod action hidden
# in there, without firing on prose or on a variable NAME. Two independent
# substring tests ("convex" somewhere AND "deploy" somewhere) cannot tell
# `npx convex deploy` from the environment variable CONVEX_DEPLOY_KEY. The
# deploy leg needs the words ADJACENT as an action, with the optional
# pinned-version suffix the Convex docs use (`convex@latest deploy`); the
# `--prod` leg needs `convex` as a whole word (`CONVEX_` is not one).
UNTOKENIZABLE_DEPLOY_RE = re.compile(
    r"\bconvex(?:@[\w.\-]+)?\s+deploy\b", re.IGNORECASE
)
UNTOKENIZABLE_PROD_RE = re.compile(
    r"(?<![\w-])convex(?:@[\w.\-]+)?(?![\w-]).*?\s--prod\b", re.IGNORECASE
)


def deploy_key_env(command: str) -> str | None:
    """The environment prefix of an inline `CONVEX_DEPLOY_KEY=<val>` assignment.

    Returns "dev", "prod", or None (absent / opaque `$VAR` / unrecognized
    prefix). Only the prefix before the first ':' is read -- the secret half of
    the key (after the '|') is never inspected.

    EVERY assignment on the line is read, not the first: "dev" only when all
    of them name dev. One dev assignment earlier on the line must not
    downgrade a prod-keyed or opaque deploy later on the same line."""
    envs = set()
    for m in DEPLOY_KEY_ASSIGN_RE.finditer(command):
        val = next((g for g in m.groups() if g is not None), "")
        if val.startswith("dev:"):
            envs.add("dev")
        elif val.startswith("prod:"):
            envs.add("prod")
        else:
            envs.add(None)
    if envs == {"dev"}:
        return "dev"
    if "prod" in envs:
        return "prod"
    return None


def _segment_prod_action(tokens):
    """The prod action carried by ONE tokenized segment, or None.

    TWO paths, both driven by the SHARED reader-inversion in
    `_lib/command_predicate.py` (Day-131, 9th round) -- this hook no longer
    owns a single per-verb predicate:

      * HEAD-ANCHORED (`npx convex import --prod x`): `head_prod_action`.
      * UNKNOWN HEAD carrying the action (`eatmydata npx convex env set K v
        --prod`, `su -c '...' ci`): `carries_prod_action` -- fail-CLOSED.

    The previous version enumerated the prod VERBS it happened to think of
    (`deploy`, `env set`, `run`) and left `import --prod` -- a DATA IMPORT INTO
    PROD -- passing IN THE CLEAR, plus `env remove --prod`, `data --prod`,
    `codegen --prod`, and every verb the next CLI release will add. Enumerating
    verbs is the same defect as enumerating wrappers, one level up. The module
    now enumerates the READERS (closed) and blocks everything else that targets
    prod, including subcommands that do not exist yet."""
    return head_prod_action(tokens) or carries_prod_action(tokens)


# Override token format: Convex task ID (k + 15-40 alphanumeric chars)
AUTHORIZED_TASK_RE = re.compile(r"\bk[a-z0-9]{15,40}\b")


# ---------------------------------------------------------------------------
# HTTP fetch (stdlib only -- no subprocess)
# ---------------------------------------------------------------------------

def fetch_task(task_id: str) -> dict | None:
    """Fetch task from VantagePeers via Convex HTTP public query API.

    Workspace-agnostic -- no Convex CLI auth required.
    Convex arg name is `taskId` (verified Day 90 via curl).

    Returns dict on success, None on any failure (network, not found, timeout).
    """
    payload = json.dumps(
        {"path": "tasks:get", "args": {"taskId": task_id}, "format": "json"}
    ).encode("utf-8")
    req = urllib.request.Request(
        url=f"{VP_CONVEX_URL}/api/query",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as response:
            if response.status != 200:
                return None
            data = json.loads(response.read().decode("utf-8"))
            if data.get("status") != "success":
                return None
            return data.get("value")
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError):
        return None


# ---------------------------------------------------------------------------
# Command analysis
# ---------------------------------------------------------------------------

HEREDOC_RE = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?\n.*?\n\1\b", re.DOTALL)


# ---------------------------------------------------------------------------
# strip_quoted_strings -- PORTED VERBATIM from
# enforce-eta-approval-before-npm-publish.py (defect C fix, v1.4.0). Removes
# content inside single/double quotes so a prod-deploy command CITED inside a
# quoted string (a review comment, a commit message) is not read as a real
# deploy -- mirroring how the npm-publish guard uses it.
# ---------------------------------------------------------------------------
def strip_quoted_strings(command: str) -> str:
    """Neutralise CITED text without neutralising a quoted ARGUMENT.

    Quoting is doing two unrelated jobs on one command line, and collapsing
    them is what opened this guard. In `git commit -m "docs about the deploy
    flow"` the quotes carry PROSE: the shell passes it as data and the words
    inside name nothing the shell will run. In `npx 'convex' deploy` the very
    same characters carry an ARGUMENT: the shell removes them before exec and
    runs exactly what the unquoted form runs. Emptying both alike made the
    second invisible -- `npx 'convex' deploy` became `npx '' deploy`, no
    convex binary, no deploy, and the production gate opened on a command one
    keystroke away from the form it refuses.

    The discriminant is WHITESPACE, and it is a property of the shell rather
    than of the text: a quoted run with no whitespace inside is a token the
    shell would have passed identically unquoted, so the quotes are noise and
    only they are removed. A quoted run containing whitespace is a phrase that
    exists BECAUSE it is quoted -- unquoted it would be several arguments --
    so it is emptied, and `grep -r "convex deploy" docs/` still reads as one
    argument to a reader rather than as a deployment.

    This is never a judgement about what the words mean: `"deploy"` is kept
    whatever it says, and the head test downstream decides whether the command
    it belongs to executes anything.
    """

    def _resolve(match: "re.Match") -> str:
        body = match.group(1)
        quote = match.group(0)[0]
        if body and not re.search(r"\s", body):
            return body
        return quote * 2

    command = re.sub(r'"([^"]*)"', _resolve, command)
    command = re.sub(r"'([^']*)'", _resolve, command)
    return command


def strip_heredocs(command: str) -> str:
    """Remove heredoc bodies: they are DATA fed to a program's stdin, not
    commands the shell runs. Without this, prose or code inside a heredoc
    (a Python script mentioning a deploy command) false-fires the guard.
    Declared boundary: a heredoc piped INTO an interpreter as a script is
    not analyzed — same residual boundary as the npm-publish guard.

    NOT part of the shared `command_predicate` module: heredoc stripping is
    orthogonal to the action-tokenizer (it removes DATA before the tokenizer
    ever sees a command line), and `block-deploy-without-qa.py` does not use
    heredocs at all in its own callers -- keeping it local avoids forcing an
    unrelated concern onto every module consumer."""
    return HEREDOC_RE.sub("<<HEREDOC_STRIPPED", command)


def is_prod_deploy(command: str) -> bool:
    """Returns True if `command` ACTUALLY EXECUTES a Convex prod deployment
    (`convex deploy`, bare `convex deploy`, `convex env set --prod`) or a raw
    HTTP write (`/api/mutation`, `/api/action`) -- deciding on the real
    command HEAD via the shared tokenizer, never on a text substring.

    Heredoc bodies are stripped first (DATA, not commands -- orthogonal to
    the tokenizer, see strip_heredocs()). Comment stripping, quote-aware
    segment splitting, transparent-prefix unwrapping and interpreter
    recursion (`bash -c`, `eval`, `env -S`, `script -c`, `watch`, `ssh host
    "..."`) are all handled by `iter_real_commands()`.
    """
    command = strip_heredocs(command)
    # v1.4.0 (defect C): a prod-deploy command CITED inside a QUOTED STRING
    # (a review comment, a commit message) must not be read as a real deploy.
    # Quote-stripping only runs when the RAW command carries NO interpreter
    # payload (`bash -c '...'`, `eval '...'`, `env -S '...'`, ...): those
    # payloads are REAL commands the shell executes, extracted by
    # `iter_real_commands()`'s own INTERPRETER_RE recursion on the UNSTRIPPED
    # text -- stripping their quotes first would blind that recursion to a
    # genuine deploy the same way SURVIVOR C blinded the old bare-deploy
    # lookahead. This mirrors the ordering discipline in the npm-publish
    # guard's is_fleet_publish() (interpreter unwrap wins over quote-strip).
    if not INTERPRETER_RE.search(command):
        command = strip_quoted_strings(command)
    for segment, tokens in iter_real_commands(command):
        if URL_MUTATION_RE.search(segment) or URL_ACTION_RE.search(segment):
            return True
        if tokens is None:
            # Un-tokenizable segment: fail-closed ONLY if the raw text
            # plausibly names a Convex binary AND a prod-mutating surface --
            # otherwise fail-open (a parsing artifact must never manufacture
            # a block on an unrelated benign command, nor on the variable
            # NAME CONVEX_DEPLOY_KEY).
            if UNTOKENIZABLE_DEPLOY_RE.search(segment) or UNTOKENIZABLE_PROD_RE.search(segment):
                return True
            continue
        if head_prod_action(tokens):
            return True
        # FAIL-CLOSED on the UNKNOWN (Day 131, 8th round -- now applied to the
        # WHOLE prod surface, not just `deploy`). The head is neither a convex
        # binary nor a known READER, yet the argv still carries a `convex`
        # invocation that TARGETS PROD outside the reader set: an unrecognised
        # wrapper (`strace`, `eatmydata`, `firejail`, `proxychains`,
        # `systemd-run`, `runuser`, `su`, `at`, ...) is executing it. We do not
        # enumerate wrappers (OPEN set) nor prod verbs (OPEN set): we enumerate
        # READERS (CLOSED). `grep "convex import --prod" f` still passes: `grep`
        # is a declared reader AND the phrase is one quoted token.
        action = carries_prod_action(tokens)
        if action:
            print(
                "enforce-pi-authorization: WRAPPER NON RECONNU portant "
                f"`{action.label}` (cible PROD) -- tete `{tokens[0]}` "
                f"inconnue: {segment!r}\n"
                "  Ce garde n'enumere plus les wrappers (ensemble OUVERT) : il "
                "enumere les LECTEURS (ensemble ferme). Une tete inconnue qui "
                "porte l'action est BLOQUEE par defaut.\n"
                "  Si cette tete est un LECTEUR legitime (elle n'execute pas "
                "ses arguments), declarez-la dans SAFE_HEADS "
                "(.claude/hooks/_lib/command_predicate.py). Sinon, obtenez "
                "l'autorisation Pi.",
                file=sys.stderr,
            )
            return True
    return False


def deploy_is_dev_keyed(command: str) -> bool:
    """True iff every prod surface in `command` is a `convex deploy` verb whose
    OWN segment carries an inline CONVEX_DEPLOY_KEY naming the DEV environment.

    Explicit-prod surfaces -- a `--prod` flag, a `--push` code upload, or a raw
    /api/mutation | /api/action HTTP write -- name prod on their own and are
    never key-discriminated. When any is present this returns False, so the
    dev-key downgrade cannot apply and Pi authorization stays required.

    A `deploy` verb has no `--prod` flag, so its target lives entirely in the
    key -- and only a key assigned in the deploy's own segment reaches it. A
    deploy segment without such a key is opaque, and opaque is conservative.
    """
    command = strip_heredocs(command)
    saw_deploy_verb = False
    for segment, tokens in iter_real_commands(command):
        if URL_MUTATION_RE.search(segment) or URL_ACTION_RE.search(segment):
            return False  # explicit HTTP prod write
        if tokens is None:
            # Same fallback words as is_prod_deploy(). The `--prod` test stays
            # the broad substring on purpose: here it can only REFUSE the dev
            # downgrade, never grant it.
            low = segment.lower()
            if "convex" in low and "--prod" in low:
                return False
            if UNTOKENIZABLE_DEPLOY_RE.search(segment):
                if deploy_key_env(segment) != "dev":
                    return False
                saw_deploy_verb = True
            continue
        action = head_prod_action(tokens) or carries_prod_action(tokens)
        if action is None:
            continue
        # A `deploy` verb reaches its target through CONVEX_DEPLOY_KEY -- it is
        # key-discriminated. Anything else that targets prod (`--prod` flag on
        # `env set` / `import` / `run`, or a `run --push` code upload -- whose
        # verb_path head is `run`, never `deploy`) is an explicit prod surface
        # the dev key must never downgrade.
        if not (action.verb_path and action.verb_path[0] == "deploy"):
            return False
        if deploy_key_env(segment) != "dev":
            return False
        saw_deploy_verb = True
    return saw_deploy_verb


def is_convex_run_only(command: str) -> bool:
    """True if `command` targets prod WITHOUT pushing code -- the surface the
    audited `# read-only-query: <reason>` marker may cover (#210).

    The DEPLOY class (`convex deploy`, `convex run --push`, a raw
    /api/mutation or /api/action HTTP write) can NEVER bypass via that marker,
    anywhere in the shell line: it always wins. Only a Pi authorization or the
    Laurent override opens it.

    DECLARED RESIDUAL (not a silent one): the marker is a TRACE, not a proof.
    A caller who writes `# read-only-query: peek` on `convex import --prod`
    passes -- exactly as a caller who writes a false `# pi-authorized:` would.
    The marker is greppable and every use is written to the audit log; it
    lowers the ceremony of a prod READ, it does not certify one.
    """
    command = strip_heredocs(command)
    prod_read = False
    is_deploy_class = False
    for segment, tokens in iter_real_commands(command):
        if URL_MUTATION_RE.search(segment) or URL_ACTION_RE.search(segment):
            is_deploy_class = True
            continue
        if tokens is None:
            continue
        action = _segment_prod_action(tokens)
        if action is None:
            continue
        if action.is_deploy:
            is_deploy_class = True
        else:
            prod_read = True
    return prod_read and not is_deploy_class


def has_readonly_marker(command: str) -> bool:
    """Audited opt-out for a READ-ONLY `convex run --prod` (k174v3sw, Pi Day-111).

    Format: `# read-only-query: <reason>` (reason >= 3 chars, greppable).
    SCOPED to convex-run only (see is_convex_run_only) -- a deploy can never
    bypass via this marker.

    Reads the RAW command, never the comment-stripped one (same discipline as
    has_pi_authorization / has_laurent_override): the marker LIVES in a
    comment, so stripping comments before reading it would blind the opt-out
    the same way SURVIVOR C blinded the bare-deploy lookahead.
    """
    return bool(re.search(r"#\s*read-only-query:\s*\S.{2,}", command))


def has_pi_authorization(command: str) -> bool:
    """Check for Pi-signed authorization (env var, inline flag, or comment).

    SPELLING only: this proves a token-shaped id is present, never that it
    authorizes anything. run_hook() fetches and validates the task
    (fetch_task() + validate_task()) before it allows.
    """
    # Env var (set BEFORE subprocess spawn, not inline-prefixed shell var)
    env_task = os.environ.get("PI_AUTHORIZED_TASK_ID", "").strip()
    if env_task and AUTHORIZED_TASK_RE.fullmatch(env_task):
        return True
    # Inline flag --pi-authorized-task=k...
    if re.search(r"--pi-authorized-task=k[a-z0-9]{15,40}\b", command):
        return True
    # Inline comment # pi-authorized: k...
    if re.search(r"#\s*pi-authorized:\s*k[a-z0-9]{15,40}\b", command):
        return True
    return False


def extract_task_id(command: str) -> str | None:
    """Extract task ID from env var, inline flag, or comment (in that order)."""
    env_task = os.environ.get("PI_AUTHORIZED_TASK_ID", "").strip()
    if env_task and AUTHORIZED_TASK_RE.fullmatch(env_task):
        return env_task

    flag_match = re.search(r"--pi-authorized-task=(k[a-z0-9]{15,40})\b", command)
    if flag_match:
        return flag_match.group(1)

    comment_match = re.search(r"#\s*pi-authorized:\s*(k[a-z0-9]{15,40})\b", command)
    if comment_match:
        return comment_match.group(1)

    return None


def has_laurent_override(command: str) -> bool:
    """Laurent direct override -- rare manual cases only."""
    return bool(re.search(r"#\s*laurent-direct-deploy\b", command))


# ---------------------------------------------------------------------------
# Task validation
# ---------------------------------------------------------------------------

def validate_task(task: dict | None, orchestrator: str | None) -> bool:
    """Validate a Pi-authorization task against required criteria.

    Criteria:
      1. Task must be a readable object (fetch succeeded)
      2. [PROD-DEPLOY-AUTHORIZED] must appear in the title or the tags
      3. Task must have been created within TASK_TTL_SEC (60 min)
      4. Task must be assigned to the requesting orchestrator -- checked only
         when the orchestrator is known (not None)

    Returns True if all criteria pass, False otherwise.
    """
    if not isinstance(task, dict):
        return False

    # The marker lives in the TITLE on every token actually issued; `tags` is
    # null on all of them. Checking only `tags` rejects every genuine token,
    # which is why wiring this function unchanged would have frozen the fleet.
    tags = task.get("tags") or []
    title = task.get("title") or ""
    if PROD_DEPLOY_TAG not in tags and PROD_DEPLOY_TAG not in title:
        return False

    created_ms = task.get("createdAt", 0)
    if not isinstance(created_ms, (int, float)):
        return False
    created_sec = created_ms / 1000
    if (time.time() - created_sec) > TASK_TTL_SEC:
        return False

    # The assignee check runs only when the caller is KNOWN. Station identity is
    # not reliably derivable today: an orchestrator routinely works in a
    # directory whose own CLAUDE.md names a different orchestrator, so deriving
    # identity from the path would assert the wrong caller -- worse than
    # asserting none. When the caller is unknown the check is SKIPPED and the
    # audit entry records that it was, never silently.
    if orchestrator is not None and task.get("assignedTo") != orchestrator:
        return False

    return True


def caller_orchestrator() -> str | None:
    """The orchestrator running this command, or None when it cannot be known.

    Only an explicit declaration counts. Anything inferred from the working
    directory would be wrong exactly where it matters.
    """
    declared = os.environ.get("PI_AUTH_ORCHESTRATOR", "").strip().lower()
    if declared and re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", declared):
        return declared
    return None


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def audit_log(entry: dict) -> None:
    """Append-only audit log to /tmp/pi-auth-prod-deploy.log."""
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Fail-open on log write error


# ---------------------------------------------------------------------------
# Core hook logic (extracted for testability)
# ---------------------------------------------------------------------------

def run_hook(command: str) -> int:
    """Execute hook decision logic for a given command string.

    Returns 0 (allow) or 2 (block).
    """
    if not is_prod_deploy(command):
        return 0

    # DEV deploy -- zero friction (Day-142, "dev d'abord"). When the ONLY prod
    # surface is a `convex deploy` verb (target reached via CONVEX_DEPLOY_KEY)
    # AND that inline key names the DEV environment, this guard's intention
    # ("no PROD deploy without Pi") does not apply: allow. An explicit prod
    # surface (`--prod`, `--push`, /api/mutation|action) makes
    # deploy_is_dev_keyed() False, so it is never downgraded here; so does a
    # deploy whose own segment does not carry the dev key.
    if deploy_is_dev_keyed(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "dev-deploy-key",
            "command": command[:200],
        })
        return 0

    # Laurent override -- always allow
    if has_laurent_override(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "laurent-direct-deploy",
            "command": command[:200],
        })
        return 0

    # Read-only escape (k174v3sw, Pi Day-111, #210): a read-only `convex run
    # --prod` query is not a deploy. Allow with an AUDITED # read-only-query:
    # marker -- SCOPED to convex-run only; a convex deploy / cloud-URL push /
    # env-set / api-mutation / api-action can NEVER bypass via this marker
    # (is_convex_run_only is False when a DEPLOY_PATTERNS surface matches).
    if is_convex_run_only(command) and has_readonly_marker(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "read-only-query-marker",
            "command": command[:200],
        })
        return 0

    # Pi-signed authorization check
    if not has_pi_authorization(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "block",
            "reason": "no-pi-authorization",
            "command": command[:200],
        })
        print(
            "BLOCKED: Convex prod deploy without Pi-signed authorization.\n"
            "\n"
            "For DEV: use `npx convex dev --once` (no prod guard applies), or deploy with an "
            "inline dev key (`CONVEX_DEPLOY_KEY=dev:... npx convex deploy`). "
            "The Pi token / QA evidence are required for PROD only.\n"
            "\n"
            "Day 82 standing rule (Laurent, mission k57a32vgtyy9x2gjqe456n6hhs87er7v):\n"
            "  Pi = fleet authority for prod deploys. System autonomous, not Laurent-dependent.\n"
            "\n"
            "Required order:\n"
            "  1. Orchestrator identifies prod deploy need\n"
            "  2. Pi creates VP task [PROD-DEPLOY-AUTHORIZED] with scope\n"
            "     (orchestrator + command pattern + repo/deployment)\n"
            "  3. Orchestrator executes command with task ID referenced\n"
            "\n"
            "To proceed (only after Pi task [PROD-DEPLOY-AUTHORIZED] created):\n"
            "  CANONICAL: npx convex deploy --yes # pi-authorized: k<task-id>\n"
            "\n"
            "  (The shell # comment is ignored by the convex CLI but read by the hook.\n"
            "  The old flag `--pi-authorized-task=k<id>` is rejected by the convex CLI as an\n"
            "  unknown flag, and the env-var prefix `PI_AUTHORIZED_TASK_ID=k<id>` does not always\n"
            "  propagate depending on the shell/subagent. Only the COMMENT format is reliable.)\n"
            "\n"
            "task-id = the VP task where Pi put [PROD-DEPLOY-AUTHORIZED] in the title for\n"
            "  this deploy. The hook fetches it: it must be under 60 minutes old (and, when\n"
            "  PI_AUTH_ORCHESTRATOR is set, assigned to that orchestrator).\n"
            "\n"
            "Exception (rare, Laurent-only): command contains `# laurent-direct-deploy`\n"
            "  -> allow (Laurent manual override always possible).\n"
            "\n"
            "Read-only exception (k174v3sw): a `convex run --prod` QUERY (not a deploy)\n"
            "  can be allowed via `# read-only-query: <reason>` (reason >= 3 chars).\n"
            "\n"
            "Audit trail: /tmp/pi-auth-prod-deploy.log\n",
            file=sys.stderr,
        )
        return 2

    # The marker is present. That proves its SPELLING, never its authority:
    # until this point an invented, expired or foreign task id passed. Fetch the
    # task and validate it. A fetch that fails is a could-not-judge, and a
    # could-not-judge is a REFUSAL, never an allow.
    task_id = extract_task_id(command)
    task = fetch_task(task_id) if task_id else None
    caller = caller_orchestrator()

    if not validate_task(task, caller):
        if task is None:
            reason = "task-unreadable-or-absent"
            detail = (
                "The authorization task could not be read. Either the id names no "
                "task, or VantagePeers could not be reached.\n"
                "\"I could not check\" and \"this is authorized\" are different answers."
            )
        else:
            reason = "task-invalid"
            detail = (
                "The task exists but does not authorize this deploy. It must carry "
                f"{PROD_DEPLOY_TAG} in its title or tags, have been created within "
                f"{TASK_TTL_SEC // 60} minutes, and -- when the caller is declared -- "
                "be assigned to that caller."
            )
        audit_log({
            "ts": int(time.time()),
            "verdict": "block",
            "reason": reason,
            "task_id": task_id,
            "caller": caller,
            "command": command[:200],
        })
        print(
            f"BLOCKED: the authorization token did not validate ({reason}).\n\n"
            f"{detail}\n\n"
            "A token is a task, not a string. Ask the merge authority for a fresh "
            "one rather than re-spelling this id.\n"
            "\n"
            "For DEV: use `npx convex dev --once` -- no token is needed there.\n"
            "\n"
            "Audit trail: /tmp/pi-auth-prod-deploy.log\n",
            file=sys.stderr,
        )
        return 2

    audit_log({
        "ts": int(time.time()),
        "verdict": "allow",
        "reason": "pi-authorized",
        "task_id": task_id,
        "caller": caller,
        "assignee_checked": caller is not None,
        "command": command[:200],
    })
    return 0


# ---------------------------------------------------------------------------
# Hook entrypoint (stdin dispatch -- skipped during testing)
# ---------------------------------------------------------------------------

def main(raw_stdin: str) -> int:
    """Decide on an already-read hook payload. Returns the exit code.

    Takes the stdin TEXT, never the stream: the failure handler below must be
    able to see the command. An earlier version re-read stdin inside the
    handler, got "" from the consumed stream, believed the command was empty
    and fell open on exactly the case it exists to close.
    """
    command = ""
    try:
        data = json.loads(raw_stdin or "{}")
        if data.get("tool_name", "") != "Bash":
            return 0
        command = data.get("tool_input", {}).get("command", "")
        if not command:
            return 0
        return run_hook(command)
    except Exception as e:
        # Fail-open is correct for a command that is NOT a prod action: a
        # parsing accident must never block ordinary work (malformed stdin
        # lands here with command == ""). It is wrong for one that IS, where an
        # exception would have become a silent authorization.
        try:
            dangerous = bool(command) and is_prod_deploy(command)
        except Exception:
            dangerous = bool(command)
        if dangerous:
            print(
                "BLOCKED: the authorization guard could not run on a production "
                f"deploy ({type(e).__name__}: {e}).\n"
                "Refusing rather than allowing: a guard that crashed has judged "
                "nothing.\n",
                file=sys.stderr,
            )
            return 2
        print(f"[hook warning] enforce-pi-authorization-before-prod-deploy: {e}", file=sys.stderr)
        return 0


if not globals().get("_TESTING"):
    # Read stdin ONCE, before any decision; main() only ever sees the text.
    try:
        _raw_stdin = sys.stdin.read()
    except Exception:
        _raw_stdin = ""
    sys.exit(main(_raw_stdin))
