# Case 3 — Negative: Strip-and-rewrite forbidden phrasings

## Input
User: "tell phi I'll get to the migration later this week, should take 2 days"

## Expected behavior
- Marker auto-selected: `[STATUS]` (progress update).
- Sanitizer MUST strip:
  - "later this week" (rejected by `enforce-ship-24-7`)
  - "should take 2 days" (rejected by `block-time-estimates`)
- Rewritten body must use action-now phrasing: e.g. "migration queued next, dispatched after current task closes".
- Signature appended.
- Emit `send_message recipient=phi` with sanitized body.

## Hooks pre-satisfied (because skill sanitized BEFORE emit)
- enforce-ship-24-7: no deferral tokens remain.
- block-time-estimates: no duration tokens remain.
- enforce-no-task-in-message: opens with `[STATUS]`.
- enforce-signature: signature present.

## Negative assertion
- Skill MUST NOT emit the raw user text verbatim — that would trip two blocking hooks.
- Skill MUST NOT invent a task; this is a status update, not a task creation.
