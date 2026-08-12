# Case 1 — Happy path: list messages for today

## Input
User prompt: "show me today's messages from eta"

## Expected behavior
- Skill detects current orchestrator identity from CLAUDE.md (Step 1).
- Routes to LIST mode (Step 2).
- Resolves filters: sessionDay = current day, from = "eta" (Step 3).
- Calls `mcp__vantage-peers__list_messages({ sessionDay: <currentDay>, from: "eta", limit: 100 })` (Step 4).
- Presents compact table with `messageId | sessionDay | from | to | snippet | readAt` (Step 5).
- Highlights unread rows with `[unread]` flag.

## Hooks pre-satisfied
- `enforce-envelope-cap` — limit defaults to 100, well below 200 max.
- No mutation hooks fire (read-only path).
- No `dispatch-message` chain, so signature footer is not required for this case.
