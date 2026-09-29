#!/usr/bin/env python3
# // allow-no-not-measured: hook-source-documentation
"""
PreToolUse hook: enforces .claude/rules/a-claim-carries-its-command.md.

Every report that closes or advances a task must declare what it did NOT
measure -- even if the answer is "none". A report with no such line reads
as if everything in it were measured, so a prediction and a measurement
arrive in the same confident voice and the reader cannot tell them apart.

Enforced on:
  - mcp__vantage-peers__complete_task
  - mcp__vantage-peers__update_task   (only when status becomes review|done:
                                       that is a report, any other update is not)

A completionNote PASSES when it contains a line matching:
  ^\\s*not_measured:\\s*<value>     // allow-no-not-measured: hook-source-documentation
where <value> is at least one non-whitespace char. The literal value
"none" is accepted -- the discipline is the DECLARATION, not the content.

Opt-out (rare, one-shot): add the override marker
  // allow-no-not-measured: <reason>
in the completionNote. Reason >= 3 chars.

Fail-open on malformed JSON / internal errors.

Mirrors enforce-friction-field.py. The one deliberate difference: the
update_task status gate, copied from enforce-evidence-bound-completion.py,
because without it every in-progress update_task would be blocked.
"""

from __future__ import annotations

import json
import re
import sys

# Matchers this hook fires on
MATCHED_TOOLS = {
    "mcp__vantage-peers__complete_task",
    "mcp__vantage-peers__update_task",
}

# update_task only carries a report when it moves the task to one of these
REPORT_STATUSES = {"review", "done"}

# Trigger string at start of line, any non-empty value after
NOT_MEASURED_LINE_RE = re.compile(  # // allow-no-not-measured: hook-source-documentation
    r"^\s*not_measured:\s*\S",  # // allow-no-not-measured: hook-source-documentation
    re.IGNORECASE | re.MULTILINE,
)

# Override marker: `// allow-no-not-measured: <reason>` with reason >= 3 chars
OVERRIDE_RE = re.compile(  # // allow-no-not-measured: hook-source-documentation
    r"//\s*allow-no-not-measured\s*:\s*\S{3,}",  # // allow-no-not-measured: hook-source-documentation
    re.IGNORECASE,
)


STDERR_MSG = (
    "BLOCKED: a claim carries its command (.claude/rules/a-claim-carries-its-command.md).\n"
    "\n"
    "completionNote is missing the mandatory not_measured declaration.\n"  # // allow-no-not-measured: hook-source-documentation
    "\n"
    "A report that does not say what it left unmeasured reads as if\n"
    "everything in it were measured. A prediction and a measurement then\n"
    "arrive in the same confident voice and the reader cannot tell them apart.\n"
    "\n"
    "FIX: add a line to the completionNote of the form:\n"
    "  not_measured: <what you assert on reasoning, not evidence, or 'none'>\n"  # // allow-no-not-measured: hook-source-documentation
    "\n"
    "Examples:\n"
    "  not_measured: none\n"  # // allow-no-not-measured: hook-source-documentation
    "  not_measured: whether tsc rejects the new identifier (reasoned, never run)\n"  # // allow-no-not-measured: hook-source-documentation
    "  not_measured: the other 48 hosts (only sigma-vps checked, at 334ed7f)\n"  # // allow-no-not-measured: hook-source-documentation
    "  not_measured: prod behaviour after deploy; the read-back was run on dev only\n"  # // allow-no-not-measured: hook-source-documentation
    "\n"
    "Value 'none' is accepted -- the discipline is the DECLARATION, not the\n"
    "content. But 'none' on a report that contains a prediction nobody ran\n"
    "is worse than an absent line: it asserts what the absent line only implies.\n"
    "\n"
    "WHY: a wrong measurement is fixed by re-running a command. A wrong\n"
    "conclusion has to be re-derived by someone who does not know which\n"
    "step was wrong, usually after acting on it. One sentence now, an hour later.\n"
    "\n"
    "Override (rare, one-shot -- fix the source after):\n"
    "  add `// allow-no-not-measured: <reason>` in the note.\n"
)


def _has_not_measured_line(text: str) -> bool:
    if not text:
        return False
    return bool(NOT_MEASURED_LINE_RE.search(text))


def _has_override(text: str) -> bool:
    if not text:
        return False
    return bool(OVERRIDE_RE.search(text))


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

        if tool_name.endswith("update_task"):
            if tool_input.get("status") not in REPORT_STATUSES:
                return 0

        note = tool_input.get("completionNote") or ""
        if not isinstance(note, str):
            return 0

        if _has_override(note):
            return 0

        if _has_not_measured_line(note):
            return 0

        sys.stderr.write(STDERR_MSG)
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
