#!/usr/bin/env python3
"""
PreToolUse hook : enforce GitHub PR mergeable state BEFORE running `gh pr merge`.

Refuse `gh pr merge N --repo R ...` if `gh pr view N --repo R --json state,mergeable,mergeStateStatus`
returns anything other than {state: OPEN, mergeable: MERGEABLE, mergeStateStatus: CLEAN|UNSTABLE|HAS_HOOKS}.

Reason: Day 106 friction (2026-06-19) — Pi auto-merge chain T1 → T2 OKF (PR #843 then #844 on
vantageos-agency/vantage-peers). PR #843 squash-merged → main got new commit. PR #844 was stacked
on the same branch family → its mergeable state became CONFLICTING + GitHub auto-closed it (state=CLOSED).
Pi tried merge anyway because Eta APPROVED stamp had been issued before #843 merge — stamp obsolete.

Laurent verbatim: "putain mais comment ça peut encore arriver ça / fais chier ces frictions que l'on
doit éviter!"

Doctrine: RULE #15 AUTO-AMÉLIORATION + RULE #27 PREREQUISITES-FIRST extended : a merge command's
prerequisite is a CLEAN mergeable state at HEAD. State is reality, the auth task is paperwork.
Check state first, refuse paperwork-without-reality.

Exit 0 = allow
Exit 2 = block
"""
import json
import re
import subprocess
import sys

ALLOWED_MERGE_STATES = {"CLEAN", "UNSTABLE", "HAS_HOOKS"}
ALLOWED_MERGEABLE = {"MERGEABLE"}
ALLOWED_STATE = {"OPEN"}

# Regex to extract `gh pr merge N (--repo|-R) OWNER/REPO`.
# Day 114 fix: accept both `--repo` (long) and `-R` (short) forms.
# Pre-fix bug: hook captured repo=None when `-R` was used → fetch_pr_state fell back
# to cwd repo → reported wrong PR state → every legitimate Pi merge with `-R` blocked.
# Friction memory: j57er0j2wr53x42qcfrqd74q6989eeg1 (audit/friction Day 114).
GH_MERGE_RE = re.compile(
    r"\bgh\s+pr\s+merge\s+(\d+)\b(?:.*?\s+(?:--repo|-R)\s+(\S+))?",
    re.IGNORECASE,
)


def parse_pr_target(command: str):
    """Return (pr_number, repo_slug) if command is a gh pr merge, else None.

    Repo may be implicit (current cwd) — return (number, None) in that case."""
    m = GH_MERGE_RE.search(command)
    if not m:
        return None
    pr_num = m.group(1)
    repo = m.group(2)
    return pr_num, repo


def fetch_pr_state(pr_num: str, repo: str | None):
    """Call gh pr view and return parsed state dict, or None on error."""
    cmd = ["gh", "pr", "view", pr_num, "--json", "state,mergeable,mergeStateStatus"]
    if repo:
        cmd.extend(["--repo", repo])
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return None, result.stderr.strip()
        return json.loads(result.stdout), None
    except subprocess.TimeoutExpired:
        return None, "gh pr view timeout (15s)"
    except (json.JSONDecodeError, FileNotFoundError) as exc:
        return None, f"parse/exec error: {exc}"


def run_hook(data: dict) -> int:
    """Return exit code (0=allow, 2=block). Pure-fn for testability."""
    try:
        tool_name = data.get("tool_name", "")
        if tool_name != "Bash":
            return 0

        command = data.get("tool_input", {}).get("command", "") or ""
        target = parse_pr_target(command)
        if not target:
            return 0

        pr_num, repo = target

        if re.search(r"#\s*laurent-direct-merge\b", command):
            return 0

        state, err = fetch_pr_state(pr_num, repo)
        if state is None:
            sys.stderr.write(
                f"[enforce-pr-mergeable-state] WARN gh pr view failed: {err}. Allowing through (fail-open).\n"
            )
            return 0

        pr_state = state.get("state")
        mergeable = state.get("mergeable")
        merge_status = state.get("mergeStateStatus")

        if (
            pr_state in ALLOWED_STATE
            and mergeable in ALLOWED_MERGEABLE
            and merge_status in ALLOWED_MERGE_STATES
        ):
            return 0

        repo_str = repo or "(current cwd)"
        sys.stderr.write(
            "BLOCKED: PR not in a clean mergeable state.\n"
            f"  gh pr view {pr_num} --repo {repo_str} -> "
            f"state={pr_state} mergeable={mergeable} mergeStateStatus={merge_status}\n"
            "\n"
            "Required: state=OPEN, mergeable=MERGEABLE, mergeStateStatus in {CLEAN, UNSTABLE, HAS_HOOKS}.\n"
            "\n"
            "Common causes:\n"
            "  - CONFLICTING / DIRTY  -> branch needs rebase on main (assignee rebases + force-pushes).\n"
            "  - CLOSED               -> PR auto-closed (often after stacked PR merge corrupted base) -> reopen + rebase.\n"
            "  - BLOCKED              -> required check failing or review missing.\n"
            "  - BEHIND               -> branch is behind base, push merge button or rebase.\n"
            "  - DRAFT                -> mark ready first: gh pr ready N --repo R.\n"
            "  - UNKNOWN              -> GitHub still recomputing mergeability (usually after a sibling merge). Retry in a few seconds.\n"
            "\n"
            "Doctrine RULE #15 AUTO-IMPROVEMENT + RULE #27 extended: the merge prerequisite is reality,\n"
            "not paperwork. Pi-auth task is downstream of mergeable state. Day 106 trigger: chain auto-merge\n"
            "T1->T2 broke #844 base after #843 squash-merged. Hook eliminates that class structurally.\n"
            "\n"
            "Exception (rare, Laurent-only): command contains `# laurent-direct-merge`.\n"
        )
        return 2

    except Exception as exc:
        sys.stderr.write(f"[enforce-pr-mergeable-state] WARN exception {exc}, allowing through.\n")
        return 0


if __name__ == "__main__" and not globals().get("_TESTING"):
    sys.exit(run_hook(json.load(sys.stdin)))
