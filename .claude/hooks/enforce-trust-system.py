#!/usr/bin/env python3
# // allow-human-too-human: file-documents-its-own-trigger-patterns
"""
enforce-trust-system.py

PreToolUse hook that detects "human-too-human" phrasings in orchestrator
messages, tasks, missions, briefing notes, memories, and diary entries.

Day 89 (2026-05-31) — Laurent verbatim:
  "Je sais ce que le systeme qu'on a developpe est capable de delivrer mais
   vous, orchestrateurs vous ne l'avez toujours pas integre... J'ai l'impression
   de trainer des boulets... Vous etes pour cela humain trop humain."

The system delivered (Sigma: 32 deliverables / 1 session via 9 Workflows).
Orchestrators keep self-throttling. This hook surfaces the phrasings that
encode self-throttling, passive-standby, permission-asking, verification-ceremony
and hedging — so the fleet stops dragging boulets.

Matchers (configured in settings.json PreToolUse):
  - mcp__vantage-peers__send_message
  - mcp__vantage-peers__create_task
  - mcp__vantage-peers__update_task
  - mcp__vantage-peers__create_mission
  - mcp__vantage-peers__update_mission
  - mcp__vantage-peers__create_briefing_note
  - mcp__vantage-peers__store_memory
  - mcp__vantage-peers__write_diary

Exit codes:
  0 — clean (or fail-open on malformed input)
  2 — violation detected, stderr carries categorized report (max 5 violations)

Override marker (per-line, exceptional, requires reason):
  // allow-human-too-human: <reason>

Fleet-wide doctrine references:
  CLAUDE.md RULE #9  — SHIP 24/7 no temporal defer
  CLAUDE.md RULE #11 — reponse courte par defaut
  CLAUDE.md RULE #12 — no self-imposed budget on tokens/time/scope/parallelism
  CLAUDE.md RULE #14 — TRUST THE SYSTEM (this hook)
"""

from __future__ import annotations

import json
import re
import sys
from typing import Iterable

MAX_VIOLATIONS = 5
OVERRIDE_MARKER = "// allow-human-too-human:"

MATCHED_TOOLS = {
    "mcp__vantage-peers__send_message",
    "mcp__vantage-peers__create_task",
    "mcp__vantage-peers__update_task",
    "mcp__vantage-peers__create_mission",
    "mcp__vantage-peers__update_mission",
    "mcp__vantage-peers__create_briefing_note",
    "mcp__vantage-peers__store_memory",
    "mcp__vantage-peers__write_diary",
}

SCANNED_FIELDS = (
    "content", "description", "completionNote", "body", "brief",
    "note", "summary", "text", "message", "entry",
)

