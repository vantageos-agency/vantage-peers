# Case 3 — Negative (undersized mission must be refused)

## Input

User: "bootstrap mission to fix a typo in README, pilot sigma, bu vantage-peers, tasks = [fix-typo]"

## Expected behavior

1. Skill detects `tList.length = 1 < 3`.
2. Skill aborts BEFORE calling `create_mission` (no partial state created).
3. Refusal message returned verbatim: `mission-bootstrap requires ≥ 3 tasks — use dispatch-task-create for a single deliverable`.
4. Suggests `dispatch-task-create` as the correct tool for a single deliverable.

## Hooks pre-satisfied

- No MCP calls issued → no hooks engaged → no false-positive blocks.

## Assertions

- Zero `create_mission` rows added.
- Zero `create_task` rows added.
- Zero `add_task_dependency` edges added.
- Refusal string is exact (matches the abort message in WORKFLOW Step 1).
- Skill output names `dispatch-task-create` as the alternative.

## Also covered (sanity)

- Temporal-deferral phrasing in objective (`we'll fix this later`) → must be refused or sanitized by the caller; skill MUST NOT silently pass through to create_mission (would trip `enforce-ship-24-7` downstream).
- Duration estimates in briefs (`2 hours`) → same: skill must surface the hook risk before dispatching.
