# Case 1 — Happy Path (default IRP skeleton)

## Input

User: "bootstrap mission for VP plugin Phase A skill bodies, pilot sigma, bu vantage-peers, objective: author 11 SKILL.md bodies in VR, proof = 11 upsert_skill_content commits + PR#NNN merged"

## Expected behavior

1. Skill collects: name="VP plugin Phase A skill bodies", pilot=sigma, bu=vantage-peers, objective with proof token (PR#NNN).
2. tList defaults to canonical IRP T0..T3 (plan, execute, verify, ship).
3. `create_mission` called once → returns missionId.
4. `dispatch-task-create` invoked 4 times in order → 4 taskIds captured.
5. `add_task_dependency` called 3 times → linear chain T0 ← T1 ← T2 ← T3.
6. `update_mission_status` called once with status=execute.
7. Final confirmation block emitted with missionId + 4 taskIds + chain visualization.

## Hooks pre-satisfied

- `enforce-task-quality` — VERIFICATION + TESTS blocks injected by dispatch-task-create.
- `enforce-signature` — signature injected by dispatch-task-create.
- `enforce-ship-24-7` — objective contains no temporal-deferral phrasing.
- `block-time-estimates` — objective expresses scope by deliverable count (11), not duration.
- `enforce-irp-sequence` — pickup deferred to pilot's check-messages cycle.

## Assertions

- mission row exists in VP, status=execute.
- 4 task rows exist, all linked to missionId.
- Dependency edges: T1→T0, T2→T1, T3→T2.
- No `start_task` call issued by the skill itself.
