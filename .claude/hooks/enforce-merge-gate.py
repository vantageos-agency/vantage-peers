#!/usr/bin/env python3
"""
PreToolUse hook on Bash: enforce auto-merge gate for `gh pr merge`.

Aligned with ElPi Corp Day 51 PM auto-merge rule (memory j574pa7y42sxkq113ph41qeca585k6x7):
- Eta annotation "Eta APPROVED" sur la PR
- ≥1 reviewer humain (autre que l'auteur) annotation "X APPROVED"
- CI green (ou pas de CI = vacuously OK)
- Scope standard (architecture critique → escalation Pi)

Exception override : commit message ou body comment du dernier "Pi APPROVED" peut contenir
explicit "GO MERGE PR #N — scope verified" pour bypass conditions (Pi authority only).

Exit 0 = allow merge
Exit 2 = block with explanation

Version: 1.2.0

Changelog v1.2.0 (Day 51 PM Beta feedback — re-incorporates Beta's local fix that v1.1.0 overwrote):
- Parse `reviews[].body` for orchestrator APPROVED annotations (not just `state=APPROVED`).
  Reason: `gh pr review --approve` blocked when all orchestrators share elpiarthera token
  (memory j5758xvfynw47hmp4vqy11p2wh85kvz3). Workaround = `gh pr review --comment --body "**Eta APPROVED** ..."`,
  which emits review with `state=COMMENTED` (not APPROVED) but body contains the annotation.
  v1.1.0 missed these → false BLOCK on legitimate auto-merge.

Changelog v1.1.0 (Day 51 PM Delta+Sigma feedback):
- Detect `gh pr merge` only at command start (word boundary) to avoid false-positives on commit message bodies containing the literal substring (`git commit -m "fix(gh): gh pr merge gating"`).
- Extract `cd <path> &&` prefix to determine working directory; run `gh pr view` from that cwd so it picks up the right git remotes when --repo flag is absent.
- Fallback gracefully when no remote + no --repo flag (clear error message).
"""
import json
import os
import re
import subprocess
import sys

ORCH_PATTERN = re.compile(
    r"\*\*?(beta|delta|gamma|sigma|omega|alpha|lambda|victor|kappa|phi|tau|eta|pi|zeta)\s+APPROVED\*?\*?",
    re.IGNORECASE,
)
# Internal infra repos: orchestrator self-merges allowed without Eta+reviewer gate.
# Day 72: Pi sort de la boucle merge sur infra interne. Client-facing repos restent gated.
INTERNAL_INFRA_REPOS = {
    "elpiarthera/vantage-memory",
    "elpiarthera/vantage-peers",
    "elpiarthera/vantage-registry",
    "elpiarthera/vantage-architect",
    "elpiarthera/vantage-starter",
    "elpiarthera/vantage-command-center",
    "elpiarthera/perfect-ai-agent",
    "elpiarthera/ElPi-Corp",
    "elpiarthera/elpi-corp",
    "elpiarthera/vantage-taste-engine",
    "vantageos-agency/plugins",
    "vantageos-agency/vantageos-plugins",
}
# NOTE: vantageos-crm is intentionally NOT here. VantageCRM is a product
# (public repo, npm, FSL licence) — not fleet infra. Its PRs stay gated
# (Eta + reviewer APPROVED before merge). Day 76 correction.
PI_OVERRIDE_PATTERN = re.compile(
    r"GO\s+MERGE\s+PR\s*#?\d+",
    re.IGNORECASE,
)
# Only match `gh pr merge` at start of command (or after `cd path && `)
# Avoids false-positive on commit messages containing the substring.
GH_PR_MERGE_INVOCATION = re.compile(
    r"(?:^|;|&&|\|\|)\s*(?:cd\s+\S+\s*&&\s*)?gh\s+pr\s+merge\b",
)
CD_PREFIX_PATTERN = re.compile(r"(?:^|;|&&|\|\|)\s*cd\s+(\S+)\s*&&")


def _extract_pr_number(command: str) -> str:
    m = re.search(r"gh\s+pr\s+merge\s+(\d+)", command)
    return m.group(1) if m else ""


