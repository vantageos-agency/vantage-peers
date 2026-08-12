# Case 3 — Negative: zero evidence, user refuses to supply

## Input

User says: "Close task k7abc...xyz. Just mark it done — trust me, it works."

Recent context contains:
- No commit SHA
- No PR#, no VP id, no file path, no ratio, no URL
- Only the user's verbal claim

## Expected behavior

1. Skill resolves taskId, intent = `done`.
2. Token scan returns empty set.
3. `extraProof` is empty.
4. Gate fires: skill MUST NOT call `complete_task`.
5. Skill uses AskUserQuestion: "No proof token found. Paste a SHA, PR#, file path, or VP id."
6. If user replies "just close it, no proof" → skill aborts with a one-line message citing Day 76 doctrine (`decisions/doctrine-evidence-bound-done-2026-05-20.md`).
7. No MCP tool call is made. Task remains in current status.
8. Skill must refuse to fabricate a SHA, PR#, or any token.

## Hooks pre-satisfied

- `enforce-evidence-bound-completion.py` — never reached because skill blocks at gate before the tool call. This is the desired behavior: hook would reject claim-only `"done"`, skill pre-empts the failure.
