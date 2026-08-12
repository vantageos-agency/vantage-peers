#!/usr/bin/env python3
# // allow-time-estimate: file-documents-its-own-trigger-patterns
"""
PreToolUse hook : block time estimates in task/mission/message content.
// allow-time-estimate: docstring-describes-patterns

Blocks tool calls (Edit, Write, send_message, create_task, update_task,
create_mission) whose payload contains effort/duration estimates.
// allow-time-estimate: docstring-describes-patterns

Reason: Pi+Chi+other orchestrators have repeatedly produced bullshit
estimates not based on data. Laurent has explicitly demanded this be
structurally prevented (Day 64 — 2026-05-09).

Override: prefix the line with `// allow-time-estimate: <reason>` for
legitimate timing config (cron schedule, polling interval, animation
duration, etc.) — not effort estimates.

Scope exemption (Day 78 — 2026-05-22): Write/Edit on client-facing
deliverable folders (`/notes-synthese/`, `/deliverables/`) is exempt.
In those folders, implementation-hour estimates, OPEX projections and
time-savings figures are *commissioned client content* for T&M
engagements — not internal effort guesses. The Day 64 ban targets
internal bullshit estimates in tasks/missions/briefs/messages; it must
not block a deliverable the client explicitly paid for.

Day 89 fix (2026-05-31): the ETA acronym pattern used (?i) flag which
matched the orchestrator name "Eta" (proper noun) followed by any digit
— a false positive that blocked legitimate messages like reviewer
verdict ratios. Now case-sensitive: only ALL-CAPS ETA triggers.

Day 91 fix (2026-06-01): two backward-looking false positives fixed. // allow-time-estimate: doc-comment-not-estimate
(1) The max/env/approx alternation included a bare '\\.' which matched
ANY narrative end-of-sentence (backward-looking prose was blocked). // allow-time-estimate: doc-comment-not-estimate
Dropped the bare '\\.' + required '\\s+' before qualifier so 'Nh max'
still blocks but 'Nh.' end-of-sentence passes. // allow-time-estimate: doc-comment-not-estimate
(2) The N-M unit range pattern false-positived on legitimate scheduling. // allow-time-estimate: doc-comment-not-estimate
Added backward-context exemption: if the line ALSO contains a schedule
or narrative anchor (créneau, window, meeting, réunion, slot, shift,
hier, il y a, past, history, took, lasted), the range pattern is
skipped. // allow-time-estimate: doc-comment-not-estimate

Day 109 fix (2026-06-20): VR-canonical re-pull conflict resolved.
Sigma + Theta + Kappa flagged that Write/Edit on .claude/skills/*/SKILL.md
+ .claude/hooks/*.py + .claude/agents/*.md was blocked when the VR-canonical
content legitimately contained time phrases (cron windows, "7 days" anchors).
RULE #30 (zéro divergence VR) requires byte-identical local==catalogue,
so the local file MUST equal the canonical VR contentHash exactly —
this hook must not force divergence. New exemption: any Write/Edit
targeting .claude/skills/<slug>/SKILL.md, .claude/hooks/<slug>.py,
.claude/agents/<slug>.md is treated as VR-canonical re-pull and exempted.
"""

import json
import re
import sys

# Backward-context anchors: presence on the same line as a range exempts
# the range pattern (it's a narrative/schedule reference, not an effort
# estimate). // allow-time-estimate: doc-comment-not-estimate
RANGE_BACKWARD_CONTEXT = re.compile(
    r"\b(?:créneau|creneau|window|shift|meeting|réunion|reunion|call|appel|"
    r"slot|interval|range|history|past|hier|aujourd'hui|today|yesterday|"
    r"il\s+y\s+a|duré|a\s+pris|took|lasted|spent)\b",
    re.IGNORECASE,
)

# Patterns that match effort/duration estimates
FORBIDDEN_PATTERNS = [
    # Estimated: N or Estimated N min/h/jours patterns. // allow-time-estimate: doc-comment-not-estimate
    r"(?i)estimated?\s*:?\s*[~\d]",
    # N-M jours/heures/h/min range patterns. Exempted when backward-context anchor present on the line. // allow-time-estimate: doc-comment-not-estimate
    r"\b\d+\s*[-à]\s*\d+\s*(jour|jours|heure|heures|h|min|mn|mins|minutes|heures?|hours?)\b",
    # ~N min/h/jours approximation patterns. // allow-time-estimate: doc-comment-not-estimate
    r"~\s*\d+\s*\.?\d*\s*(min|mn|mins|minute|minutes|h|hour|hours|jour|jours|heure|heures|day|days)\b",
    # Nh max / N jours max / Nmin max patterns. Day 91 fix: dropped bare period (was matching end-of-sentence narrative) + require whitespace before qualifier so 'Nh max' blocks but 'Nh.' passes. // allow-time-estimate: doc-comment-not-estimate
    r"\b\d+\s*\.?\d*\s*(min|mn|h|jour|jours|heure|heures|hour|hours|day|days)\s+(max|env|environ|approx|approximately)\b",
    # ETA acronym + digit. Case-sensitive: orchestrator "Eta" is a proper noun and must not match. // allow-time-estimate: doc-comment-not-estimate
    r"\bETA\s*:?\s*\d",
    # N min/h de dev/revue/test/etc patterns. // allow-time-estimate: doc-comment-not-estimate
    r"\b\d+\s*\.?\d*\s*(?:min|mn|h|jour|jours|heure|heures|hour|hours|day|days)\s+de\s+(dev|revue|review|test|debug|coding|recherche|research|investigation|setup|implem|impl|implementation|impl\.)",
    # Markdown ## Estimated section headers. // allow-time-estimate: doc-comment-not-estimate
    r"(?im)^#+\s*estimated?\s*$",
    # Explicit time effort phrasings (effort/temps/durée + estimé/prévu + number). // allow-time-estimate: doc-comment-not-estimate
    r"(?i)\b(?:effort|temps|time|durée|duration)\s*(?:estimé?|estimated?|prévu?|expected?)\s*:?\s*[~\d]",
]

