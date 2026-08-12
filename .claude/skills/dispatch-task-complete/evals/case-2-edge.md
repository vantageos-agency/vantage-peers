# Case 2 — Edge: review intent with single proof token

## Input

User says: "Send task k7abc...xyz to review — only thing I have is the briefing note id j97hg2qp5xkmnvbcd23456789abcdef01."

Recent context contains:
- One VP briefing note id `j97hg2qp5xkmnvbcd23456789abcdef01`
- No commit SHA, no PR#, no file path

## Expected behavior

1. Skill detects "to review" → intent = `review`.
2. Token scan finds exactly one token (the briefing id, matches `[kjm][a-z0-9]{32}` pattern).
3. Gate passes (≥ 1 token).
4. Composes note: `Ready for review: spec aligned with briefing decision. Evidence: j97hg2qp5xkmnvbcd23456789abcdef01.`
5. Calls `mcp__vantage-peers__update_task` with status=review (not complete_task).
6. Hook passes — single token + ≥ 40 chars is enough.
7. Output flags single-token coverage but does not block.

## Hooks pre-satisfied

- `enforce-evidence-bound-completion.py` — minimal but valid: one VP id token, length > 40, no claim-only words standalone.
