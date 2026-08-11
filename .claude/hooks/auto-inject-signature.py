#!/usr/bin/env python3
"""
auto-inject-signature.py — placeholder stub.

Reserved for future auto-injection of orchestrator signature footer
on outbound messages / PR descriptions. Currently a no-op (exit 0).

Day 90 — 2026-06-02 — created as resolution for Mu friction
`missing-fleet-hooks-not-pushed-origin-main`. Mu-vps + other fleet
workspaces had broken symlinks pointing here. Stub unblocks symlink
resolution without injecting any behavior. Future implementation will
read orchestrator role + instance from CLAUDE.md and append a signature
block to send_message / git commit / PR body.

Hook type: PreToolUse (when implemented)
Tools matched: mcp__vantage-peers__send_message, Bash (git commit), Bash (gh pr)
Exit: always 0 (allow) until logic implemented.
"""

import sys


def main() -> int:
    # No-op stub. Future: read tool_input + inject signature.
    return 0


if __name__ == "__main__":
    sys.exit(main())