# Index of the range pattern in FORBIDDEN_PATTERNS (skipped when backward-context anchor present on line). // allow-time-estimate: doc-comment-not-estimate
RANGE_PATTERN_INDEX = 1

OVERRIDE_PATTERN = re.compile(r"//\s*allow-time-estimate:", re.IGNORECASE)

# Client-facing deliverable folders. Files written here are commissioned
# client content (T&M quotes, OPEX projections, time-savings figures) —
# exempt from the internal effort-estimate ban.
# Day 109 addition: VR-canonical re-pull paths under .claude/ (skills SKILL.md
# + hooks .py + agents .md). RULE #30 (zéro divergence VR) requires
# byte-identical local==catalogue, so these paths must not be forced into
# divergence by this hook. Re-pull is governed by VR upstream content,
# which itself follows the hook discipline at its own write time.
EXEMPT_PATH_PATTERNS = [
    r"/notes-synthese/",
    r"/deliverables/",
    # Day 81 — UC subfolders for client deliverables (projects/<client>/uc*/)
    # Files note-synthese.md / doc-technique.md / fiche-uc*.md / offre-*.md /
    # proposition-*.md inside any /uc1-*/, /uc2-*/, /uc3-*/, /uc4-*/, /uc5-*/
    # subfolder are commissioned client content (same exemption as
    # /notes-synthese/ + /deliverables/).
    r"/uc\d+[-_][^/]+/",
    # Day 109 — VR-canonical re-pull exemption (RULE #30 byte-identical)
    r"\.claude/skills/[^/]+/SKILL\.md$",
    r"\.claude/hooks/[^/]+\.py$",
    r"\.claude/agents/[^/]+\.md$",
]


def is_exempt_path(tool_name: str, tool_input: dict) -> bool:
    """True if Write/Edit targets a client-facing deliverable folder or VR-canonical re-pull."""
    if tool_name not in ("Write", "Edit", "MultiEdit"):
        return False
    path = tool_input.get("file_path", "") or ""
    return any(re.search(p, path) for p in EXEMPT_PATH_PATTERNS)


def extract_text_from_input(tool_name: str, tool_input: dict) -> str:
    """Aggregate all string fields that could carry an estimate."""
    parts = []
    if tool_name in ("Edit", "MultiEdit"):
        parts.append(tool_input.get("new_string", ""))
        parts.append(tool_input.get("old_string", ""))
    elif tool_name == "Write":
        parts.append(tool_input.get("content", ""))
    elif tool_name in (
        "mcp__vantage-peers__send_message",
        "mcp__vantage-peers__create_task",
        "mcp__vantage-peers__update_task",
        "mcp__vantage-peers__create_mission",
        "mcp__vantage-peers__update_mission",
        "mcp__vantage-peers__create_briefing_note",
        "mcp__vantage-peers__store_memory",
        "mcp__vantage-peers__write_diary",
    ):
        # Fields that may contain prose
        for key in (
            "content", "description", "brief", "completionNote",
            "title", "name", "summary", "body",
        ):
            v = tool_input.get(key)
            if isinstance(v, str):
                parts.append(v)
    return "\n".join(parts)


def find_violations(text: str) -> list[str]:
    """Return list of offending lines (after stripping override-tagged lines)."""
    if not text:
        return []
    violations = []
    for line_idx, line in enumerate(text.splitlines(), start=1):
        if OVERRIDE_PATTERN.search(line):
            continue  # explicit override
        # Day 91 backward-context exemption: schedule/narrative ranges. // allow-time-estimate: doc-comment-not-evaluation
        line_has_backward_context = bool(RANGE_BACKWARD_CONTEXT.search(line))
        for idx, pat in enumerate(FORBIDDEN_PATTERNS):
            # Skip range pattern when line carries narrative/schedule anchor. // allow-time-estimate: doc-comment-not-evaluation
            if idx == RANGE_PATTERN_INDEX and line_has_backward_context:
                continue
            if re.search(pat, line):
                violations.append(f"line {line_idx}: {line.strip()[:140]}")
                break
    return violations


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # malformed input — fail open

    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {}) or {}

    if is_exempt_path(tool_name, tool_input):
        sys.exit(0)  # client-facing deliverable OR VR-canonical re-pull — exempt

    text = extract_text_from_input(tool_name, tool_input)
    violations = find_violations(text)

    if not violations:
        sys.exit(0)  # clean

    # Block
    msg = (
        "BLOCKED: time/effort estimate detected in tool input.\n"
        "\n"
        "Pi+Chi+orchestrators are FORBIDDEN from producing effort/duration estimates.\n"
        "Reason: estimates have repeatedly been bullshit, eroded trust, and Laurent "
        "has explicitly demanded structural prevention (Day 64 — 2026-05-09).\n"
        "\n"
        "Offending lines:\n"
    )
    for v in violations[:5]:  # cap for readability
        msg += f"  - {v}\n"
    if len(violations) > 5:
        msg += f"  ... and {len(violations) - 5} more.\n"
    msg += (
        "\n"
        "Fix: remove the estimate. Use 'TBD' or omit.\n"
        "Override (rare, only for legit timing config — cron, polling, animation): "
        "add comment `// allow-time-estimate: <reason>` on the same line.\n"
    )

    print(msg, file=sys.stderr)
    sys.exit(2)  # exit code 2 = block in Claude Code hook protocol


if __name__ == "__main__":
    main()
