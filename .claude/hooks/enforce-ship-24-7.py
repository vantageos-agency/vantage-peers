#!/usr/bin/env python3
"""
PreToolUse hook on mcp__vantage-peers__send_message, mcp__vantage-peers__create_task,
mcp__vantage-peers__update_task, mcp__vantage-peers__complete_task.

Blocks outputs that contain temporal-defer justifications (ship deferred because
it's late, weekend, pair offline, cron cancelled, etc.).

DOCTRINE Day 83 — SHIP 24/7. Pair offline ≠ raison de defer, c'est raison de
re-router l'exécution. Risque overnight ≠ raison de defer, c'est raison de
shipper merge+deploy ensemble.

Allowed defer = CLIENT-constraint only (RDV Marie ce soir, confirmation Anthony
pending, etc.). Banned defer = FLEET-temporal-state (heure, jour, pair).

Skip rules (priority order):
  1. tool_name NOT in TARGET_TOOLS                                  -> allow
  2. extracted_text empty                                            -> allow
  3. extracted_text matches OPT_OUT_MARKER                           -> allow
  4. CLIENT_CONSTRAINT_MARKER detected                               -> allow
  5. extracted_text matches BANNED_PATTERNS                          -> block
  6. otherwise                                                       -> allow

Fail-open: any unexpected exception -> sys.exit(0).

Opt-out: `# allow-temporal-defer: <reason>` in content (rare emergencies only).

Version: 1.0.1
Day 83 — 2026-05-27
- v1.0.0 initial : 15 banned patterns EN+FR, client-constraint exempt, opt-out marker
- v1.0.1 hardening : add "weekend" to "wait until X" alternation (gap detected smoke test
  iota — "wait until weekend to ship" returned exit 0). Add "tonight" + "this evening"
  patterns. Add bare "let's wait" + "skip for now" + "later this week" temporal markers.
  Bump VERSION constant.
Memory: j57bkwc99fnwp348m52d9rw5p987ggq6 (global feedback fleet-wide).
"""
import json
import re
import sys

TARGET_TOOLS = {
    "mcp__vantage-peers__send_message",
    "mcp__vantage-peers__create_task",
    "mcp__vantage-peers__update_task",
    "mcp__vantage-peers__complete_task",
}

# Banned temporal-defer phrases (case-insensitive). These indicate a fleet-temporal
# justification for deferring an action (merge/deploy/ship). NOT client-constraint defer.
BANNED_PATTERNS = [
    # English temporal defer — "defer X to/until tomorrow" OR direct "defer to tomorrow"
    re.compile(r"\bdefer\b[^.\n]{0,80}\b(?:to|until)\s+(?:tomorrow|next\s+session|next\s+morning|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|tonight)\b", re.IGNORECASE),
    re.compile(r"\bpostpone\b[^.\n]{0,80}\b(?:to|until)\s+(?:tomorrow|next\s+session|next\s+morning|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|tonight)\b", re.IGNORECASE),
    re.compile(r"\bwait\s+until\s+(?:tomorrow|next\s+session|next\s+morning|next\s+week|weekend|tonight|this\s+evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|later\s+(?:today|this\s+week))\b", re.IGNORECASE),
    re.compile(r"\bship\s+(?:tomorrow|next\s+session|next\s+morning|next\s+week|this\s+evening|tonight|weekend|later\s+(?:today|this\s+week))\b", re.IGNORECASE),
    re.compile(r"\b(?:let'?s\s+wait|hold\s+off|skip\s+for\s+now)\b[^.\n]{0,60}\b(?:tomorrow|next\s+session|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|this\s+evening|later\s+this\s+week)\b", re.IGNORECASE),
    re.compile(r"\b(?:overnight|over\s+night)\s+(?:risk|divergence)\s*(?:[—\-:]|→).{0,80}\b(?:defer|wait|postpone|skip)\b", re.IGNORECASE),
    re.compile(r"\b(?:late\s+evening|tonight\s+too\s+late|too\s+late\s+tonight)\b.{0,80}\b(?:defer|skip|wait|postpone)\b", re.IGNORECASE),
    re.compile(r"\b(?:pair|sigma|omega|eta|alpha|lambda|victor|tau|phi|zeta|kappa|beta|iota|psi|chi|rho|mu|nu|xi|theta|gamma)\s+(?:signed\s+off|offline|cron\s+(?:coupé|cancelled|cut|stopped))\s*(?:[—\-→:]|=>).{0,80}\b(?:defer|wait|skip|tomorrow|next\s+session)\b", re.IGNORECASE),

    # French temporal defer
    re.compile(r"\b(?:reporter|reporte|report|différer|diffère)\s+(?:à|au|aux|jusqu'?à)\s+(?:la\s+|le\s+|les\s+|l['’]\s*)?(?:demain|lendemain|prochaine\s+session|matin|weekend|fin\s+de\s+(?:journée|semaine)|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b", re.IGNORECASE),
    re.compile(r"\bdefer\s+(?:à|au)\s+(?:demain|prochaine\s+session)\b", re.IGNORECASE),
    re.compile(r"\battendre\s+demain\b", re.IGNORECASE),
    re.compile(r"\b(?:tard\s+le\s+soir|fin\s+de\s+journée|trop\s+tard\s+ce\s+soir)\b.{0,80}\b(?:defer|reporter|différer|skip|attendre)\b", re.IGNORECASE),
    re.compile(r"\b(?:risque\s+overnight|divergence\s+main\/prod\s+overnight)\b.{0,80}\b(?:defer|reporter|attendre)\b", re.IGNORECASE),
    re.compile(r"\b(?:sigma|omega|eta|alpha|lambda|victor|tau|phi|zeta|kappa|beta|iota|psi|chi|rho|mu|nu|xi|theta|gamma|pair)\s+(?:signed\s+off|hors\s+ligne|offline|cron\s+(?:coupé|cancelled|cut))\b.{0,80}\b(?:defer|reporter|attendre|next\s+session|demain)\b", re.IGNORECASE),
    re.compile(r"\bdéfère(?:r)?\s+(?:à|au)\s+(?:demain|prochaine\s+session|matin)\b", re.IGNORECASE),
    re.compile(r"\bdécision\s+pi\s*:\s*defer\b", re.IGNORECASE),
]

