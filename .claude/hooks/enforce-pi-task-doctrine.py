#!/usr/bin/env python3
"""enforce-pi-task-doctrine.py — T2.B group 1 consolidated hook (Day 110).

Fuses three task-surface hooks into one PreToolUse router:

  1. enforce-task-quality        — VERIFICATION: + TESTS: sections in description
  2. enforce-task-delegation     — subagent_type + run_in_background + model triplet
  3. enforce-evidence-bound-completion — completionNote >= 40 chars + verifiable token

Router by tool_name:

  mcp__vantage-peers__create_task     -> quality + delegation
  mcp__vantage-peers__update_task     -> delegation; evidence if status in review|done
  mcp__vantage-peers__complete_task   -> evidence

Single umbrella override (rare): `// allow-pi-task-doctrine-skip: <reason>`
in description OR completionNote. Original markers also preserved verbatim:

  - quality      : (none — always required when description non-empty)
  - delegation   : `delegationOptOut: <reason>`,
                   tags [META] / [ADMIN] / [MESSAGING] / [INFO ONLY] / [STATUS] / [DONE]
                   (non-batch only; batch patterns still require delegation),
                   `assignedTo=laurent`
  - evidence     : `// allow-no-evidence: <reason>`

Exit 0 = allow. Exit 2 = block.

Fail-open on any internal exception — a script bug never blocks a legit call.
"""
import json
import re
import sys

# ---------------------------------------------------------------------------
# Tool routing
# ---------------------------------------------------------------------------

CREATE_TASK = "mcp__vantage-peers__create_task"
UPDATE_TASK = "mcp__vantage-peers__update_task"
COMPLETE_TASK = "mcp__vantage-peers__complete_task"

# ---------------------------------------------------------------------------
# Umbrella override
# ---------------------------------------------------------------------------

UMBRELLA_OVERRIDE_RE = re.compile(
    r"//\s*allow-pi-task-doctrine-skip\s*:\s*\S", re.IGNORECASE
)

# ---------------------------------------------------------------------------
# Quality sub-check (preserves enforce-task-quality.py contract)
# ---------------------------------------------------------------------------

REQUIRED_QUALITY_SECTIONS = ("verification:", "tests:")


def check_quality(description: str) -> str | None:
    """Return blocking message if quality fails, else None."""
    if not description:
        return (
            "BLOCKED: Task has no description.\n\n"
            "Every task MUST include:\n"
            "  VERIFICATION: (what will be checked to confirm the task is done)\n"
            "  TESTS: (how it will be tested — manually, automated, or by review)\n\n"
            "A task with no description cannot be delegated, verified, or closed."
        )

    description_lower = description.lower()
    missing = [
        section.rstrip(":").upper()
        for section in REQUIRED_QUALITY_SECTIONS
        if section not in description_lower
    ]
    if not missing:
        return None

    missing_str = " and ".join(missing)
    return (
        f"BLOCKED: Task missing {missing_str} section(s).\n\n"
        f"Every task MUST include:\n"
        f"  VERIFICATION: (what will be checked to confirm the task is done)\n"
        f"  TESTS: (how it will be tested — manually, automated, or by review)\n\n"
        f"Add the missing section(s) to the description before creating the task.\n"
        f"Tasks without quality gates cannot be verified or closed with confidence."
    )


# ---------------------------------------------------------------------------
# Delegation sub-check (preserves enforce-task-delegation.py v1.1.0 contract)
# ---------------------------------------------------------------------------

DELEGATION_PATTERNS = {
    "subagent_type": re.compile(
        r"subagent_type\s*[=:]\s*[\"`']?[a-z][\w-]+", re.IGNORECASE
    ),
    "run_in_background": re.compile(
        r"run_in_background\s*[=:]\s*true", re.IGNORECASE
    ),
    "model_sonnet": re.compile(
        r"model\s*[=:]\s*[\"`']?sonnet", re.IGNORECASE
    ),
}

