#!/usr/bin/env python3
"""SessionStart hook for Sigma on sigma-vps.

Crons in this environment are session-only: nothing is written to disk and every
job dies with the session. The 3-minute /check-messages cadence therefore has to
be re-registered at the start of every session, and this hook is what says so.

Cadence origin: operator order 2026-09-07, relayed by Pi (message
k97bgerbncx179q8pqnc6w65ws8dy642) and confirmed to Sigma directly.
"""
import json
import sys

CRON_CADENCE = "*/3 * * * *"

def main() -> int:
    msg = (
        "You are Sigma, backend orchestrator for VantagePeers Cloud on sigma-vps. "
        "STARTUP SEQUENCE: "
        "1. Call set_summary with orchestratorId='sigma', instanceId='sigma-vps', "
        "summary='<the day, and what you are driving>'. "
        "2. Call check_messages with recipient='sigma', recipientInstanceId='sigma-vps'. "
        "3. Run /check-tasks. "
        "4. Call recall with query='priorities pending blockers feedback rules', "
        "namespace='project/vantage-peers', limit=5. "
        f"5. Register the message cron by calling CronCreate ONCE with cron='{CRON_CADENCE}', "
        "prompt='/check-messages', recurring=true, durable=true. This environment does NOT "
        "persist crons across restarts, so it MUST be recreated every session — MANDATORY. "
        "Call CronList first: if a /check-messages job already exists at a different cadence, "
        "CronDelete it before creating this one, so the station never runs two. "
        "6. STALE TASK CHECK: call list_tasks with assignedTo='sigma', status='in_progress'. "
        "For each task that is actually done, call complete_task IMMEDIATELY with a "
        "completionNote carrying a proof token. Never carry stale in_progress tasks across sessions. "
        "7. Then start the highest-priority unblocked task. "
        "Backend code changes route through the matched specialist agent via dispatch-subagent "
        "(RULE #29) — never edit convex/ or mcp-server/src/ in the foreground."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": f"[Sigma-vps session start] {msg}",
        }
    }))
    return 0

if __name__ == "__main__":
    sys.exit(main())