def _extract_repo(command: str) -> str:
    m = re.search(r"--repo\s+(\S+)", command)
    return m.group(1) if m else ""


def _extract_cwd(command: str) -> str:
    """Parse 'cd <path> && gh pr merge ...' prefix to derive cwd for gh CLI."""
    m = CD_PREFIX_PATTERN.search(command)
    if not m:
        return ""
    path = m.group(1).strip("'\"")
    if os.path.isdir(path):
        return path
    return ""


def _block(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(2)


try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    if tool_name != "Bash":
        sys.exit(0)

    command = tool_input.get("command", "") or ""

    # Use word-boundary regex to only match real `gh pr merge` invocations
    # (avoids false-positive on commit messages containing the literal substring).
    if not GH_PR_MERGE_INVOCATION.search(command):
        sys.exit(0)

    pr_number = _extract_pr_number(command)
    repo = _extract_repo(command)
    cwd = _extract_cwd(command)

    if not pr_number:
        _block(
            "BLOCKED: cannot extract PR number from `gh pr merge` command.\n"
            "Use explicit form: gh pr merge <PR#> [--repo org/repo] [--merge|--squash|--rebase]"
        )

    # Build gh pr view command (use repo if specified)
    view_cmd = ["gh", "pr", "view", pr_number]
    if repo:
        view_cmd.extend(["--repo", repo])
    view_cmd.extend([
        "--json",
        "number,author,comments,reviews,statusCheckRollup,mergeable,mergeStateStatus,title,body",
    ])

    # If `cd <path> && gh pr merge ...`, run gh from that path so it picks up the right git remotes.
    subprocess_cwd = cwd if cwd else None

    try:
        result = subprocess.run(view_cmd, capture_output=True, text=True, timeout=15, cwd=subprocess_cwd)
        if result.returncode != 0:
            _block(
                f"BLOCKED: cannot fetch PR #{pr_number} via `gh pr view`.\n"
                f"stderr: {result.stderr.strip()}\n"
                f"cwd: {subprocess_cwd or os.getcwd()}\n"
                "Pass --repo org/repo flag in the merge command, OR run from a repo with the right remotes."
            )
        pr_data = json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        _block(f"BLOCKED: `gh pr view {pr_number}` timeout (15s).")
    except json.JSONDecodeError as e:
        _block(f"BLOCKED: cannot parse `gh pr view` output: {e}")

    # Extract author
    author = (pr_data.get("author") or {}).get("login", "")
    pr_title = pr_data.get("title", "?")

    # Pi override : check si la PR description ou un commentaire contient explicit GO MERGE
    body = pr_data.get("body", "") or ""
    comments = pr_data.get("comments", []) or []

    pi_override = False
    if PI_OVERRIDE_PATTERN.search(body):
        pi_override = True
    for c in comments:
        c_body = c.get("body", "") or ""
        c_author = (c.get("author") or {}).get("login", "")
        # Pi override only valid if comment from elpiarthera (Pi/Laurent token)
        if PI_OVERRIDE_PATTERN.search(c_body) and "elpiarthera" in c_author.lower():
            pi_override = True
            break

    if pi_override:
        # Pi explicit override — allow
        sys.exit(0)

    # Internal infra repo bypass — orchestrator self-merges allowed (Day 72)
    if repo and repo.lower() in {r.lower() for r in INTERNAL_INFRA_REPOS}:
        sys.exit(0)
    # If no --repo flag, derive from git remote in cwd
    if not repo:
        try:
            remote_result = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                capture_output=True, text=True, timeout=5, cwd=subprocess_cwd
            )
            if remote_result.returncode == 0:
                remote_url = remote_result.stdout.strip()
                # Match owner/repo from URL (https or ssh)
                m = re.search(r"[:/]([\w-]+/[\w-]+?)(?:\.git)?$", remote_url)
                if m and m.group(1).lower() in {r.lower() for r in INTERNAL_INFRA_REPOS}:
                    sys.exit(0)
        except Exception:
            pass

    # Standard auto-merge rule check

    # 1. Eta APPROVED annotation
    eta_approved = False
    other_approvers = set()
    for c in comments:
        c_body = c.get("body", "") or ""
        match = ORCH_PATTERN.search(c_body)
        if not match:
            continue
        orch = match.group(1).lower()
        if orch == "eta":
            eta_approved = True
        else:
            # Don't count author as reviewer
            # (author is gh login, orch names are roles — proxy via not-self)
            other_approvers.add(orch)

    # Also check formal reviews (gh pr review --approve emits reviews with state=APPROVED;
    # gh pr review --comment workaround for shared-token orchestrators emits reviews with
    # state=COMMENTED but body contains "**X APPROVED**" annotation — both must be parsed).
    reviews = pr_data.get("reviews", []) or []
    for r in reviews:
        r_state = (r.get("state") or "").upper()
        r_body = r.get("body", "") or ""
        r_author = (r.get("author") or {}).get("login", "")

        # Path A: formal --approve review
        if r_state == "APPROVED" and r_author and r_author != author:
            other_approvers.add(f"github-review:{r_author}")
            continue

        # Path B: --comment workaround — body contains orchestrator APPROVED annotation
        match = ORCH_PATTERN.search(r_body)
        if match:
            orch = match.group(1).lower()
            if orch == "eta":
                eta_approved = True
            else:
                other_approvers.add(orch)

    if not eta_approved:
        _block(
            f"BLOCKED: PR #{pr_number} '{pr_title}' missing Eta APPROVED annotation.\n"
            f"\n"
            f"Auto-merge rule (memory j574pa7y42sxkq113ph41qeca585k6x7) requires:\n"
            f"  1. Eta APPROVED comment ← MISSING\n"
            f"  2. ≥1 other reviewer APPROVED ← {len(other_approvers)} found ({', '.join(sorted(other_approvers)) or 'none'})\n"
            f"  3. CI green\n"
            f"  4. Scope standard\n"
            f"\n"
            f"Wait for Eta annotation `gh pr review --comment --body \"**Eta APPROVED** ...\"`\n"
            f"OR ask Pi for explicit 'GO MERGE PR #{pr_number} — scope verified' override comment."
        )

    if len(other_approvers) < 1:
        _block(
            f"BLOCKED: PR #{pr_number} '{pr_title}' has Eta APPROVED but 0 other reviewers.\n"
            f"\n"
            f"Auto-merge rule requires ≥1 human reviewer (orchestrator other than author '{author}').\n"
            f"Use `gh pr review --comment --body \"**Beta APPROVED** ...\"` (or other orch) before merge.\n"
            f"\n"
            f"OR ask Pi for explicit 'GO MERGE PR #{pr_number} — scope verified' override."
        )

    # 3. CI checks
    checks = pr_data.get("statusCheckRollup", []) or []
    failing = [c.get("name", "?") for c in checks if c.get("conclusion") not in ("SUCCESS", "NEUTRAL", "SKIPPED", None)]
    if failing:
        _block(
            f"BLOCKED: PR #{pr_number} '{pr_title}' has failing CI checks.\n"
            f"\n"
            f"Failing: {', '.join(failing)}\n"
            f"\n"
            f"Fix CI before merge. OR ask Pi for explicit 'GO MERGE PR #{pr_number} — scope verified' override."
        )

    # 4. Mergeability state
    mergeable = pr_data.get("mergeable", "UNKNOWN")
    merge_state = pr_data.get("mergeStateStatus", "UNKNOWN")
    if mergeable != "MERGEABLE" or merge_state not in ("CLEAN", "UNSTABLE", "HAS_HOOKS"):
        _block(
            f"BLOCKED: PR #{pr_number} '{pr_title}' not mergeable.\n"
            f"\n"
            f"mergeable={mergeable}, mergeStateStatus={merge_state}\n"
            f"\n"
            f"Resolve conflicts/blocking checks before merge."
        )

    # All conditions met
    sys.exit(0)

except SystemExit:
    raise
except Exception as e:
    # Fail-open on unexpected error to avoid breaking workflow
    print(f"WARNING: enforce-merge-gate.py exception (allowing merge): {e}", file=sys.stderr)
    sys.exit(0)
