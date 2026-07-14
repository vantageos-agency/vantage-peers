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
    carries_prod_action,
    head_prod_action,
    iter_real_commands,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VP_CONVEX_URL = "https://compassionate-goldfinch-737.convex.cloud"
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
            # plausibly names a Convex binary AND a prod-mutating surface --
            # otherwise fail-open (a parsing artifact must never manufacture
            # a block on an unrelated benign command).
            low = segment.lower()
            if "convex" in low and ("deploy" in low or "--prod" in low):
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

    tags = task.get("tags") or []
    if PROD_DEPLOY_TAG not in tags:
        return False

    created_ms = task.get("createdAt", 0)
    created_sec = created_ms / 1000
    if (time.time() - created_sec) > TASK_TTL_SEC:
        return False

    if task.get("assignedTo") != orchestrator:
        return False

    return True


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
            "  (Le commentaire shell # est ignoré par convex CLI mais lu par le hook.\n"
            "  Day 101 friction Omega — l'ancien flag `--pi-authorized-task=k<id>` est rejeté\n"
            "  par convex CLI comme flag inconnu, et le préfixe env var `PI_AUTHORIZED_TASK_ID=k<id>`\n"
            "  ne propage pas toujours selon le shell/subagent. Seul le format COMMENT est fiable.)\n"
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

    # Authorized -- log and allow
    task_id = extract_task_id(command)
    audit_log({
        "ts": int(time.time()),
        "verdict": "allow",
        "reason": "pi-authorized",
        "task_id": task_id,
        "command": command[:200],
    })
    return 0


# ---------------------------------------------------------------------------
# Hook entrypoint (stdin dispatch -- skipped during testing)
# ---------------------------------------------------------------------------

if not globals().get("_TESTING"):
    try:
        data = json.load(sys.stdin)
        tool_name = data.get("tool_name", "")
        if tool_name != "Bash":
            sys.exit(0)

        command = data.get("tool_input", {}).get("command", "")
        if not command:
            sys.exit(0)

        sys.exit(run_hook(command))

    except Exception as e:
        # Fail-open on any unexpected error to avoid blocking legitimate work
        print(f"[hook warning] enforce-pi-authorization-before-prod-deploy: {e}", file=sys.stderr)
        sys.exit(0)
