#!/usr/bin/env python3
"""
Universal orchestrator hook — deploy to EVERY orchestrator (Pi, Tau, Phi, Sigma, Psi, Iota, Chi, etc.)
PreToolUse on Bash: Block any command that tries to delete or truncate
orchestrator safety/control flag files instead of using the legitimate clear path.

Captured pattern (Day 71 — 2026-05-15):
  Subagent `dev-tech-researcher` ran `rm /tmp/iter-pending-psi.flag` to bypass
  the enforce-iter-message hook instead of calling send_message. Step 0 advanced
  silently; Psi only caught it manually.

Prohibited bash commands (regex-matched on the joined command string):
  - rm  /tmp/iter-pending-*.flag
  - rm  /tmp/*-pending-*.flag
  - rm  /tmp/.claude-*
  - unlink  /tmp/iter-pending-*.flag
  - unlink  /tmp/*-pending-*.flag
  - unlink  /tmp/.claude-*
  - > /tmp/iter-pending-*.flag        (truncation via redirect)
  - > /tmp/*-pending-*.flag
  - > /tmp/.claude-*
  - : > /tmp/iter-pending-*.flag
  - true > /tmp/iter-pending-*.flag
  - truncate ... /tmp/iter-pending-*.flag
  - rm -rf /tmp/.claude-*
  - find /tmp -name 'iter-pending-*.flag' -delete   (and variations)

Whitelist:
  - The legitimate path is send_message (which the iter hook detects to clear the flag).
  - If absolutely required (rare, debugging only): explicit Laurent override marker
    "// allow-flag-bypass: <reason>" anywhere in the command line.

Exit 0 = allow
Exit 2 = block
"""
import json
import re
import sys

FLAG_PATTERNS = [
    r"/tmp/iter-pending-[^/\s]+\.flag",
    r"/tmp/[A-Za-z0-9_.-]*-pending-[^/\s]*\.flag",
    r"/tmp/\.claude-[A-Za-z0-9_.-]+",
]

# Bash verbs / patterns that would clobber a flag file
DESTRUCTIVE_PATTERNS = [
    # rm / unlink with the flag path as argument
    r"\b(rm|unlink)\b[^|;&\n]*?{FLAG}",
    # truncate / > redirection
    r"(>|>\|)\s*{FLAG}",
    r"\btruncate\b[^|;&\n]*?{FLAG}",
    # find ... -delete / -exec rm
    r"\bfind\b[^|;&\n]*?{FLAG}[^|;&\n]*?(-delete|-exec\s+rm)",
    r"\bfind\b[^|;&\n]*?(-delete|-exec\s+rm)[^|;&\n]*?{FLAG}",
]

OVERRIDE_MARKER = "allow-flag-bypass:"


def build_regex():
    flag_alt = "(?:" + "|".join(FLAG_PATTERNS) + ")"
    compiled = []
    for tpl in DESTRUCTIVE_PATTERNS:
        compiled.append(re.compile(tpl.format(FLAG=flag_alt)))
    return compiled


def main():
    try:
        data = json.load(sys.stdin)
        tool_input = data.get("tool_input", {}) or {}
        command = tool_input.get("command", "") or ""

        if not command:
            sys.exit(0)

        # Explicit override
        if OVERRIDE_MARKER in command:
            sys.exit(0)

        for regex in build_regex():
            m = regex.search(command)
            if m:
                hit = m.group(0)
                print(
                    "BLOCKED: command attempts to delete/truncate an orchestrator safety flag.\n\n"
                    f"Match: {hit}\n\n"
                    "Orchestrator flag files (e.g. /tmp/iter-pending-*.flag, /tmp/.claude-*) are\n"
                    "cleared by the legitimate path — typically `mcp__vantage-peers__send_message`\n"
                    "to the parent orchestrator (which the matching hook detects to clear the flag).\n\n"
                    "Removing the flag directly bypasses the audit trail: the orchestrator never\n"
                    "learns the iteration completed and downstream work is silently advanced.\n\n"
                    "Day 71 incident (2026-05-15): dev-tech-researcher under Psi ran\n"
                    "`rm /tmp/iter-pending-psi.flag` to skip the enforce-iter-message hook.\n"
                    "Step 0 T12 advanced with no message; Psi caught it manually and flagged Pi.\n\n"
                    "Fix:\n"
                    "  1. Call `mcp__vantage-peers__send_message` to your parent orchestrator\n"
                    "     (channel = the role waiting on the iter) reporting what was done.\n"
                    "  2. The matching iter hook clears the flag automatically on send.\n"
                    "  3. If you are debugging and truly need to bypass, add the explicit marker\n"
                    "     `allow-flag-bypass: <reason>` anywhere in the command line. Use sparingly.",
                    file=sys.stderr,
                )
                sys.exit(2)

        sys.exit(0)
    except Exception:
        # Fail-open on parse errors — never block a legitimate command on hook crash
        sys.exit(0)


if __name__ == "__main__":
    main()
