#!/usr/bin/env python3
"""
PreToolUse hook: enforces the Evidence-Bound Done doctrine (Day 76).

A task is not "done" because a report says so. A completion must carry
machine-checkable PROOF — a reference any peer can independently verify
without trusting the author.

Root cause this hook addresses (Day 73-76 retrospective):
  Orchestrators (and Pi) close tasks on the strength of a narrative
  ("DONE, tout marche") with no verifiable artifact. False positives then
  propagate silently — the taste engine scored an incomplete charte 69/69,
  the Marie enrichment was "done" three times before it was, auto-IRP
  generated 45 phantom issues. The human eye stayed the real gate.

Enforced on:
  - mcp__vantage-peers__complete_task         (always)
  - mcp__vantage-peers__update_task           (only when status -> review|done)

A completionNote PASSES when it is present, >= 40 chars, and cites at least
one EVIDENCE TOKEN — something a peer can look up:
  - a URL                          https://github.com/.../pull/19
  - a commit SHA                   d8ceef5 / d8ceef5ca254...
  - a PR / issue number            #19
  - a VantagePeers / Convex ID     jn74q3r6p6w3yax0rgd6ftg249872jqy
  - a test / gate ratio            311/314, 69/69
  - a counted artifact             2900 rows, 18 tests, 7 files
  - a file artifact path           projects/.../report.md, qa/screenshots/x.png

Claim-words alone ("done", "merged", "deployed", "all good", "PASS") are
NOT evidence — they are the very thing being asserted.

Opt-out (rare, requires explicit reason — judgment-only completions with no
producible artifact): add `// allow-no-evidence: <reason>` in the note.
Per the hook-rejection-loop doctrine: use once in emergence, then fix the
source so the next completion carries real proof.

Exit codes:
  0 = allow
  2 = block with remediation
"""
import json
import re
import sys

ENFORCED_TOOLS = (
    "mcp__vantage-peers__complete_task",
    "mcp__vantage-peers__update_task",
)

MIN_LEN = 40

# Evidence tokens — a completionNote must contain at least one. Each is a
# reference a peer can independently verify.
EVIDENCE_PATTERNS = (
    re.compile(r"https?://\S+"),                                  # URL
    re.compile(r"\b[0-9a-f]{7,40}\b"),                            # commit SHA
    re.compile(r"#\d{1,6}\b"),                                    # PR / issue number
    re.compile(r"\b[a-z0-9]{20,}\b"),                             # VantagePeers / Convex ID
    re.compile(r"\b\d+\s*/\s*\d+\b"),                             # test / gate ratio
    re.compile(
        r"\b\d+\s+(tests?|pass|passed|passing|green|errors?|rows?|"
        r"lignes?|lines?|files?|fichiers?|issues?|commits?|"
        r"insertions?|deletions?|tools?|gates?)\b",
        re.IGNORECASE,
    ),                                                            # counted artifact
    re.compile(
        r"\b[\w./\-]+\.(png|jpe?g|gif|webp|svg|md|mdx|json|jsonl|"
        r"xlsx|csv|html|pdf|tsx?|jsx?|py|sh|ya?ml|css|txt)\b",
        re.IGNORECASE,
    ),                                                            # file artifact path
)

OPT_OUT = "allow-no-evidence:"


def has_evidence(note: str) -> bool:
    return any(p.search(note) for p in EVIDENCE_PATTERNS)


def main():
    try:
        data = json.load(sys.stdin)
    # TOOL_NAME_GUARD_PI_FIX Day 113 — fleet deadlock fix (matcher=* fires every tool)
    if data.get("tool_name") != "mcp__vantage-peers__complete_task":
        sys.exit(0)
    except Exception:
        sys.exit(0)

    tool_name = data.get("tool_name", "") or ""
    if tool_name not in ENFORCED_TOOLS:
        sys.exit(0)

    tool_input = data.get("tool_input", {}) or {}

    # update_task only carries a "done claim" when status becomes review|done.
    if tool_name.endswith("update_task"):
        status = tool_input.get("status")
        if status not in ("review", "done"):
            sys.exit(0)

    note = tool_input.get("completionNote")
    note = note if isinstance(note, str) else ""

    # Opt-out marker.
    if OPT_OUT in note:
        sys.exit(0)

    failure = None
    if not note.strip():
        failure = "completionNote is missing or empty"
    elif len(note.strip()) < MIN_LEN:
        failure = f"completionNote is too short ({len(note.strip())} chars) — it does not account for the work"
    elif not has_evidence(note):
        failure = "completionNote carries no verifiable evidence token"

    if not failure:
        sys.exit(0)

    action = "complete this task" if tool_name.endswith("complete_task") \
        else f"move this task to '{tool_input.get('status')}'"

    msg = [
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
    print("\n".join(msg), file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Fail-open so a script bug never blocks a completion.
        print(f"[enforce-evidence-bound-completion] internal error, fail-open: {e}",
              file=sys.stderr)
        sys.exit(0)
