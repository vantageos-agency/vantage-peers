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

When env var or flag present, the hook validates the referenced VP task via
Convex HTTP public API (no CLI auth required -- workspace-agnostic):
  - Task must have tag [PROD-DEPLOY-AUTHORIZED]
  - Task must have been created within the last 60 minutes (TTL)
  - Task must be assigned to the orchestrator running the command

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
no convex subcommand at all. Reading a table therefore required minting a
PROD-DEPLOY-AUTHORIZED token, which is exactly the over-blocking that gets a
guard commented out -- and a disarmed guard protects nothing (hook-vitality
bite-probe, BIPOLARITY). The fallback now requires the two words ADJACENT as
an ACTION (UNTOKENIZABLE_DEPLOY_RE), pinned-version suffix included, so a real
deploy hidden in an un-parsable segment still blocks while a variable NAME no
longer fires. Bipolar probe 24/24: MUST_PASS gained key-posed read, bare
export, dashboard resolution; every MUST_BLOCK case re-verified unchanged.

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
from _lib.command_predicate import (  # noqa: E402
    carries_action_signature,
    has_safe_flag,
    head_matches,
    iter_real_commands,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The deployment the tokens live on. Overridable so the could-not-judge path
# can be exercised against an unreachable address: pointing it elsewhere can
# only make the guard refuse, never allow.
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

# Fallback for a segment the tokenizer cannot parse (command substitution,
# unbalanced quoting). It must still fail closed on a REAL deploy hidden in
# there, without firing on prose or on a variable NAME. Two independent
# substring tests ("convex" somewhere AND "deploy" somewhere) cannot tell
# `npx convex deploy` from the environment variable CONVEX_DEPLOY_KEY, and
# refused every read that posed the production key -- a guard that blocks the
# legitimate gets disarmed, and then it guards nothing. The words must be
# ADJACENT as an action, with the optional pinned-version suffix the Convex
# docs use (`convex@latest deploy`) kept inside the adjacency.
UNTOKENIZABLE_DEPLOY_RE = re.compile(
    r"\bconvex(?:@[\w.\-]+)?\s+deploy\b", re.IGNORECASE
)


def _segment_is_deploy(tokens) -> bool:
    """True if `tokens` (already transparent-stripped by the shared
    tokenizer) is a genuine `convex deploy` invocation. Day 100 hardening
    (Omega flag) kept: BARE `convex deploy` (no `--prod` flag) is ALSO
    treated as a prod deploy -- Convex CLI resolves its target from
    CONVEX_DEPLOY_KEY / CONVEX_DEPLOYMENT env, so in fleet usage bare
    `deploy` routinely IS a prod deploy. `convex dev` is a DIFFERENT
    subcommand (`rest[0] == "deploy"` fails for it) -- no `--dev` flag
    lookahead is needed anymore now the tokenizer distinguishes the real
    subcommand instead of scanning for a substring."""
    if not head_matches(tokens, "convex"):
        return False
    rest = tokens[1:]
    if not rest or rest[0] != "deploy":
        return False
    if has_safe_flag(rest):
        return False  # --dry-run / --preview / --help / -h: inert
    return True


def _segment_is_run_prod(tokens) -> bool:
    """True if `tokens` is `convex run ... --prod` -- a READ-ONLY-eligible
    query surface (k174v3sw, Day-111), distinct from a deploy."""
    if not head_matches(tokens, "convex"):
        return False
    rest = tokens[1:]
    if not rest or rest[0] != "run":
        return False
    return "--prod" in rest


def _segment_is_env_set_prod(tokens) -> bool:
    """True if `tokens` is `convex env set ... --prod` -- mutates prod
    config/env state, never exemptable by the read-only marker."""
    if not head_matches(tokens, "convex"):
        return False
    rest = tokens[1:]
    if len(rest) < 2 or rest[0] != "env" or rest[1] != "set":
        return False
    return "--prod" in rest


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
    for segment, tokens in iter_real_commands(command):
        if URL_MUTATION_RE.search(segment) or URL_ACTION_RE.search(segment):
            return True
        if tokens is None:
            # Un-tokenizable segment: fail-closed ONLY if the raw text
            # plausibly names both a Convex binary and a deploy action --
            # otherwise fail-open (a parsing artifact must never manufacture
            # a block on an unrelated benign command).
            if UNTOKENIZABLE_DEPLOY_RE.search(segment):
                return True
            continue
        if (
            _segment_is_deploy(tokens)
            or _segment_is_run_prod(tokens)
            or _segment_is_env_set_prod(tokens)
        ):
            return True
        # FAIL-CLOSED on the UNKNOWN (Day 131, 8th round). The head is neither
        # a deploy nor a known READER, yet the argv still carries `convex
        # deploy` as two ADJACENT tokens: an unrecognised wrapper (`strace`,
        # `proxychains`, `systemd-run`, `parallel`, `runuser`, `su`, `at`, ...)
        # is executing a real deploy. We stopped enumerating wrappers (an OPEN
        # set -- seven rounds proved it) and now enumerate READERS (a CLOSED
        # set). `grep "convex deploy" f` still passes: the phrase is ONE quoted
        # token there, not two adjacent ones, AND `grep` is a declared reader.
        if carries_action_signature(tokens, "convex", "deploy"):
            print(
                "enforce-pi-authorization: WRAPPER NON RECONNU portant un "
                f"`convex deploy` -- tete `{tokens[0]}` inconnue: {segment!r}\n"
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


def is_convex_run_only(command: str) -> bool:
    """True if `command` is a `convex run --prod` and NOT a deploy / env-set
    / mutation / action / cloud-URL push.

    A read-only query run can be allowed via the # read-only-query marker; a
    deploy -- or a command that ALSO contains a deploy / mutation surface,
    anywhere in the shell line -- can never be. The deploy class always wins,
    so the marker cannot weaken the gate on a genuine mutation surface.
    """
    command = strip_heredocs(command)
    is_run = False
    is_deploy_class = False
    for segment, tokens in iter_real_commands(command):
        if URL_MUTATION_RE.search(segment) or URL_ACTION_RE.search(segment):
            is_deploy_class = True
            continue
        if tokens is None:
            continue
        if _segment_is_deploy(tokens) or _segment_is_env_set_prod(tokens):
            is_deploy_class = True
        elif _segment_is_run_prod(tokens):
            is_run = True
    return is_run and not is_deploy_class


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

    Fast-path: does NOT validate the task against VP (that happens in
    validate_task()). This is intentional -- override mechanisms are
    already gated by the task creation workflow.
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

def validate_task(task: dict | None, orchestrator: str) -> bool:
    """Validate a Pi-authorization task against required criteria.

    Criteria:
      1. Task must not be None (fetch succeeded)
      2. Task must have [PROD-DEPLOY-AUTHORIZED] tag
      3. Task must have been created within TASK_TTL_SEC (60 min)
      4. Task must be assigned to the requesting orchestrator

    Returns True if all criteria pass, False otherwise.
    """
    if task is None:
        return False

    # The marker lives in the TITLE on every token actually issued; `tags` is
    # null on all of them. Checking only `tags` rejects every genuine token,
    # which is why wiring this function unchanged would have frozen the fleet.
    tags = task.get("tags") or []
    title = task.get("title") or ""
    if PROD_DEPLOY_TAG not in tags and PROD_DEPLOY_TAG not in title:
        return False

    created_ms = task.get("createdAt", 0)
    created_sec = created_ms / 1000
    if (time.time() - created_sec) > TASK_TTL_SEC:
        return False

    # The assignee check runs only when the caller is KNOWN. Station identity is
    # not reliably derivable today: an orchestrator routinely works in a
    # directory whose own CLAUDE.md names a different orchestrator, so deriving
    # identity from the path would assert the wrong caller — worse than
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
            "task-id = the VP task where Pi tagged [PROD-DEPLOY-AUTHORIZED] for this deploy.\n"
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
                f"{TASK_TTL_SEC // 60} minutes, and — when the caller is declared — "
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

if not globals().get("_TESTING"):
    # Read stdin ONCE, before the try. The failure handler cannot re-read it:
    # a consumed stream returns "", which made the handler believe the command
    # was empty and fall open on exactly the case it exists to close.
    command = ""
    try:
        raw_stdin = sys.stdin.read()
    except Exception:
        raw_stdin = ""
    try:
        data = json.loads(raw_stdin or "{}")
        tool_name = data.get("tool_name", "")
        if tool_name != "Bash":
            sys.exit(0)

        command = data.get("tool_input", {}).get("command", "")
        if not command:
            sys.exit(0)

        sys.exit(run_hook(command))

    except Exception as e:
        # Fail-open is correct for a command that is NOT a production deploy: a
        # parsing accident must never block ordinary work. It is wrong for one
        # that IS, where an exception would have become a silent authorization.
        try:
            dangerous = bool(command) and is_prod_deploy(command)
        except Exception:
            dangerous = bool(command)
        if dangerous:
            print(
                "BLOCKED: the authorization guard could not run on a production "
                f"deploy ({e}).\n"
                "Refusing rather than allowing: a guard that crashed has judged "
                "nothing.\n",
                file=sys.stderr,
            )
            sys.exit(2)
        print(f"[hook warning] enforce-pi-authorization-before-prod-deploy: {e}", file=sys.stderr)
        sys.exit(0)
