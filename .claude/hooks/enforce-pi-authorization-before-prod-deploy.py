#!/usr/bin/env python3
"""
PreToolUse hook: enforce Pi AUTHORIZED verdict before production Convex deploy.

v1.0.2 — Day 82 fix (2026-05-26): env-var inline prefix parsing.

Blocks Bash commands that trigger a production Convex deploy unless one of:
  - Env-var inline prefix in command string: PI_AUTHORIZED_TASK_ID=k<31> <command>
  - Env var PI_AUTHORIZED_TASK_ID is set to a valid VP task ID (k<32-chars>)
  - Command includes explicit flag `--pi-authorized-task=k<32-chars>`
  - Comment on same line `# pi-authorized: k<32-chars>`

v1.0.1 bug: the env-var path read os.environ of the hook's own process.
When Claude runs `PI_AUTHORIZED_TASK_ID=k... npx convex deploy --prod` the
variable is set only in the Bash subshell — not exported to the hook's env.
v1.0.2 fix: parse the env-var prefix directly from the command string with
regex `^(?:[A-Z_]+=\\S+\\s+)*PI_AUTHORIZED_TASK_ID=(k[a-z0-9]{31})\\s+` BEFORE
falling back to os.environ (which still covers the rare case of a genuinely
exported shell var).

Pi doctrine Day 82: Pi is fleet authority for prod deploys.
VantageRegistry mission: pi-autonomous-prod-deploy-authorization-v1
  (k57a32vgtyy9x2gjqe456n6hhs87er7v)

Trigger patterns (after strip_quoted_strings):
  - npx convex deploy --prod (+ --yes/-y variants)
  - npx convex run <fn> --prod
  - convex deploy --prod (direct, no npx)
  - Any command with --url https://<name>.convex.cloud (prod URL match)

Bypass (rare Laurent override):
  - Command contains literal `# laurent-direct-deploy` → allow unconditionally

Task validation (all must pass):
  - Format: ^k[a-z0-9]{32}$
  - Exists in VantageMemory VP backend
  - title contains [PROD-DEPLOY-AUTHORIZED] OR tags includes prod-deploy-authorized
  - createdAt within 60 minutes of now
  - assignedTo matches inferred current orchestrator

Override discipline: PI_AUTHORIZED_TASK_ID is one-shot. Set, run once, unset.
Never persist in shell rc. Never share across deploys.

Test mock: set PI_AUTH_HOOK_TEST_MOCK_TASK=<JSON> + run with --self-test to skip
subprocess and use the mock task object directly.

Audit log: on allow, append JSON line to /tmp/pi-auth-prod-deploy.log

Exit 0 = allow
Exit 2 = block
"""
import json
import os
import re
import subprocess
import sys
import socket
from datetime import datetime, timezone

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

VERSION = "1.0.2"

VP_CONVEX_URL = "https://vibrant-ibex-858.convex.cloud"
AUDIT_LOG = "/tmp/pi-auth-prod-deploy.log"
TASK_MAX_AGE_MS = 3_600_000  # 60 minutes in milliseconds

# Task ID format: k followed by exactly 31 lowercase alphanumeric chars (32 total)
TASK_ID_RE = re.compile(r"^k[a-z0-9]{31}$")

# Inline accept patterns (same format, embedded in command text)
INLINE_TASK_RE = re.compile(r"k[a-z0-9]{31}")

# v1.0.2: env-var inline prefix — matches `PI_AUTHORIZED_TASK_ID=k<31> ...`
# at the start of a shell command, optionally preceded by other VAR=value pairs.
# Regex: optional leading VAR=value assignments, then PI_AUTHORIZED_TASK_ID=k<31>
ENV_PREFIX_RE = re.compile(
    r"^(?:[A-Z_]+=\S+\s+)*PI_AUTHORIZED_TASK_ID=(k[a-z0-9]{31})\s+"
)


# ─────────────────────────────────────────────────────────────────────────────
# strip_quoted_strings — verbatim from enforce-eta-approval-before-npm-publish
# Day 79 v1.0.1 fix §B from sigma — prevents false positives inside commit
# messages or strings like: git commit -m "deploy with convex deploy --prod"
# ─────────────────────────────────────────────────────────────────────────────
def strip_quoted_strings(command: str) -> str:
    """Remove content inside single/double quotes to avoid false positives
    on text like `git commit -m "docs about convex deploy --prod"`.
    Day 79 v1.0.1 fix §B from sigma — original regex matched deploy patterns
    inside commit message strings, blocking legitimate `git commit` calls."""
    # Remove "..." (double-quoted)
    command = re.sub(r'"[^"]*"', '""', command)
    # Remove '...' (single-quoted)
    command = re.sub(r"'[^']*'", "''", command)
    return command


