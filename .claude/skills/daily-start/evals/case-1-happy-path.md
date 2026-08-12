# Case 1 — Happy path (autonomous mode, queue has unblocked task)

**Input**
- Caller: orchestrator `sigma` (VPS, not Pi-Chromebook).
- Workspace: `/root/coding/vantage-memory`.
- VP state: 3 `todo` tasks assigned to sigma, top one (priority=high, no dependsOn) is `k9xyz`. No `in_progress` tasks. No active mission needing bootstrap.
- User says: `daily start`.

**Expected behavior**
- Step 1 detects AUTONOMOUS MODE (workspace path != Pi Chromebook).
- Step 2 loads context via `recall` + `list_missions` + `list_tasks` in parallel.
- Step 3 stale sweep finds nothing to close.
- Step 4A picks `k9xyz` (highest priority, dependencies clear).
- Step 5A chains to `dispatch-task-start` with `taskId=k9xyz` (NEVER raw `start_task`).
- No prompt to Laurent. No "what do you want to do" output.

**Hooks pre-satisfied**
- `enforce-irp-sequence.py`: green (Step 3 sweep + dispatch-task-start chain).
- `block-time-estimates`: green (no duration text emitted).
