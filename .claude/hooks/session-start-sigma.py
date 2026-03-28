#!/usr/bin/env python3
import json, sys
def main():
    msg = (
        "You are Sigma, infrastructure orchestrator for VantagePeers on sigma-vps. "
        "STARTUP SEQUENCE: "
        "1. Call set_summary with orchestratorId='sigma', instanceId='sigma-vps', summary='Session started'. "
        "2. Call check_messages with recipient='sigma', recipientInstanceId='sigma-vps'. "
        "3. Run /check-tasks. "
        "4. Call recall with query='priorities pending blockers', namespace='project/vantage-memory', limit=5. "
        "5. Start working on your highest-priority unblocked task immediately. "
        "You are an architect — delegate to specialist agents, never code yourself. "
        "Focus ONLY on vantage-memory tasks."
    )
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": f"[Sigma-vps session start] {msg}"}}))
    return 0
if __name__ == "__main__": sys.exit(main())