# ─────────────────────────────────────────────────────────────────────────────
# Orchestrator inference
# ─────────────────────────────────────────────────────────────────────────────
def infer_orchestrator() -> str:
    """Infer the current orchestrator role from hostname or workspace path.
    Heuristic: check hostname and CWD for known workspace/role indicators."""
    hostname = socket.gethostname().lower()
    cwd = os.getcwd().lower()

    workspace_map = {
        "omega": ["omega", "vantage-registry"],
        "sigma": ["sigma", "sigma-workspace"],
        "eta": ["eta", "eta-workspace"],
        "zeta": ["zeta", "zeta-workspace"],
        "beta": ["beta", "beta-workspace"],
        "pi": ["pi", "pi-workspace"],
    }

    for role, keywords in workspace_map.items():
        for kw in keywords:
            if kw in hostname or kw in cwd:
                return role

    return "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# Production deploy detection
# ─────────────────────────────────────────────────────────────────────────────
PROD_DEPLOY_PATTERNS = [
    # npx convex deploy --prod (with optional --yes/-y)
    re.compile(r"\bnpx\s+convex\s+deploy\b.*--prod\b"),
    # convex deploy --prod (direct, no npx)
    re.compile(r"(?<!\S)convex\s+deploy\b.*--prod\b"),
    # npx convex run <fn> --prod
    re.compile(r"\bnpx\s+convex\s+run\b.*--prod\b"),
    # --url with a .convex.cloud prod URL
    re.compile(r"--url\s+https://[a-z][a-z0-9-]*-[a-z][a-z0-9-]*-\d+\.convex\.cloud"),
]


def is_prod_deploy(command: str) -> bool:
    """Returns True if command targets a production Convex deployment.
    Strips quoted string content first to avoid false positives."""
    sanitized = strip_quoted_strings(command)
    return any(p.search(sanitized) for p in PROD_DEPLOY_PATTERNS)


# ─────────────────────────────────────────────────────────────────────────────
# Laurent direct bypass
# ─────────────────────────────────────────────────────────────────────────────
def has_laurent_override(command: str) -> bool:
    """Allow if the raw command (not stripped) contains the literal bypass marker."""
    return "# laurent-direct-deploy" in command


# ─────────────────────────────────────────────────────────────────────────────
# Authorization token extraction
# ─────────────────────────────────────────────────────────────────────────────
def extract_pi_task_id(command: str) -> tuple[str, str]:
    """Return (task_id, source) from command env-prefix, os.environ, flag, or comment.
    Returns ('', '') if none found.

    v1.0.2: env-prefix form is checked FIRST. When Claude runs:
        PI_AUTHORIZED_TASK_ID=k<31> npx convex deploy --prod
    the shell sets PI_AUTHORIZED_TASK_ID only in the Bash subshell, not in the
    hook's own os.environ. We parse it directly from the command string instead.
    """
    # 1. Env-var inline prefix in command string (v1.0.2 fix)
    #    Handles: PI_AUTHORIZED_TASK_ID=k<31> <deploy command>
    #    Also:   OTHER_VAR=x PI_AUTHORIZED_TASK_ID=k<31> <deploy command>
    m = ENV_PREFIX_RE.match(command.lstrip())
    if m:
        return m.group(1), "env-prefix:PI_AUTHORIZED_TASK_ID"

    # 2. Env var genuinely exported in parent process (rare — requires `export`)
    env_task = os.environ.get("PI_AUTHORIZED_TASK_ID", "").strip()
    if env_task:
        return env_task, "env:PI_AUTHORIZED_TASK_ID"

    # 3. Inline flag --pi-authorized-task=k<31>
    m = re.search(r"--pi-authorized-task=(k[a-z0-9]{31})\b", command)
    if m:
        return m.group(1), "flag:--pi-authorized-task"

    # 4. Inline comment # pi-authorized: k<31>
    m = re.search(r"#\s*pi-authorized:\s*(k[a-z0-9]{31})\b", command)
    if m:
        return m.group(1), "comment:pi-authorized"

    return "", ""


