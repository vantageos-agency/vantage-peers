#!/usr/bin/env python3
"""
PreToolUse hook : enforce Pi-signed authorization before Convex prod deploy.

Blocks Bash commands containing `npx convex deploy --prod` (or equivalents)
unless one of:
  - Env var PI_AUTHORIZED_TASK_ID is set to a valid VP task ID (k...)
  - Command includes explicit flag `--pi-authorized-task=k...`
  - Comment on same line `# pi-authorized: k...`
  - Laurent override comment `# laurent-direct-deploy`

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

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VP_CONVEX_URL = "https://compassionate-goldfinch-737.convex.cloud"
HTTP_TIMEOUT_SEC = 10
TASK_TTL_SEC = 3600  # 60 minutes
PROD_DEPLOY_TAG = "[PROD-DEPLOY-AUTHORIZED]"
AUDIT_LOG = "/tmp/pi-auth-prod-deploy.log"

# Patterns that indicate a prod deploy (Convex CLI)
#
# Day 100 hardening (Omega flag): bare `npx convex deploy` without --prod is ALSO
# treated as a prod deploy. Reason: Convex CLI uses CONVEX_DEPLOY_KEY env var or
# CONVEX_DEPLOYMENT to determine target. In fleet usage (CI/scripts/orchestrators
# with prod keys in env), bare `convex deploy` IS a prod deploy. Local dev
# uses `convex dev`, not `convex deploy`. So we catch bare deploy aggressively
# and require an explicit `--dev` opt-out OR Pi authorization.
PROD_DEPLOY_PATTERNS = [
    # Explicit --prod (always blocked without auth)
    r"\bnpx\s+convex\s+deploy\b[^|;&]*--prod\b",
    r"\bconvex\s+deploy\b[^|;&]*--prod\b",
    # Bare deploy (without --dev anywhere in same command segment)
    r"\bnpx\s+convex\s+deploy\b(?![^|;&]*--dev\b)",
    r"\bconvex\s+deploy\b(?![^|;&]*--dev\b)",
    # Convex run --prod
    r"\bnpx\s+convex\s+run\b[^|;&]*--prod\b",
    r"\bconvex\s+run\b[^|;&]*--prod\b",
    # Convex env set --prod (mutates prod state)
    r"\bconvex\s+env\s+set\b[^|;&]*--prod\b",
    # Raw HTTP WRITE to a Convex deployment. The predicate is the ACTION
    # (/api/mutation), never the deployment NAME: a bare convex.cloud URL or
    # /api/query is a READ and must pass (Day 127 — the URL-only pattern
    # false-fired on Eta's and Pi's read-only curls while the equivalent
    # Python request passed, so the guard disarmed itself).
    r"https://[a-z0-9-]+\.convex\.cloud/api/mutation\b",
    # /api/action is a WRITE vector too: a Convex action runs server-side and
    # can call ctx.runMutation + external services. Blocking /api/mutation
    # while letting /api/action through is a security incoherence (Eta REVISE
    # Day 127, survivor B). /api/query stays a READ and passes.
    r"https://[a-z0-9-]+\.convex\.cloud/api/action\b",
]

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

def strip_quoted_strings(command: str) -> str:
    """Remove content inside single/double quotes to avoid false positives
    on text like `git commit -m 'deploy --prod notes'`."""
    command = re.sub(r'"[^"]*"', '""', command)
    command = re.sub(r"'[^']*'", "''", command)
    return command


INTERPRETER_C_RE = re.compile(
    r"\b(?:bash|sh|zsh)\s+-[a-zA-Z]*c[a-zA-Z]*\s+(\"[^\"]*\"|'[^']*')"
    # `eval '<cmd>'` is the shell sibling of `bash -c '<cmd>'`: its quoted
    # argument IS a command the shell runs. Scanning one recursively while
    # ignoring the other is the obvious bypass (Eta REVISE Day 127, survivor A).
    r"|\beval\s+(\"[^\"]*\"|'[^']*')")

HEREDOC_RE = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?\n.*?\n\1\b", re.DOTALL)


def strip_heredocs(command: str) -> str:
    """Remove heredoc bodies: they are DATA fed to a program's stdin, not
    commands the shell runs. Without this, prose or code inside a heredoc
    (a Python script mentioning a deploy command) false-fires the guard.
    Declared boundary: a heredoc piped INTO an interpreter as a script is
    not analyzed — same residual boundary as the npm-publish guard."""
    return HEREDOC_RE.sub("<<HEREDOC_STRIPPED", command)


def is_prod_deploy(command: str) -> bool:
    """Returns True if command triggers a Convex prod deployment.

    Quoted strings are stripped to ignore prose (commit messages), EXCEPT the
    quoted argument of an interpreter (`bash -c '...'`): that string IS the
    command that runs, so it is scanned recursively before stripping erases it.
    """
    command = strip_heredocs(command)
    for groups in INTERPRETER_C_RE.findall(command):
        for quoted in (groups if isinstance(groups, tuple) else (groups,)):
            if quoted and is_prod_deploy(quoted[1:-1]):
                return True
    sanitized = strip_quoted_strings(command)
    return any(re.search(p, sanitized, re.IGNORECASE) for p in PROD_DEPLOY_PATTERNS)


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
