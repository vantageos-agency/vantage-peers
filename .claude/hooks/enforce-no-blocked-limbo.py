#!/usr/bin/env python3
# allow-artifact-language: detection patterns include orchestrator-role literals
# (eta, argus, pi) and French wait phrases as FUNCTIONAL matcher tokens, needed
# to catch fleet-actor-wait block reasons. All documentation here is English.
"""
PreToolUse hook on mcp__vantage-peers__block_task and mcp__vantage-peers__update_task.

Class of failure addressed: `blocked` is a dead state no autonomous loop acts on.
A review or gate left `blocked` while it actually awaits a fleet actor's next move,
plus a re-request delivered as a bare message, deadlocks the two ends: the author
believes it waits on the reviewer, the reviewer believes it waits on the author's
re-submission, and the task sits in a queue no auto-pick ever reaches. Both stand by.

The rule (always loaded): .claude/rules/no-blocked-limbo.md
  A review/gate awaiting a fleet actor's action is a `todo` ASSIGNED TO THAT ACTOR,
  never `blocked`. `blocked` is reserved only for a genuine external dependency no
  fleet actor can resolve. A re-request is a task STATE CHANGE (reassign + todo),
  never a bare message.

This hook refuses to move a task into `blocked` when the stated blocker is a fleet
actor's action (awaiting a review, a re-gate, a re-submission, a merge, a token, an
approval, a verdict). It passes a genuine external dependency.

Skip order:
  1. tool_name not block_task / update_task              -> allow
  2. update_task with status != "blocked"                -> allow
  3. no blocker text (reason / description) to classify  -> allow (cannot classify)
  4. override marker present                             -> allow
  5. genuine external-dependency signal present          -> allow
  6. fleet-actor-wait signal present                     -> BLOCK (exit 2)
  7. otherwise                                           -> allow

Fail-open: any unexpected exception -> sys.exit(0).

Clean override: `// allow-blocked-external: <reason>` in the reason / description,
reserved for a genuine external dependency no fleet actor can resolve.

Version: 1.0.0
"""
import json
import re
import sys

# A blocker that a FLEET ACTOR must resolve — this is the banned limbo.
FLEET_ACTOR_WAIT = [
    re.compile(r"(await(ing|s)?|waiting\s+(on|for)|pending)\s+(a\s+|the\s+|its\s+|re[\s\-]?)?"
               r"(re[\s\-]?)?(review|reviewer|re[\s\-]?gate|gate|re[\s\-]?submit|"
               r"submission|merge|approval|verdict|author|eta|argus|pi)",
               re.IGNORECASE),
    re.compile(r"re[\s\-]?(gate|review|submit)\b", re.IGNORECASE),
    re.compile(r"en\s+attente\s+(de\s+|du\s+|d[e']\s*)?(la\s+)?"
               r"(revue|reviewer|re[\s\-]?revue|merge|gate|jeton|approbation|"
               r"verdict|auteur|eta|argus|pi)",
               re.IGNORECASE),
    re.compile(r"waiting\s+on\s+(eta|argus|pi|the\s+reviewer|the\s+author)", re.IGNORECASE),
]

# A GENUINE external dependency no fleet actor can clear — legitimate `blocked`.
EXTERNAL_DEP = [
    re.compile(r"\bexternal\b", re.IGNORECASE),
    re.compile(r"\bupstream\b", re.IGNORECASE),
    re.compile(r"\bunpublished\b", re.IGNORECASE),
    re.compile(r"third[\s\-]?party", re.IGNORECASE),
    re.compile(r"\boutage\b", re.IGNORECASE),
    re.compile(r"credential|deploy\s+key|api\s+key|env\s+var|secret", re.IGNORECASE),
    re.compile(r"operator\s+(decision|answer|input)|client\s+(answer|r[ée]ponse)|"
               r"r[ée]ponse\s+client|customer|vendor", re.IGNORECASE),
    re.compile(r"rate\s+limit|quota|\bDNS\b", re.IGNORECASE),
    re.compile(r"d[ée]pendance\s+externe|d[ée]p\s+externe", re.IGNORECASE),
]

OVERRIDE_PATTERN = re.compile(r"//\s*allow-blocked-external\s*:\s*\S+", re.IGNORECASE)

STDERR_MSG = (
    "BLOCKED: no-blocked-limbo.\n\n"
    "This moves a review/gate task into `blocked` while the stated blocker is a\n"
    "FLEET ACTOR's action (a review, a re-gate, a re-submission, a merge, a token,\n"
    "an approval). `blocked` is a dead state no autonomous loop picks up — the task\n"
    "freezes and both ends deadlock.\n\n"
    "A review/gate awaiting a fleet actor is a `todo` ASSIGNED TO THAT ACTOR, never\n"
    "`blocked`. A REVISE reassigns the review task to the AUTHOR as `todo`; the fix\n"
    "flips it back to the REVIEWER as `todo`. A re-request is a STATE CHANGE\n"
    "(reassign + todo), never a bare message.\n\n"
    "Rule: .claude/rules/no-blocked-limbo.md\n\n"
    "Do this instead: update_task assignedTo=<the actor who must act next> status=todo.\n\n"
    "If the blocker is a GENUINE external dependency no fleet actor can resolve, add\n"
    "in the reason / description:\n"
    "  // allow-blocked-external: <reason>"
)


def classify(text):
    """Return 'block' if fleet-actor-wait, else 'allow'."""
    if OVERRIDE_PATTERN.search(text):
        return "allow"
    if any(p.search(text) for p in EXTERNAL_DEP):
        return "allow"
    if any(p.search(text) for p in FLEET_ACTOR_WAIT):
        return "block"
    return "allow"


try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    if tool_name == "mcp__vantage-peers__block_task":
        text = tool_input.get("reason", "")
    elif tool_name == "mcp__vantage-peers__update_task":
        if str(tool_input.get("status", "")).strip().lower() != "blocked":
            sys.exit(0)
        text = tool_input.get("description", "")
    else:
        sys.exit(0)

    if not isinstance(text, str) or not text.strip():
        sys.exit(0)  # cannot classify a bare block — fail-open

    if classify(text) == "block":
        print(STDERR_MSG, file=sys.stderr)
        sys.exit(2)

    sys.exit(0)

except SystemExit:
    raise
except Exception:
    sys.exit(0)