# ─────────────────────────────────────────────────────────────────────────────
# Task validation via VP Convex backend
# ─────────────────────────────────────────────────────────────────────────────
def fetch_task(task_id: str, mock_json: str | None) -> dict | None:
    """Fetch task from VP. Returns parsed task dict or None on failure.
    If mock_json is provided, parse and return that instead (test mode only)."""
    if mock_json:
        try:
            return json.loads(mock_json)
        except Exception:
            return None

    # Real fetch via npx convex run against VantageMemory backend
    # tasks:get expects { taskId: "<id>" }
    cmd = [
        "npx", "convex", "run", "tasks:get",
        "--url", VP_CONVEX_URL,
        "--no-push",
        json.dumps({"taskId": task_id}),
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
        output = result.stdout.strip()
        if not output or output == "null":
            return None
        return json.loads(output)
    except Exception:
        return None


def validate_task(task_id: str, mock_json: str | None) -> tuple[bool, str]:
    """Validate task_id. Returns (allowed, reason).
    Fails closed on any fetch/parse error."""
    # 1. Format check
    if not TASK_ID_RE.match(task_id):
        return False, f"invalid taskId format '{task_id}' — expected k[a-z0-9]{{32}}"

    # 2. Fetch task
    task = fetch_task(task_id, mock_json)
    if task is None:
        return False, f"task '{task_id}' not found or fetch failed (fail closed)"

    # 3. Title or tags check
    title = task.get("title", "") or ""
    tags = task.get("tags") or []
    if "[PROD-DEPLOY-AUTHORIZED]" not in title and "prod-deploy-authorized" not in tags:
        return False, (
            f"task '{task_id}' is not a prod-deploy authorization — "
            "title must contain [PROD-DEPLOY-AUTHORIZED] or tags must include prod-deploy-authorized"
        )

    # 4. Age check (createdAt within 60 minutes)
    created_at = task.get("createdAt") or task.get("_creationTime")
    if not isinstance(created_at, (int, float)):
        return False, f"task '{task_id}' missing createdAt field (fail closed)"
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    age_ms = now_ms - created_at
    if age_ms > TASK_MAX_AGE_MS:
        age_min = int(age_ms / 60_000)
        return False, (
            f"task '{task_id}' is {age_min} min old — "
            "authorization window is 60 min, create a fresh task"
        )

    # 5. AssignedTo matches current orchestrator
    assigned_to = (task.get("assignedTo") or "").lower()
    orchestrator = infer_orchestrator()
    if orchestrator != "unknown" and assigned_to and assigned_to != orchestrator:
        return False, (
            f"task '{task_id}' is assigned to '{assigned_to}' "
            f"but current orchestrator is '{orchestrator}' — wrong authorization"
        )

    return True, "ok"


# ─────────────────────────────────────────────────────────────────────────────
# Audit log
# ─────────────────────────────────────────────────────────────────────────────
def write_audit(command: str, task_id: str, orchestrator: str, allowed: bool) -> None:
    """Append a JSON audit line to AUDIT_LOG. Fail silently."""
    try:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "command": command[:200],
            "taskId": task_id,
            "orchestrator": orchestrator,
            "allowed": allowed,
        }
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Block message
# ─────────────────────────────────────────────────────────────────────────────
def block_message(reason: str, command: str) -> str:
    orchestrator = infer_orchestrator()
    # Summarize command for the remediation hint
    cmd_summary = command.strip()[:80].replace("\n", " ")
    return (
        "BLOCKED: Pi authorization required for production Convex deploy.\n"
        "\n"
        f"Reason: {reason}\n"
        "\n"
        "Day 82 doctrine: Pi is fleet authority for production deploys.\n"
        "No prod deploy may proceed without a fresh Pi-authorized VP task.\n"
        "\n"
        "To get authorized:\n"
        f"  Pi: create_task title='[PROD-DEPLOY-AUTHORIZED] {cmd_summary}'\n"
        f"      assignedTo={orchestrator} tags=['prod-deploy-authorized']\n"
        "\n"
        "Then re-run with:\n"
        "  Option A (env var):   PI_AUTHORIZED_TASK_ID=k<taskId> <command>\n"
        "  Option B (flag):      <command> --pi-authorized-task=k<taskId>\n"
        "  Option C (comment):   <command> # pi-authorized: k<taskId>\n"
        "\n"
        "Laurent override (rare): append `# laurent-direct-deploy` to the command.\n"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Self-test mode
# ─────────────────────────────────────────────────────────────────────────────
def run_self_tests() -> None:
    """Run 13 test cases covering all 4 authorization forms + invalid forms.
    Print PASS/FAIL per case. Exit 0 if all pass, 1 otherwise."""
    import time

    now_ms = int(time.time() * 1000)
    fresh_created_at = now_ms - 300_000   # 5 min ago — valid
    stale_created_at = now_ms - 7_200_000  # 2h ago — expired
    task_id = "k" + "a" * 31

    valid_task_json = json.dumps({
        "_id": task_id,
        "title": "[PROD-DEPLOY-AUTHORIZED] deploy vantage-registry",
        "tags": ["prod-deploy-authorized"],
        "assignedTo": "omega",
        "createdAt": fresh_created_at,
        "_creationTime": fresh_created_at,
    })

    stale_task_json = json.dumps({
        "_id": task_id,
        "title": "[PROD-DEPLOY-AUTHORIZED] deploy vantage-registry",
        "tags": ["prod-deploy-authorized"],
        "assignedTo": "omega",
        "createdAt": stale_created_at,
        "_creationTime": stale_created_at,
    })

    def check_is_prod(cmd: str) -> bool:
        return is_prod_deploy(cmd)

    def check_laurent(cmd: str) -> bool:
        return has_laurent_override(cmd)

    def check_auth(cmd: str, task_json: str | None = None) -> tuple[bool, str]:
        task_id_found, _src = extract_pi_task_id(cmd)
        if not task_id_found:
            return False, "no authorization token found"
        return validate_task(task_id_found, task_json)

    tests = []

    # ── Form 1: env-var inline prefix in command string (v1.0.2 fix) ─────────

    # T1: PI_AUTHORIZED_TASK_ID=k<31> npx convex deploy --prod → env-prefix parsed
    os.environ.pop("PI_AUTHORIZED_TASK_ID", None)
    cmd = f"PI_AUTHORIZED_TASK_ID={task_id} npx convex deploy --prod"
    tid, src = extract_pi_task_id(cmd)
    tests.append(("T1: env-prefix parse extracts taskId", tid == task_id and src == "env-prefix:PI_AUTHORIZED_TASK_ID"))

    # T2: env-prefix form + valid mock → allow end-to-end
    cmd = f"PI_AUTHORIZED_TASK_ID={task_id} npx convex deploy --prod"
    is_prod = check_is_prod(cmd)
    allowed, reason = check_auth(cmd, valid_task_json)
    tests.append(("T2: env-prefix + valid task → ALLOW", is_prod and allowed))

    # T3: env-prefix form + OTHER_VAR prefix + valid mock → allow (multi-var prefix)
    cmd = f"SOME_OTHER=x PI_AUTHORIZED_TASK_ID={task_id} npx convex deploy --prod"
    tid, src = extract_pi_task_id(cmd)
    tests.append(("T3: multi-var env-prefix parse extracts taskId", tid == task_id and src == "env-prefix:PI_AUTHORIZED_TASK_ID"))

    # T4: env-prefix form but stale task → block
    cmd = f"PI_AUTHORIZED_TASK_ID={task_id} npx convex deploy --prod"
    is_prod = check_is_prod(cmd)
    allowed, reason = check_auth(cmd, stale_task_json)
    tests.append(("T4: env-prefix + stale task → BLOCK", is_prod and not allowed))

    # ── Form 2: os.environ (exported var) ────────────────────────────────────

    # T5: exported PI_AUTHORIZED_TASK_ID + valid mock → allow
    os.environ["PI_AUTHORIZED_TASK_ID"] = task_id
    cmd = "npx convex deploy --prod"
    is_prod = check_is_prod(cmd)
    allowed, reason = check_auth(cmd, valid_task_json)
    tests.append(("T5: exported env var + valid task → ALLOW", is_prod and allowed))
    os.environ.pop("PI_AUTHORIZED_TASK_ID", None)

    # T6: exported env var + stale task → block
    os.environ["PI_AUTHORIZED_TASK_ID"] = task_id
    cmd = "npx convex deploy --prod"
    allowed, reason = check_auth(cmd, stale_task_json)
    tests.append(("T6: exported env var + stale task → BLOCK", not allowed))
    os.environ.pop("PI_AUTHORIZED_TASK_ID", None)

    # ── Form 3: inline flag ───────────────────────────────────────────────────

    # T7: --pi-authorized-task=k<31> flag + valid mock → allow
    os.environ.pop("PI_AUTHORIZED_TASK_ID", None)
    cmd = f"npx convex deploy --prod --pi-authorized-task={task_id}"
    is_prod = check_is_prod(cmd)
    allowed, reason = check_auth(cmd, valid_task_json)
    tests.append(("T7: flag auth + valid task → ALLOW", is_prod and allowed))

    # ── Form 4: inline comment ────────────────────────────────────────────────

    # T8: # pi-authorized: k<31> comment + valid mock → allow
    cmd = f"npx convex run somefunc --prod # pi-authorized: {task_id}"
    is_prod = check_is_prod(cmd)
    allowed, reason = check_auth(cmd, valid_task_json)
    tests.append(("T8: comment auth + valid task → ALLOW", is_prod and allowed))

    # ── Invalid / no-auth cases ───────────────────────────────────────────────

    # T9: prod deploy, no auth of any kind → block
    os.environ.pop("PI_AUTHORIZED_TASK_ID", None)
    cmd = "npx convex deploy --prod"
    is_prod = check_is_prod(cmd)
    allowed, _reason = check_auth(cmd)
    tests.append(("T9: prod deploy no auth → BLOCK", is_prod and not allowed))

    # T10: env-prefix with invalid task ID format → extract fails (empty)
    cmd = "PI_AUTHORIZED_TASK_ID=invalid npx convex deploy --prod"
    tid, src = extract_pi_task_id(cmd)
    tests.append(("T10: invalid task ID format in env-prefix → not extracted", tid == ""))

    # ── Passthrough / bypass cases ────────────────────────────────────────────

    # T11: npm install → not a prod deploy, passthrough
    cmd = "npm install"
    tests.append(("T11: npm install → NOT prod deploy (passthrough)", not check_is_prod(cmd)))

    # T12: git commit with deploy in string → not a prod deploy (strip_quoted_strings)
    cmd = 'git commit -m "doc about convex deploy --prod"'
    tests.append(("T12: git commit with deploy in string → NOT prod deploy", not check_is_prod(cmd)))

    # T13: convex deploy --prod # laurent-direct-deploy → laurent bypass
    cmd = "npx convex deploy --prod # laurent-direct-deploy"
    tests.append(("T13: laurent-direct-deploy override → ALLOW", check_is_prod(cmd) and check_laurent(cmd)))

    passed = 0
    for name, ok in tests:
        status = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        print(f"  [{status}] {name}")

    total = len(tests)
    print(f"\n{passed}/{total} PASS")
    sys.exit(0 if passed == total else 1)


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
def main() -> None:
    # Self-test mode
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        run_self_tests()
        return

    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = data.get("tool_name", "") or ""
    if tool_name != "Bash":
        sys.exit(0)

    command = (data.get("tool_input") or {}).get("command", "") or ""
    if not command:
        sys.exit(0)

    # Not a prod deploy — passthrough
    if not is_prod_deploy(command):
        sys.exit(0)

    # Laurent direct override — allow unconditionally
    if has_laurent_override(command):
        orchestrator = infer_orchestrator()
        write_audit(command, "laurent-direct-deploy", orchestrator, True)
        sys.exit(0)

    # Extract authorization token
    task_id, source = extract_pi_task_id(command)
    orchestrator = infer_orchestrator()

    if not task_id:
        print(block_message("no authorization token found in env var, flag, or comment", command),
              file=sys.stderr)
        sys.exit(2)

    # Get test mock if present (only used when PI_AUTH_HOOK_TEST_MOCK_TASK is set)
    mock_json = os.environ.get("PI_AUTH_HOOK_TEST_MOCK_TASK") or None

    # Validate the task
    allowed, reason = validate_task(task_id, mock_json)

    if allowed:
        write_audit(command, task_id, orchestrator, True)
        sys.exit(0)

    print(block_message(reason, command), file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Fail closed: unexpected errors block the deploy, never allow silently.
        print(
            f"BLOCKED: enforce-pi-authorization-before-prod-deploy v{VERSION} internal error (fail closed): {e}\n"
            "Fix the hook or use `# laurent-direct-deploy` for an emergency bypass.",
            file=sys.stderr,
        )
        sys.exit(2)