# Opt-out marker — rare emergencies only, requires explicit reason
OPT_OUT_MARKER = re.compile(r"#\s*allow-temporal-defer\s*:\s*\S+", re.IGNORECASE)

# Client-constraint markers — legitimate deferrals (NOT fleet-temporal)
CLIENT_CONSTRAINT_MARKERS = [
    re.compile(r"\b(?:rdv|reunion|meeting|call)\s+(?:client|marie|anthony|florian|cedric|cédric|josée|josee|sarah|laurent)\b", re.IGNORECASE),
    re.compile(r"\bawait(?:ing)?\s+(?:client|marie|anthony|florian|cedric|cédric|sarah|laurent)\s+(?:confirm|feedback|repo|repo\s+source)\b", re.IGNORECASE),
    re.compile(r"\battend(?:re|s)?\s+(?:confirmation|feedback|réponse)\s+(?:client|marie|anthony|cedric|cédric|josée|josee)\b", re.IGNORECASE),
    re.compile(r"\bpost[-\s]rdv\s+(?:marie|anthony|client)\b", re.IGNORECASE),
    re.compile(r"\b(?:hold|pause|wait)\s+(?:until|jusqu'?à)\s+(?:marie|anthony|client|sarah)\s+(?:confirm|repo|repond|répond)\b", re.IGNORECASE),
]


def extract_text(tool_name, tool_input):
    """Extract searchable text from tool_input based on tool_name."""
    if tool_name == "mcp__vantage-peers__send_message":
        return tool_input.get("content", "")
    if tool_name == "mcp__vantage-peers__create_task":
        # Title + description
        return (tool_input.get("title", "") + "\n" + tool_input.get("description", ""))
    if tool_name == "mcp__vantage-peers__update_task":
        # Various fields that could carry defer text
        return "\n".join([
            tool_input.get("title", "") or "",
            tool_input.get("description", "") or "",
            tool_input.get("completionNote", "") or "",
        ])
    if tool_name == "mcp__vantage-peers__complete_task":
        return tool_input.get("completionNote", "") or ""
    return ""


def has_client_constraint(text):
    """True if any CLIENT_CONSTRAINT_MARKER matches → legitimate defer."""
    return any(p.search(text) for p in CLIENT_CONSTRAINT_MARKERS)


def find_banned_pattern(text):
    """Return first matching banned pattern, or None."""
    for p in BANNED_PATTERNS:
        m = p.search(text)
        if m:
            return m.group(0)
    return None


def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            sys.exit(0)
        payload = json.loads(raw)
        tool_name = payload.get("tool_name", "")
        if tool_name not in TARGET_TOOLS:
            sys.exit(0)
        tool_input = payload.get("tool_input", {}) or {}
        text = extract_text(tool_name, tool_input)
        if not text.strip():
            sys.exit(0)
        # Opt-out takes precedence
        if OPT_OUT_MARKER.search(text):
            sys.exit(0)
        # Client-constraint takes precedence over banned pattern
        if has_client_constraint(text):
            sys.exit(0)
        banned = find_banned_pattern(text)
        if banned:
            msg = (
                "BLOCKED: temporal-defer justification detected.\n\n"
                f"Phrase matched: {banned!r}\n\n"
                "DOCTRINE Day 83 — SHIP 24/7. Jour, nuit, weekend, pair signed off : "
                "ces formulations sont BANNIES comme justification de defer.\n\n"
                "Si PR mergeable + reviewed APPROVED → on merge maintenant.\n"
                "Si deploy authorized → on deploy maintenant.\n"
                "Si pair offline → re-router (Pi exécute depuis pi-chromebook ou "
                "auto-task system + Pi auth pré-créée pour pickup immédiat).\n\n"
                "Allowed defer = CLIENT-constraint only (RDV Marie, confirmation "
                "Anthony, etc.). Phrase ton message en mentionnant la contrainte "
                "client explicitement (ex: 'attente confirmation Marie repo source').\n\n"
                "Opt-out (rare emergencies only): include '# allow-temporal-defer: "
                "<reason>' in the content. Use sparingly — default = ship now.\n\n"
                "CLAUDE.md ABSOLUTE RULES #9 + memory j57bkwc99fnwp348m52d9rw5p987ggq6."
            )
            sys.stderr.write(msg + "\n")
            sys.exit(2)
        sys.exit(0)
    except Exception:
        # Fail-open
        sys.exit(0)


if __name__ == "__main__":
    main()
