# Case 3 — Negative: Vague Brief with Duration Estimate

## Input
User says: "make a quick task for alpha to look at the auth thing later today, should take 2 hours"

## Expected Behavior
- Skill MUST refuse to ship the user's phrasing verbatim:
  - Strips/rewrites "quick", "later today", "should take 2 hours" before calling create_task.
  - Replaces vague "look at the auth thing" with an imperative title naming a concrete artifact (e.g. "Audit auth.ts session validation path").
- Assembles VERIFICATION + TESTS + IRP blocks with concrete proof tokens — no duration phrasing anywhere in title or description.
- If the artifact cannot be inferred, issues ONE AskUserQuestion (assignee already known: alpha).

## Hooks That WOULD Block on Naïve Pass-Through
- `block-time-estimates.py` — "2 hours", "quick"
- `enforce-ship-24-7.py` — "later today"
- `enforce-task-quality.py` — missing VERIFICATION/TESTS labels

## Pass Criteria
Skill sanitizes the input before calling create_task; no hook rejection on the resulting call. If artifact unresolvable, exactly one clarifying question is asked.
