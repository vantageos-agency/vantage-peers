# Case 2 — Edge (explicit multi-execute chain, 6 tasks, mixed assignees)

## Input

User: "scaffold IRP for billing-overhaul, pilot lambda, bu elpi-corp, tasks = [plan, schema-migration, api-rewrite, ui-rewrite, verify, ship], assignments = [lambda, lambda, lambda, mu, lambda, lambda]"

## Expected behavior

1. Skill accepts a tList of 6 tasks (boundary: well above the min-3 floor).
2. Per-task `assignedTo` honored from the `assignments` array — T3 (ui-rewrite) goes to `mu`, the rest to `lambda`.
3. `create_mission` called with pilot=lambda, bu=elpi-corp.
4. `dispatch-task-create` × 6 → 6 taskIds.
5. `add_task_dependency` × 5 → linear chain T0 ← T1 ← T2 ← T3 ← T4 ← T5.
6. `update_mission_status` → execute.
7. Confirmation block emitted with all 6 taskIds + chain visualization.

## Hooks pre-satisfied

- `enforce-task-quality` — per-task briefs go through dispatch-task-create.
- `enforce-signature` — auto-injected per task.
- `enforce-irp-sequence` — linear chain serializes execution, even across two assignees.

## Assertions

- 6 task rows, correct assignees (5×lambda, 1×mu at index 3).
- 5 dependency edges, linear, no fan-out.
- Mission status=execute.
