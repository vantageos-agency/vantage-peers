#!/usr/bin/env python3
"""enforce-post-merge-tmp-cleanup.py — PostToolUse on Bash matching `gh pr merge` or `gh pr close`.

Scans local /tmp/ and the repo's .claude/worktrees/ for directories whose recorded
branch corresponds to the PR that just transitioned, and surfaces leftovers so the
orchestrator can clean them in the same shell context.

Class of failure addressed: a worktree created during PR iteration is never removed
after the PR merges or closes. Disk pressure accumulates silently across the fleet
until the host returns HTTP 502 from code-server, or until a subsequent `npm ci`
swap-thrashes the box.

Override: add `# allow-no-cleanup: <reason >= 6 chars>` to the merge or close command.

Why this hook + the doctrine: .claude/rules/post-merge-cleanup.md (always loaded).
Companion skill: cleanup-worktree-post-merge (proactive injection in pi-merge-fleet-pr step 5.5).
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

# ---------- Config ----------

# Path roots scanned for leftover worktrees.
SCAN_ROOTS = [Path("/tmp"), Path("/root/coding")]

# Maximum directories listed in the warning (keeps stderr readable).
MAX_LEFTOVERS_LISTED = 8

# Heuristic alias patterns derived from PR number + repo short.
# We match dir names that look like `<repo-short><pr>` (e.g. vp1030, vpd38, mb32, vr190).
# When the bash command contains `<owner>/<repo>` and `<pr>` we try a few aliases.
REPO_ALIAS_MAP = {
    "vantage-peers": "vp",
    "vantage-peers-dashboard": "vpd",
    "vantage-peers-site": "vps",
    "vantage-registry": "vr",
    "vantage-registry-mcp": "vrm",
    "vantage-immo-dashboard": "vid",
    "vantage-immo-market-intel": "vimi",
    "mosaic-blocks": "mb",
    "vantageos-crm": "vcrm",
    "vantageos-team": "vot",
    "vantage-doc-forge": "vdf",
    "vantage-memory": "vm",
    "perfect-ai-agent": "paa",
    "gptpowerups-extension": "gpe",
    "vantage-immo": "vi",
}

# Override marker.
OVERRIDE_RE = re.compile(r"#\s*allow-no-cleanup:\s*\S{6,}")

# gh pr merge / gh pr close detection. We scan the command line for both forms.
GH_PR_TERMINAL_RE = re.compile(
    r"\bgh\s+pr\s+(?:merge|close)\s+(\d+)\b(?:.*?-R\s+([\w.-]+/[\w.-]+))?",
    re.IGNORECASE | re.DOTALL,
)


# ---------- Helpers ----------


def _read_event() -> dict:
    """Parse the PostToolUse event JSON on stdin. Return {} if absent or malformed."""
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return {}


def _command_text(event: dict) -> str:
    """Extract the bash command string from a PostToolUse Bash event."""
    tool_input = event.get("tool_input") or {}
    return tool_input.get("command") or ""


def _parse_pr_merge(command: str):
    """Return (pr_number, repo_short) if the command merged or closed a PR; else (None, None)."""
    match = GH_PR_TERMINAL_RE.search(command)
    if not match:
        return None, None
    pr = match.group(1)
    repo_full = match.group(2) or ""
    repo_short = repo_full.split("/", 1)[1] if "/" in repo_full else ""
    return pr, repo_short


def _candidate_aliases(repo_short: str, pr: str):
    """Build candidate alias prefixes to look for in scan paths."""
    aliases = set()
    if repo_short:
        short = REPO_ALIAS_MAP.get(repo_short)
        if short:
            aliases.add(f"{short}{pr}")
        # Also try the first letters of repo-short for unknown repos.
        letters = "".join(part[:1] for part in repo_short.split("-") if part)
        if letters:
            aliases.add(f"{letters.lower()}{pr}")
    # Always include a bare-pr-number fallback.
    aliases.add(f"pr{pr}")
    aliases.add(f"pr-{pr}")
    return sorted(aliases)


def _scan_for_leftovers(aliases, pr: str, repo_short: str):
    """Walk SCAN_ROOTS and return paths whose name matches any alias prefix."""
    found = []
    for root in SCAN_ROOTS:
        try:
            entries = list(root.iterdir())
        except (FileNotFoundError, PermissionError):
            continue
        for entry in entries:
            name = entry.name
            for alias in aliases:
                if name == alias or name.startswith(alias + "-") or name.startswith(alias + "_"):
                    found.append(entry)
                    break
            # Also surface .claude/worktrees/* directories tied to this repo by path.
        # Walk one level into <repo>/.claude/worktrees/.
        worktrees_dir = root / repo_short / ".claude" / "worktrees" if repo_short else None
        if worktrees_dir and worktrees_dir.exists():
            try:
                for wt in worktrees_dir.iterdir():
                    if wt.is_dir():
                        # Best-effort: include all under-worktrees, the orchestrator filters.
                        found.append(wt)
            except (FileNotFoundError, PermissionError):
                pass
    return found[:MAX_LEFTOVERS_LISTED]


def _dir_size_safe(path: Path) -> str:
    """Best-effort directory size via du. Returns string like '829M' or 'n/a'."""
    try:
        result = subprocess.run(
            ["du", "-sh", str(path)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode == 0:
            return result.stdout.split()[0]
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return "n/a"


# ---------- Main ----------


def main() -> int:
    event = _read_event()
    command = _command_text(event)
    if not command:
        return 0

    if OVERRIDE_RE.search(command):
        # Operator explicitly opted out, exit silently.
        return 0

    pr, repo_short = _parse_pr_merge(command)
    if not pr:
        return 0

    aliases = _candidate_aliases(repo_short, pr)
    leftovers = _scan_for_leftovers(aliases, pr, repo_short)
    if not leftovers:
        return 0

    lines = [
        "[enforce-post-merge-tmp-cleanup] WARN: worktree leftover candidates detected after",
        f"  gh pr {('merge' if 'merge' in command else 'close')} #{pr} on repo {repo_short or '?'}.",
        "",
        "  Candidates (size, path):",
    ]
    for path in leftovers:
        size = _dir_size_safe(path)
        lines.append(f"    {size:>8}  {path}")
    lines += [
        "",
        "  Per .claude/rules/post-merge-cleanup.md, the same shell step that closes the",
        "  PR MUST also delete the associated worktree(s). Run:",
        "",
        f"    ssh <vps-host> 'rm -rf <one-of-the-paths-above>' && git worktree prune",
        "",
        "  Override (rare): add `# allow-no-cleanup: <reason >= 6 chars>` to the merge or",
        "  close command. Reason must justify a forensics retention or active iteration.",
    ]
    sys.stderr.write("\n".join(lines) + "\n")
    # Non-blocking warning. exit 1 is read by Claude Code as a non-blocking notification.
    return 1


if __name__ == "__main__":
    sys.exit(main())
