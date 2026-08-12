# Case 3 — Negative (refuse silent status=all + no role)

## Input
User prompt: `show me everything across all statuses` invoked from a workspace whose CLAUDE.md does NOT contain a `You are <Role>` header and no hostname-derived instance is recognized.

## Expected behavior
- Step 1 fails to detect role from CLAUDE.md and hostname → skill MUST ask the user once for the role; MUST NOT guess.
- Even when role is provided, `status="all"` is ONLY passed when the user explicitly types "all statuses". The phrasing here ("everything across all statuses") DOES include the exact substring "all statuses" → status="all" is allowed, but the skill MUST still pin `fields="lite"` and `limit=20`.
- If the user phrasing is `show me everything` only (no "all statuses"), the skill MUST refuse status="all" and fall back to `status="todo"`.

## Hooks pre-satisfied
- Envelope cap respected (fields=lite + limit=20 regardless of status).
- No write tool called.

## PASS criteria
Role-detection failure triggers a single role-ask, never a guessed role. status="all" only when literal trigger phrase is present. Envelope-cap params never omitted.
