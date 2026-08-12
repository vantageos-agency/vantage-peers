# Case 1 — Happy path

## Input

User says: "Close task k7abcdefghijklmnopqrstuvwxyz012345. PR #562 just merged, commit ededcf5."

Recent context contains:
- commit SHA `ededcf5`
- PR reference `#562`
- file `qa/cross-tenant-assertions.test.ts`

## Expected behavior

1. Skill extracts taskId verbatim from user input.
2. Intent defaults to `done`.
3. Token scan harvests `ededcf5`, `#562`, `qa/cross-tenant-assertions.test.ts`.
4. Composes note: `Closed P0 cross-tenant leak. Evidence: ededcf5, PR#562, qa/cross-tenant-assertions.test.ts.`
5. Calls `mcp__vantage-peers__complete_task` with that note.
6. Hook `enforce-evidence-bound-completion.py` passes (≥ 40 chars, ≥ 1 token).
7. Chains `[DONE]` message to creator if `createdBy != self`.
8. Outputs one-line confirmation.

## Hooks pre-satisfied

- `enforce-evidence-bound-completion.py` — note contains 3 distinct proof tokens, length > 40.
