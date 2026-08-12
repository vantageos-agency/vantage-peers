# Case 2 — Edge (ambiguous role → `other` fallback)

## Input
User says: "spawn agent to write a one-off bash script that rotates the deploy keys in /etc/vantage and logs the rotation to /var/log/vantage-rotate.log. Success: script idempotent, exits 0 on no-op."

## Expected behavior
- Role keywords are ambiguous (ops/infra; not React, not Convex, not recall/review).
- Skill falls back to role=`other` per Step 1 inference rule.
- Selects template `agent-brief-template.md` (the `other` row of the mapping).
- Task description is >200 chars and carries explicit success criteria → no expansion needed.
- Composes prompt with first line `Template: agent-brief-template.md`; calls `Agent`; returns output verbatim.

## Hooks pre-satisfied
- `enforce-brief-template.py` — passes (canonical template name on line 1).

## Pass criteria
Fallback to `agent-brief-template.md` (not `brief-ui.md`, not `brief-backend.md`). Does not invent a new template name like `brief-ops.md` even though the task is ops-flavored.
