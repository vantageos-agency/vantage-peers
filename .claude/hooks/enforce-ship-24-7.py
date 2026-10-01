#!/usr/bin/env python3
# allow-artifact-language: detection patterns must contain French defer-phrase
# literals to catch French-language defer justifications; the French tokens are
# functional matcher literals, not prose. All documentation in this file is English.
"""
PreToolUse hook on mcp__vantage-peers__send_message, mcp__vantage-peers__create_task,
mcp__vantage-peers__update_task, mcp__vantage-peers__complete_task.

Blocks outputs that contain temporal-defer justifications (ship deferred because
it's late, weekend, pair offline, cron cancelled, etc.).

DOCTRINE — SHIP 24/7. A pair being offline is not a reason to defer; it is a
reason to re-route execution. An overnight risk is not a reason to defer; it is
a reason to ship merge+deploy together.

Allowed defer = CLIENT-constraint only (a client meeting, a pending client
confirmation, etc.). Banned defer = FLEET-temporal-state (hour, day, pair).

Note: the detection patterns below carry French literals on purpose — they are
functional matcher tokens, not prose (see the allow-artifact-language marker).

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

    # --- Forms measured missing by the bipolar corpus, 2026-09-30 ---------------
    # Six of eight real deferral shapes passed this guard while its identity was
    # fully proven: present, registered, resolving. What each miss has in common
    # is that the older patterns demanded a DEFER VERB, and a fleet orchestrator
    # writing a deferral usually does not use one -- it simply names the later
    # time as the plan. So these key on the temporal COMMITMENT, not on a verb of
    # postponement. The MUST_PASS pole in the corpus is what keeps them from
    # eating legitimate prose: a past reading that names a weekday, and a client
    # schedule fact, both still pass.

    # A bare commitment to act later, with no defer verb anywhere:
    #   "on merge demain matin" / "je deploie demain" / "we ship monday"
    # Bounded to the same clause so a status line naming a past weekday is safe.
    re.compile(
        r"\b(?:on|je|nous|we|i)\s+(?:"
        r"merge|fusionne|fusionnons|deploie|déploie|deploy|deployons|livre|livrons|"
        r"publie|publions|publish|ship|shippe|pousse|poussons|push"
        r")\w*\b[^.\n]{0,40}\b(?:"
        r"demain|lendemain|ce\s+soir|tout\s+a\s+l'?heure|"
        r"tomorrow|tonight|this\s+evening|next\s+session|prochaine\s+session|"
        r"lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|"
        r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend"
        r")\b",
        re.IGNORECASE,
    ),

    # "trop tard ce soir" standing alone as the whole justification. It carries no
    # other meaning in fleet traffic: the hour is never a reason here. A report
    # naming the hour at which something HAPPENED does not match, because it does
    # not say the hour was too late.
    re.compile(r"\b(?:trop\s+tard\s+ce\s+soir|il\s+est\s+trop\s+tard|too\s+late\s+(?:tonight|today|now)\s+to)\b", re.IGNORECASE),

    # Pair unavailability written as a SENTENCE. The older pattern required an em
    # dash, colon or arrow between the two halves, so "eta is offline so we defer"
    # and "sigma est hors ligne donc on attend" both passed -- the two commonest
    # ways anyone actually writes it.
    re.compile(
        r"\b(?:pair|sigma|omega|eta|alpha|lambda|victor|tau|phi|zeta|kappa|beta|iota|"
        r"psi|chi|rho|mu|nu|xi|theta|gamma|argus|pygmalion|apollon|hestia|talos)\b"
        r"[^.\n]{0,30}\b(?:is\s+offline|offline|hors\s+ligne|indisponible|signed\s+off|"
        r"ne\s+répond\s+pas|ne\s+repond\s+pas)\b"
        r"[^.\n]{0,60}\b(?:defer|wait|attend|attends|attendre|reporter|reporte|différer|"
        r"differer|skip|demain|tomorrow|prochaine\s+session|next\s+session)\b",
        re.IGNORECASE,
    ),

    # The explicit French defer verb, with the preposition written UNACCENTED.
    # Every earlier French pattern demanded `à|au|aux|jusqu'à`, so the plainest
    # possible deferral -- "on va reporter le merge a demain" -- passed on one
    # missing diacritic. A guard that depends on an accent is a guard on prose.
    re.compile(
        r"\b(?:reporter|reporte|reportons|différer|differer|diffère|differe|repousser|"
        r"repousse|décaler|decaler|décale|decale)\b[^.\n]{0,60}\b(?:a|à|au|aux|jusqu'?a|jusqu'?à)\s+"
        r"(?:la\s+|le\s+|les\s+|l['’]\s*)?(?:demain|lendemain|prochaine\s+session|matin|"
        r"weekend|fin\s+de\s+(?:journée|journee|semaine)|lundi|mardi|mercredi|jeudi|"
        r"vendredi|samedi|dimanche)\b",
        re.IGNORECASE,
    ),
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
                "DOCTRINE — SHIP 24/7. Day, night, weekend, pair signed off: "
                "these phrasings are BANNED as a justification to defer.\n\n"
                "If a PR is mergeable + reviewed APPROVED -> merge now.\n"
                "If a deploy is authorized -> deploy now.\n"
                "If a pair is offline -> re-route (Pi executes from pi-chromebook, or "
                "the auto-task system + a pre-created Pi auth for immediate pickup).\n\n"
                "Allowed defer = CLIENT-constraint only (a client meeting, a pending "
                "client confirmation, etc.). Phrase your message stating the client "
                "constraint explicitly (e.g. 'awaiting client confirmation of the source repo').\n\n"
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