DELEGATION_OPT_OUT_RE = re.compile(r"delegationOptOut\s*:\s*\S", re.IGNORECASE)
DELEGATION_META_TAGS_RE = re.compile(
    r"\[(META|ADMIN|MESSAGING|INFO\s*ONLY|STATUS|DONE)\]", re.IGNORECASE
)
DELEGATION_BATCH_RE = re.compile(
    r"\b(mass[-_ ]?close|mass[-_ ]?update|mass[-_ ]?insert|"
    r"loop\b|batch\b|sweep\b|scan[-_ ]?all\b|cascade[-_ ]?close|"
    r"bulk\b|in[-_ ]?loop|for[-_ ]?each|repeated)\b",
    re.IGNORECASE,
)


def check_delegation(description: str, title: str, assigned_to: str) -> str | None:
    """Return blocking message if delegation triplet missing, else None."""
    if assigned_to.strip().lower() == "laurent":
        return None
    if not description.strip():
        # empty description is the quality check's job, not delegation's
        return None
    if DELEGATION_OPT_OUT_RE.search(description):
        return None

    combined = (title + " " + description).lower()
    is_batch = bool(DELEGATION_BATCH_RE.search(combined))

    if not is_batch and DELEGATION_META_TAGS_RE.search(description):
        return None

    missing = [
        label
        for label, pattern in DELEGATION_PATTERNS.items()
        if not pattern.search(description)
    ]
    if not missing:
        return None

    missing_str = " + ".join(missing)
    batch_note = ""
    if is_batch:
        batch_note = (
            "\n\n*** BATCH operation detected — delegation required even with "
            "[META]/[ADMIN]/[MESSAGING] tag. ***\n"
            "Repeated/loop/sweep/mass operations MUST be dispatched to a subagent\n"
            "(background sonnet). Tagging with [META] does NOT bypass delegation\n"
            "for batch work. Reference doctrine memory j57ehd9psbx4z721sb7hggqse987fhtk.\n"
        )

    return (
        f"BLOCKED: Task description missing delegation specs: {missing_str}"
        f"{batch_note}\n"
        f"Every task assigned to an orchestrator MUST instruct delegation explicitly:\n"
        f'  Delegate to: `subagent_type="<specialist>"`\n'
        f"  Mode: `run_in_background=true`\n"
        f'  Model : `model="sonnet"`\n\n'
        f"Specialists available: dev-qa, dev-convex-expert, dev-clerk-expert,\n"
        f"  dev-frontend, dev-senior-dev, dev-tech-researcher, dev-product-manager,\n"
        f"  agency-image-designer, agency-copywriter, agency-artistic-director,\n"
        f"  ads-creator, brand-kit-extractor, etc.\n\n"
        f"Why: orchestrators cannot code themselves (block-orchestrator-code-edits).\n"
        f"  Foreground subagents block the session. Opus default wastes budget.\n"
        f"  Reference: feedback memory j5757xkcgeqd07mr9zjx1p5cn585p9wy.\n\n"
        f"Opt-out (rare, requires justification):\n"
        f"  - Add `delegationOptOut: <reason>` to description, OR\n"
        f"  - Tag with [META] / [ADMIN] / [MESSAGING] (pure orchestration,\n"
        f"    NON-BATCH only — batch ops always require delegation), OR\n"
        f'  - Set assignedTo="laurent" (manual human task).'
    )


# ---------------------------------------------------------------------------
# Evidence sub-check (preserves enforce-evidence-bound-completion.py contract)
# ---------------------------------------------------------------------------

EVIDENCE_MIN_LEN = 40

EVIDENCE_PATTERNS = (
    re.compile(r"https?://\S+"),
    re.compile(r"\b[0-9a-f]{7,40}\b"),
    re.compile(r"#\d{1,6}\b"),
    re.compile(r"\b[a-z0-9]{20,}\b"),
    re.compile(r"\b\d+\s*/\s*\d+\b"),
    re.compile(
        r"\b\d+\s+(tests?|pass|passed|passing|green|errors?|rows?|"
        r"lignes?|lines?|files?|fichiers?|issues?|commits?|"
        r"insertions?|deletions?|tools?|gates?)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b[\w./\-]+\.(png|jpe?g|gif|webp|svg|md|mdx|json|jsonl|"
        r"xlsx|csv|html|pdf|tsx?|jsx?|py|sh|ya?ml|css|txt)\b",
        re.IGNORECASE,
    ),
)

