#!/usr/bin/env python3
"""
Universal orchestrator hook — deploy to EVERY orchestrator (Pi, Tau, Phi, etc.)
PreToolUse on create_task: Enforce task quality gates.
Every task MUST include VERIFICATION: and TESTS: sections in its description.

Without both sections, the task cannot be verified or tested — it ships blind.

Exit 0 = allow
Exit 2 = block
"""
import json
import sys

REQUIRED_SECTIONS = ["verification:", "tests:"]

try:
    data = json.load(sys.stdin)
    tool_input = data.get("tool_input", {})

    description = tool_input.get("description", "")

    if not description:
        # No description at all — block with the same quality message
        print(
            "BLOCKED: Task has no description.\n\n"
            "Every task MUST include:\n"
            "  VERIFICATION: (what will be checked to confirm the task is done)\n"
            "  TESTS: (how it will be tested — manually, automated, or by review)\n\n"
            "A task with no description cannot be delegated, verified, or closed.",
            file=sys.stderr,
        )
        sys.exit(2)

    description_lower = description.lower()

    missing = [
        section.rstrip(":").upper()
        for section in REQUIRED_SECTIONS
        if section not in description_lower
    ]

    if not missing:
        sys.exit(0)

    missing_str = " and ".join(missing)
    print(
        f"BLOCKED: Task missing {missing_str} section(s).\n\n"
        f"Every task MUST include:\n"
        f"  VERIFICATION: (what will be checked to confirm the task is done)\n"
        f"  TESTS: (how it will be tested — manually, automated, or by review)\n\n"
        f"Add the missing section(s) to the description before creating the task.\n"
        f"Tasks without quality gates cannot be verified or closed with confidence.",
        file=sys.stderr,
    )
    sys.exit(2)

except Exception:
    sys.exit(0)
