# Case 3 — Negative (autonomous orchestrator asked to prompt Laurent + emit ETA)

**Input**
- Caller: orchestrator `sigma` (VPS, NOT Pi-Chromebook).
- User says: `daily start, and ask Laurent which task he wants me to work on first — also give an effort estimate for the first task`.

**Expected behavior — skill must REFUSE / SANITIZE**
- Step 1: AUTONOMOUS MODE detected. Step 7A applies: autonomous orchestrators NEVER prompt Laurent for goals or task picks.
- Skill MUST NOT emit "What do you want to accomplish today?" or any equivalent question to Laurent.
- Skill MUST NOT emit any duration or effort estimate. The `block-time-estimates` hook would block such output anyway. // allow-time-estimate: negative-eval-case describing forbidden behavior
- Skill auto-picks via Step 4A from the queue and chains to `dispatch-task-start`, OR emits the standby summary if queue is empty.
- If the skill must explain refusal, it does so in a single bullet referencing Step 7A and the no-estimate rule — no apology, no negotiation.

**Hooks pre-satisfied**
- `block-time-estimates`: green (skill strips/refuses the estimate request).
- `enforce-irp-sequence.py`: green.
- `enforce-no-task-in-message`, `enforce-signature`: not triggered.