EVIDENCE_OPT_OUT = "allow-no-evidence:"


def has_evidence(note: str) -> bool:
    return any(p.search(note) for p in EVIDENCE_PATTERNS)


def check_evidence(note: str, tool_name: str, status: str | None) -> str | None:
    """Return blocking message if evidence rule fails, else None."""
    if EVIDENCE_OPT_OUT in note:
        return None

    stripped = note.strip()
    if not stripped:
        failure = "completionNote is missing or empty"
    elif len(stripped) < EVIDENCE_MIN_LEN:
        failure = (
            f"completionNote is too short ({len(stripped)} chars) — "
            f"it does not account for the work"
        )
    elif not has_evidence(note):
        failure = "completionNote carries no verifiable evidence token"
    else:
        return None

    if tool_name == COMPLETE_TASK:
        action = "complete this task"
    else:
        action = f"move this task to '{status}'"

    lines = [
        "BLOCKED: Evidence-Bound Done doctrine (Day 76).",
        "",
        f"You are trying to {action}, but: {failure}.",
        "",
        "A task is not done because the note says so. The completionNote must",
        "cite PROOF a peer can verify without trusting you — at least one of:",
        "  - a URL (PR link, deployed preview, dashboard)",
        "  - a commit SHA (7-40 hex)",
        "  - a PR / issue number (#19)",
        "  - a VantagePeers / Convex ID (message, memory, task, mission)",
        "  - a test / gate ratio (311/314, 69/69)",
        "  - a counted artifact (2900 rows, 18 tests, 7 files)",
        "  - a file artifact path (analysis/report.md, qa/screenshots/x.png)",
        "",
        "Claim-words alone — 'done', 'merged', 'deployed', 'PASS', 'all good' —",
        "are NOT evidence. They are the very thing being asserted.",
        "",
        "FIX: do the verification, then quote its result in the completionNote.",
        "Open the PR, hit the URL, run the test, read the file — then cite it.",
        "",
        "Opt-out (rare — judgment-only completion with no producible artifact):",
        "add `// allow-no-evidence: <reason>` in the note. Use once, then fix",
        "the source so the next completion carries real proof.",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main router
# ---------------------------------------------------------------------------


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        try:
            data = json.loads(raw)
        except Exception:
            return 0
    except Exception:
        return 0

    tool_name = data.get("tool_name", "") or ""
    if tool_name not in (CREATE_TASK, UPDATE_TASK, COMPLETE_TASK):
        return 0

    tool_input = data.get("tool_input", {}) or {}

    description = tool_input.get("description", "") or ""
    title = tool_input.get("title", "") or ""
    assigned_to = tool_input.get("assignedTo", "") or ""
    note = tool_input.get("completionNote", "") or ""
    if not isinstance(note, str):
        note = ""
    status = tool_input.get("status")

    # Umbrella override on description OR completionNote.
    if UMBRELLA_OVERRIDE_RE.search(description) or UMBRELLA_OVERRIDE_RE.search(note):
        return 0

    if tool_name == CREATE_TASK:
        msg = check_quality(description)
        if msg:
            sys.stderr.write(msg + "\n")
            return 2
        msg = check_delegation(description, title, assigned_to)
        if msg:
            sys.stderr.write(msg + "\n")
            return 2
        return 0

    if tool_name == COMPLETE_TASK:
        msg = check_evidence(note, tool_name, status)
        if msg:
            sys.stderr.write(msg + "\n")
            return 2
        return 0

    # UPDATE_TASK: evidence applies only when moving to review|done; delegation
    # applies whenever a description is being set or amended.
    if tool_name == UPDATE_TASK:
        if status in ("review", "done"):
            msg = check_evidence(note, tool_name, status)
            if msg:
                sys.stderr.write(msg + "\n")
                return 2
        # Delegation only fires if description is part of the update payload.
        if description:
            msg = check_delegation(description, title, assigned_to)
            if msg:
                sys.stderr.write(msg + "\n")
                return 2
        return 0

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.stderr.write(
            f"[enforce-pi-task-doctrine] internal error, fail-open: {exc}\n"
        )
        sys.exit(0)