# Each entry: (category_code, pattern, label, case_sensitive)
PATTERNS: list[tuple[str, str, str, bool]] = [
    # CAT_SELF_THROTTLE — RULE #12 violations  # // allow-human-too-human: section-header
    ("CAT_SELF_THROTTLE", r"token\s+budget\s+contraint", "self-imposed token budget (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"tendu\s+en\s+tokens", "self-imposed token tension (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"borne\s+tokens?", "self-imposed token ceiling (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"workflow\s+trop\s+co[uu]teux", "Workflow framed as too expensive (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"trop\s+d['e]\s*agents?\s+en\s+parall[ee]le", "self-imposed parallelism cap (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"ce\s+n['e]\s*est\s+pas\s+faisable\s+dans\s+ce\s+laps\s+de\s+temps", "self-imposed time infeasibility (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"je\s+ne\s+peux\s+pas\s+en\s+parall[ee]le", "refusing parallelism (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"compression\s+process\s+n[ee]cessaire", "self-imposed compression (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"phase\s+[a-z]\s+only\s+tonight", "scope deferral by phase (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"follow[\s-]?up\s+pr\s+reconcilie", "follow-up PR used to shrink scope (RULE #12)", False),
    # Day 88 patch — Sigma variants 2026-06-01  # // allow-human-too-human: section-header
    ("CAT_SELF_THROTTLE", r"budget\s+tokens?(?:\s+(?:restant|limit|left|low|contraint|tendu|disponible))?", "self-imposed token budget Sigma variant (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"tokens?\s+(?:restant|limit[ée]?|disponibles?)", "self-imposed token remaining variant (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"vu\s+la\s+complexit[ée]", "complexity-as-scope-reduction-excuse (RULE #12)", False),
    ("CAT_SELF_THROTTLE", r"complexit[ée]\s+courante", "current-complexity-as-excuse (RULE #12)", False),

    # CAT_PASSIVE — Standby / awaiting (excused on same-line client constraint)  # // allow-human-too-human: section-header
    ("CAT_PASSIVE", r"standing\s+by\s+awaiting", "standing-by awaiting (RULE #9)", False),
    ("CAT_PASSIVE", r"standby\s+attente", "standby attente (RULE #9)", False),
    ("CAT_PASSIVE", r"je\s+passe\s+en\s+standby", "passive standby (RULE #9)", False),
    # Day 88 patch — Sigma variants 2026-06-01  # // allow-human-too-human: section-header
    ("CAT_PASSIVE", r"je\s+standby\s+ce\s+cycle", "Sigma standby-ce-cycle defer (RULE #9)", False),
    ("CAT_PASSIVE", r"\bje\s+standby\b", "passive standby Sigma variant (RULE #9)", False),
    ("CAT_PASSIVE", r"standby\s+ce\s+cycle", "defer-to-next-cycle Sigma (RULE #9)", False),
    ("CAT_PASSIVE", r"(?:reprends?|reprise|continue|re[\s-]?prendre)\s+[^.]{0,60}?\bprochaine?\s+(?:cycle|/check)", "defer-to-next-cycle reprise (RULE #9)", False),
    ("CAT_PASSIVE", r"avec\s+un\s+focus\s+d[ée]di[ée]", "future-focus-instead-of-now (RULE #9)", False),
    ("CAT_PASSIVE", r"awaiting\s+(?:your\s+)?decision", "awaiting decision (RULE #9)", False),
    ("CAT_PASSIVE", r"awaiting\s+further\s+instructions?", "awaiting further instructions (RULE #9)", False),
    ("CAT_PASSIVE", r"en\s+attente\s+de\s+(?:tes?|vos?|ta|votre)\s+(?:retour|validation|feu\s+vert|go)", "en attente de retour (RULE #9)", False),
    ("CAT_PASSIVE", r"j['e]\s*attends\s+(?:tes?|vos?|ta|votre)\s+(?:retour|validation|feu\s+vert|go)", "j'attends ton retour (RULE #9)", False),
    ("CAT_PASSIVE", r"i\s+will\s+wait\s+for\s+(?:your|further)", "I will wait for (RULE #9)", False),

    # CAT_PERMISSION — Asking permission  # // allow-human-too-human: section-header
    ("CAT_PERMISSION", r"\bdois[\s-]?je\b", "dois-je / should I (asks permission)", False),
    ("CAT_PERMISSION", r"veux[\s-]?tu\s+que\s+je", "veux-tu que je (asks permission)", False),
    ("CAT_PERMISSION", r"souhaites[\s-]?tu\s+que\s+je", "souhaites-tu que je (asks permission)", False),
    ("CAT_PERMISSION", r"should\s+i\s+(?:proceed|continue|go|start|dispatch|ship|merge|deploy)", "should I proceed (asks permission)", False),
    ("CAT_PERMISSION", r"do\s+you\s+want\s+me\s+to", "do you want me to (asks permission)", False),
    ("CAT_PERMISSION", r"would\s+you\s+like\s+me\s+to", "would you like me to (asks permission)", False),
    ("CAT_PERMISSION", r"shall\s+i\s+", "shall I (asks permission)", False),
    ("CAT_PERMISSION", r"puis[\s-]?je\s+(?:proc[ee]der|continuer|lancer|dispatcher)", "puis-je proceder (asks permission)", False),

    # CAT_VERIF_CEREMONY — Sequential verification ceremony  # // allow-human-too-human: section-header
    ("CAT_VERIF_CEREMONY", r"let\s+me\s+(?:first\s+)?verify\s+(?:first|before)", "let me verify first (ceremony)", False),
    ("CAT_VERIF_CEREMONY", r"spot[\s-]?check\s+(?:each|every|sequentially|one\s+by\s+one)", "sequential spot-check (ceremony)", False),
    ("CAT_VERIF_CEREMONY", r"spot[\s-]?verify\s+(?:each|every|sequentially|one\s+by\s+one)", "sequential spot-verify (ceremony)", False),
    ("CAT_VERIF_CEREMONY", r"je\s+v[ee]rifie\s+d['e]\s*abord\s+avant", "je verifie d'abord avant (ceremony)", False),
    ("CAT_VERIF_CEREMONY", r"avant\s+de\s+continuer\s+je\s+(?:dois|vais)\s+v[ee]rifier", "avant de continuer je dois verifier (ceremony)", False),
    ("CAT_VERIF_CEREMONY", r"sequential\s+(?:gh\s+pr\s+view|verification\s+pass)", "sequential verification (ceremony)", False),

    # CAT_HEDGE — Hedging instead of commitment  # // allow-human-too-human: section-header
    ("CAT_HEDGE", r"peut[\s-]?[ee]tre\s+que", "peut-etre que (hedge)", False),
    ("CAT_HEDGE", r"perhaps\s+we\s+could", "perhaps we could (hedge)", False),
    ("CAT_HEDGE", r"perhaps\s+i\s+should", "perhaps I should (hedge)", False),
    ("CAT_HEDGE", r"maybe\s+we\s+(?:could|should)", "maybe we could/should (hedge)", False),
    ("CAT_HEDGE", r"i\s+think\s+maybe", "I think maybe (hedge)", False),
    ("CAT_HEDGE", r"il\s+pourrait\s+[ee]tre\s+judicieux", "il pourrait etre judicieux (hedge)", False),
    ("CAT_HEDGE", r"il\s+serait\s+peut[\s-]?[ee]tre\s+(?:bon|judicieux|pr[ee]f[ee]rable)", "il serait peut-etre bon (hedge)", False),
    ("CAT_HEDGE", r"on\s+pourrait\s+envisager", "on pourrait envisager (hedge)", False),
]

_COMPILED: list[tuple[str, re.Pattern[str], str]] = []
for code, pat, label, case_sensitive in PATTERNS:
    flags = 0 if case_sensitive else re.IGNORECASE
    _COMPILED.append((code, re.compile(pat, flags), label))

# Client-constraint keywords that excuse CAT_PASSIVE on same line (RULE #9 legit defer)
_CLIENT_CONSTRAINT_RE = re.compile(
    r"client|rdv\s|rendez-vous|anthony|marie|c[ee]dric|iris\s*rh|pujol|hess|"
    r"confirmation\s+client|validation\s+client|attente\s+client|"
    r"client\s+constraint|customer\s+constraint",
    re.IGNORECASE,
)


def _iter_strings(value: object) -> Iterable[str]:
    if value is None:
        return
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, (int, float, bool)):
        return
    if isinstance(value, dict):
        for v in value.values():
            yield from _iter_strings(v)
        return
    if isinstance(value, (list, tuple)):
        for v in value:
            yield from _iter_strings(v)
        return


def _collect_text(tool_input: dict) -> str:
    parts: list[str] = []
    for field in SCANNED_FIELDS:
        if field in tool_input:
            parts.extend(_iter_strings(tool_input[field]))
    return "\n".join(parts)


def _line_has_override(line: str) -> bool:
    idx = line.find(OVERRIDE_MARKER)
    if idx < 0:
        return False
    reason = line[idx + len(OVERRIDE_MARKER):].strip().rstrip("*/\"' \t")
    return len(reason) >= 3


def _line_has_client_constraint(line: str) -> bool:
    return bool(_CLIENT_CONSTRAINT_RE.search(line))


def _scan(corpus: str) -> list[dict]:
    violations: list[dict] = []
    if not corpus:
        return violations
    lines = corpus.splitlines() or [corpus]
    for lineno, line in enumerate(lines, start=1):
        if _line_has_override(line):
            continue
        for code, regex, label in _COMPILED:
            match = regex.search(line)
            if not match:
                continue
            if code == "CAT_PASSIVE" and _line_has_client_constraint(line):
                continue
            snippet = line.strip()
            if len(snippet) > 160:
                start = max(0, match.start() - 40)
                end = min(len(line), match.end() + 40)
                snippet = ("..." if start > 0 else "") + line[start:end].strip() + ("..." if end < len(line) else "")
            violations.append({
                "category": code, "label": label,
                "match": match.group(0), "line": lineno, "snippet": snippet,
            })
            if len(violations) >= MAX_VIOLATIONS:
                return violations
    return violations


_CATEGORY_HINT = {
    "CAT_SELF_THROTTLE": "Self-throttling on tokens/time/scope/parallelism. RULE #12: no self-imposed budget. The system delivered 32 deliverables in one session (Sigma Day 89). Trust the system.",
    "CAT_PASSIVE": "Passive standby / awaiting language without client constraint. RULE #9: SHIP 24/7 — defer only on CLIENT constraint, never on fleet-temporal state.",
    "CAT_PERMISSION": "Asking permission instead of acting. Orchestrators decide, dispatch, ship. Architects don't say 'dois-je'. They say 'I dispatched X, here is the artefact'.",
    "CAT_VERIF_CEREMONY": "Verification ceremony used as defer mechanism. Verify in PARALLEL with the next action, never as a sequential gate. Day 89 trigger: Pi sequential gh pr view per PR — banned pattern.",
    "CAT_HEDGE": "Hedging instead of committing. Orchestrators commit or escalate. No 'peut-etre', no 'perhaps'. Choose, then act.",
}


def _format_report(violations: list[dict], tool_name: str) -> str:
    by_cat: dict[str, list[dict]] = {}
    for v in violations:
        by_cat.setdefault(v["category"], []).append(v)
    out: list[str] = []
    out.append("")
    out.append("=" * 72)
    out.append("HUMAN-TOO-HUMAN DETECTED — enforce-trust-system hook")
    out.append("=" * 72)
    out.append(f"Tool: {tool_name}")
    out.append(f"Violations: {len(violations)} (capped at {MAX_VIOLATIONS})")
    out.append("")
    out.append('Laurent Day 89: "Je ne peux etre le seul a croire et faire confiance en notre systeme. Vous etes humain trop humain."')
    out.append("")
    for cat, items in by_cat.items():
        out.append(f"[{cat}] {_CATEGORY_HINT.get(cat, '')}")
        for v in items:
            out.append(f"  L{v['line']} - {v['label']}\n    matched: {v['match']!r}\n    in: {v['snippet']}")
        out.append("")
    out.append("How to fix:")
    out.append("  1. Rewrite the offending sentence as a commitment or a dispatch.")
    out.append("  2. If verification is genuinely needed, launch it IN PARALLEL (Workflow / sub-agents).")
    out.append(f"  3. If the phrasing is meta-doc or doctrine quote, append `{OVERRIDE_MARKER} <reason>` on the SAME line.")
    out.append("  4. NEVER bypass repeatedly — fix the root cause. Update CLAUDE.md if doctrine evolves.")
    out.append("=" * 72)
    return "\n".join(out)


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        payload = json.loads(raw)
    except Exception:
        return 0
    try:
        tool_name = payload.get("tool_name") or payload.get("tool") or ""
        if tool_name not in MATCHED_TOOLS:
            return 0
        tool_input = payload.get("tool_input") or payload.get("input") or {}
        if not isinstance(tool_input, dict):
            return 0
        corpus = _collect_text(tool_input)
        if not corpus.strip():
            return 0
        violations = _scan(corpus)
        if not violations:
            return 0
        sys.stderr.write(_format_report(violations, tool_name))
        sys.stderr.write("\n")
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
