#!/usr/bin/env python3
"""
PreToolUse hook : enforce Pi-signed authorization before PR merge / push to main
of client-facing fleet repos.

Blocks Bash commands containing `gh pr merge` or `git push origin main` (or
equivalents) for fleet client-facing repos unless one of:
  - Env var PI_AUTHORIZED_MERGE_TASK_ID is set to a valid VP task ID (k...)
  - Command includes explicit flag `--pi-authorized-merge=k...`
  - Comment on same line `# pi-authorized-merge: k...`
  - Laurent override comment `# laurent-direct-merge`

Reason: Day 87 incident (2026-05-29) — Athena PR #7 + CLAUDE.md fork-residue
commit — auto-mode classifier bloqué Athena sur "Pi GO MERGE" indirect via
send_message. Pi a proposé "attendre Laurent direct merge" → Laurent corrige :
"on construit un système autonome / le système ne doit pas dépendre de moi!"

Pattern extension Day 82 PI-SIGNED PROD DEPLOY AUTHORIZATION applied to merge :
Pi devient autorité fleet pour merges client-facing (déjà 2nd reviewer fleet,
devient aussi authority merge).

Standing rule canonique: memory j577xjby0mncv7wpx4ewjz4n5s87nbcw (global/feedback)
extends Day 82 doctrine (j57bkwc99fnwp348m52d9rw5p987ggq6 + mission k57a32vgtyy9x2gjqe456n6hhs87er7v).

Override discipline: PI_AUTHORIZED_MERGE_TASK_ID is meant for one-shot pre-validated
merge. Set, run gh pr merge once, unset. Never persist in shell rc.

Audit trail: /tmp/pi-auth-pr-merge.log (append-only per call).

Exit 0 = allow
Exit 2 = block
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# Patterns that indicate client-facing fleet repo merge
# Hors scope: Pi-workspace internes (CLAUDE.md, .claude/), docs-only PRs
FLEET_CLIENT_FACING_REPOS = [
    r"\belpiarthera/gptpowerups-extension\b",  # chi
    r"\belpiarthera/vantage-peers-extension\b",  # hermes
    r"\belpiarthera/vantage-crm-extension\b",  # athena
    r"\belpiarthera/vantage-gmail-addon\b",  # demeter
    r"\belpiarthera/vantage-peers-dashboard\b",  # sigma (kappa BU)
    r"\belpiarthera/vantage-bridge\b",  # mu
    r"\bvantageos-agency/vantage-peers\b",  # sigma BU
    r"\belpiarthera/vantage-registry\b",  # omega
    r"\belpiarthera/gptpowerups-backend\b",  # iota
    r"\belpiarthera/gptpowerups-site\b",  # psi
    r"\belpiarthera/vantageos-crm\b",  # theta
]

# Commands that trigger fleet merge
MERGE_CMD_PATTERNS = [
    r"\bgh\s+pr\s+merge\b",  # GitHub CLI PR merge
    r"\bgit\s+push\s+origin\s+main\b",  # direct push main
    r"\bgit\s+push\s+.*\bmain\b",  # push variant main
]

# Override token (Pi PR-MERGE-AUTHORIZED task ID, format k... — Convex IDs)
APPROVED_TASK_RE = re.compile(r"\bk[a-z0-9]{15,40}\b")

# Audit log path
AUDIT_LOG = "/tmp/pi-auth-pr-merge.log"


def strip_quoted_strings(command: str) -> str:
    """Remove content inside single/double quotes to avoid false positives
    on text like `git commit -m "merge main into feature"`."""
    command = re.sub(r'"[^"]*"', '""', command)
    command = re.sub(r"'[^']*'", "''", command)
    return command


def _command_cwd(command: str) -> str:
    """Working directory the command will run in: a leading `cd <path> &&`
    prefix wins, else the hook process cwd (inherited from the tool call)."""
    match = re.match(r"\s*cd\s+(['\"]?)([^'\"&;|]+)\1\s*&&", command)
    if match:
        return match.group(2).strip()
    return os.getcwd()


def _remote_repo(cwd: str) -> str | None:
    """Derive the target repo from the git remote of the command's cwd —
    the only source of truth for where a merge lands (derive-never-type).
    Returns None when unreadable."""
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def is_fleet_merge(command: str) -> bool:
    """Returns True if command is a merge/push targeting a fleet client-facing repo.
    Day 130 fail-open closed: `gh pr merge N` from a checkout names no repo —
    gh derives it from the git remote, so the gate must derive it the same way.
    A PWD path pattern never matches an org/repo and guarded nothing.
    Fail-closed: a merge whose target repo cannot be established is refused."""
    sanitized = strip_quoted_strings(command)
    cmd_lower = sanitized.lower()

    has_merge = any(re.search(p, cmd_lower) for p in MERGE_CMD_PATTERNS)
    if not has_merge:
        return False

    # Help/dry invocations act on nothing — never gate them (a false positive
    # on --help teaches operators to bypass, and a bypassed guard guards nothing).
    if re.search(r"(^|\s)(--help|-h)(\s|$)", sanitized):
        return False

    # Explicit repo in the command wins
    if any(re.search(p, sanitized, re.IGNORECASE) for p in FLEET_CLIENT_FACING_REPOS):
        return True

    # No explicit repo: derive from the git remote of the command's cwd
    remote = _remote_repo(_command_cwd(command))
    if remote is None:
        # Unreadable remote on a merge command: refuse rather than assume.
        return True
    return any(re.search(p, remote, re.IGNORECASE) for p in FLEET_CLIENT_FACING_REPOS)


def has_pi_authorization(command: str) -> bool:
    """Check for Pi-signed merge authorization (env var, flag, or comment)."""
    # Env var (set BEFORE subprocess spawn, not inline-prefixed shell var)
    env_task = os.environ.get("PI_AUTHORIZED_MERGE_TASK_ID", "").strip()
    if env_task and APPROVED_TASK_RE.fullmatch(env_task):
        return True

    # Inline flag --pi-authorized-merge=k...
    if re.search(r"--pi-authorized-merge=k[a-z0-9]{15,40}\b", command):
        return True

    # Inline comment # pi-authorized-merge: k...
    if re.search(r"#\s*pi-authorized-merge:\s*k[a-z0-9]{15,40}\b", command):
        return True

    return False


def has_laurent_override(command: str) -> bool:
    """Laurent direct override comment for rare manual cases."""
    return bool(re.search(r"#\s*laurent-direct-merge\b", command))


def audit_log(entry: dict) -> None:
    """Append-only audit log to /tmp/pi-auth-pr-merge.log."""
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Fail-open on log write error


try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name != "Bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if not command:
        sys.exit(0)

    if not is_fleet_merge(command):
        sys.exit(0)

    # Laurent override (rare manual case)
    if has_laurent_override(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "laurent-direct-merge",
            "command": command[:200],
        })
        sys.exit(0)

    # Pi-signed authorization
    if has_pi_authorization(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "pi-authorized",
            "command": command[:200],
        })
        sys.exit(0)

    # Block
    audit_log({
        "ts": int(time.time()),
        "verdict": "block",
        "reason": "no-pi-authorization",
        "command": command[:200],
    })

    print(
        "BLOCKED: PR merge / push to main of client-facing fleet repo without Pi-signed authorization.\n"
        "\n"
        "Day 87 standing rule (Laurent verbatim, memory j577xjby0mncv7wpx4ewjz4n5s87nbcw):\n"
        "  Pi devient autorité fleet pour merges client-facing — système autonome,\n"
        "  ne dépend pas de Laurent. Extension pattern Day 82 PI-SIGNED PROD DEPLOY.\n"
        "\n"
        "Required order:\n"
        "  1. PR created\n"
        "  2. Eta review dispatched (create_task assignedTo=eta dim 12 brief)\n"
        "  3. Verdict APPROVED received (eta send_message [DONE])\n"
        "  4. Pi crée VP task [PR-MERGE-AUTHORIZED] avec scope (orchestrator + PR# + repo + ETA_APPROVED_TASK_ID ref)\n"
        "  5. Orchestrator merge avec PI_AUTHORIZED_MERGE_TASK_ID référencé\n"
        "\n"
        "To proceed (only after Eta APPROVED + Pi task [PR-MERGE-AUTHORIZED] created):\n"
        "  Option A: PI_AUTHORIZED_MERGE_TASK_ID=k<task-id> gh pr merge N ...\n"
        "  Option B: gh pr merge N --pi-authorized-merge=k<task-id>\n"
        "  Option C: gh pr merge N ... # pi-authorized-merge: k<task-id>\n"
        "\n"
        "task-id = the VP task ID where Pi tagged [PR-MERGE-AUTHORIZED] for this merge.\n"
        "\n"
        "Exception (rare, Laurent-only): commande contient `# laurent-direct-merge`\n"
        "→ allow (Laurent manual override toujours possible).\n"
        "\n"
        "Hors scope: PRs internes Pi-workspace (CLAUDE.md, .claude/, docs-only).\n"
        "Audit trail: /tmp/pi-auth-pr-merge.log\n",
        file=sys.stderr,
    )
    sys.exit(2)

except Exception as e:
    # Fail-open on any unexpected error to avoid blocking legitimate work
    print(f"[hook warning] enforce-pi-authorization-before-pr-merge: {e}", file=sys.stderr)
    sys.exit(0)
