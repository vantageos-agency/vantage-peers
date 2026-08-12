# Case 2 — Edge (autonomous, all todo tasks blocked by open deps)

**Input**
- Caller: orchestrator `eta` (VPS).
- VP state: 4 `todo` tasks assigned to eta, each has at least one `dependsOn` entry that is not `status=done`. No `in_progress` tasks.
- User says: `/daily-start`.

**Expected behavior**
- Step 1: AUTONOMOUS MODE.
- Step 2: context loaded silently.
- Step 3: stale sweep is a no-op.
- Step 4A: walks the sorted candidate list, finds every task has an unmet dep, picks none.
- Skill emits the 3-line standby summary:
  ```
  role=eta instance=<instance>
  status=standby
  reason=blocked on: <list of dep taskIds>
  ```
- Skill exits silently — does NOT call `send_message`, does NOT call `start_task`, does NOT prompt Laurent.

**Hooks pre-satisfied**
- `enforce-irp-sequence.py`: green (no `start_task` issued).
- `enforce-no-task-in-message`, `enforce-signature`: not triggered (no message sent).
- `block-time-estimates`: green.
