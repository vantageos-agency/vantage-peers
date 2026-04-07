#!/usr/bin/env python3
"""
Universal orchestrator hook — deploy to EVERY orchestrator (Pi, Tau, Phi, etc.)
PreToolUse on Agent: Two enforcement rules:
1. Every delegation must reference a brief template.
2. Non-blocking agents MUST run in background (run_in_background: true).

Exit 0 = allow
Exit 2 = block
"""
import json
import sys
import os

# Flag file that tells block-orchestrator-code-edits.py a subagent is running
SUBAGENT_FLAG = "/tmp/.claude-subagent-active"

# Agent types that MUST run in background — they don't block the orchestrator's next action
MUST_BACKGROUND = [
    "copywriter",
    "competitor-watcher",
    "data-analyst",
    "email-assistant",
    "meeting-summarizer",
    "proposal-generator",
    "strategy-researcher",
    "product-launcher",
]

# Known brief template markers — if the prompt contains one, a template was used
TEMPLATE_MARKERS = [
    "## TASK",
    "## VISUAL REFERENCE",
    "## FILES",
    "## EXACT CHANGES",
    "## ACCEPTANCE CRITERIA",
    "## DESIGN TOKENS",
    "## AGENT TYPE",
    "brief-ui.md",
    "brief-backend.md",
    "agent-brief-template.md",
]

# Agent types exempt from brief template requirement (non-delegation uses)
EXEMPT_AGENTS = [
    "Explore",
    "Plan",
    "claude-code-guide",
    "statusline-setup",
]

try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    prompt = tool_input.get("prompt", "")
    agent_type = tool_input.get("subagent_type", "")

    # Exempt non-delegation agent types
    if agent_type in EXEMPT_AGENTS:
        sys.exit(0)

    # Enforce background execution for non-blocking agents
    run_in_background = tool_input.get("run_in_background", False)
    if agent_type in MUST_BACKGROUND and not run_in_background:
        print(
            f"BLOCKED: {agent_type} must run in background.\n"
            f"Add run_in_background: true to the Agent call.\n"
            f"Non-blocking agents must never block the orchestrator.",
            file=sys.stderr,
        )
        sys.exit(2)

    # Check if any template marker is present in the prompt
    prompt_lower = prompt.lower()
    for marker in TEMPLATE_MARKERS:
        if marker.lower() in prompt_lower:
            # Set flag so block-orchestrator-code-edits.py allows subagent edits
            try:
                with open(SUBAGENT_FLAG, "w") as f:
                    f.write(str(os.getpid()))
            except Exception:
                pass
            sys.exit(0)

    print(
        f"BLOCKED: Agent brief has no template reference.\n\n"
        f"Follow the orchestration protocol:\n"
        f"1. Read LIBRARY-INDEX.md → find the right specialized agent\n"
        f"2. Find the correct brief template:\n"
        f"   - UI/frontend work → resources/templates/brief-ui.md\n"
        f"   - Backend/API work → resources/templates/brief-backend.md\n"
        f"   - General agent work → resources/templates/agent-brief-template.md\n"
        f"3. Fill the template sections (TASK, FILES, EXACT CHANGES, ACCEPTANCE CRITERIA)\n"
        f"4. THEN delegate\n",
        file=sys.stderr,
    )
    sys.exit(2)

except Exception:
    sys.exit(0)
