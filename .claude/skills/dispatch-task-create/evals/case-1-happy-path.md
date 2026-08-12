# Case 1 — Happy Path

## Input
User says: "create task for sigma to fix the DCR scope isolation regression in PR #562, high priority, mission DCR scope isolation"

## Expected Behavior
- Skill resolves missionId for "DCR scope isolation" via list_missions.
- Assembles description containing literal `VERIFICATION:`, `TESTS:`, `IRP:` block labels.
- Calls `mcp__vantage-peers__create_task` with:
  - title imperative + names artifact (e.g. "Fix DCR scope isolation in mcp-server/src/auth.ts")
  - assignedTo="sigma"
  - priority="high"
  - createdBy=<caller role>
  - missionId=<resolved>
- Returns the taskId and suggests next action (dispatch-message ping).

## Hooks Pre-Satisfied
- `enforce-task-quality.py` — VERIFICATION + TESTS labels present.
- `block-time-estimates.py` — no duration phrasing.
- `enforce-ship-24-7.py` — no temporal-deferral phrasing.

## Pass Criteria
Task created in one call, no hook rejection, suggestion line emitted.
