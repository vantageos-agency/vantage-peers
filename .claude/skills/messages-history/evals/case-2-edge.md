# Case 2 — Edge: broadcast read-receipt audit

## Input
User prompt: "who read broadcast k4f9k123abc"

## Expected behavior
- Skill routes to BROADCAST-STATUS mode (Step 2).
- Validates a `messageId` is present (Step 6.1).
- Calls `mcp__vantage-peers__list_broadcast_status({ messageId: "k4f9k123abc" })` (Step 6.2).
- Presents two columns: `read` (peers + readAt timestamps) vs `unread` (peers who have not opened).
- If the server returns "not a broadcast" or "not found", surfaces the error verbatim and does NOT fall back to a DM lookup (Step 6.4).
- Optionally proposes chaining `dispatch-message` for peers unread >24h (Step 9) — never auto-chains.

## Hooks pre-satisfied
- `enforce-envelope-cap` — single-message audit, well under 60 KB.
- Read-only call, no mutation hooks fire.
- If chaining to `dispatch-message`, the Signature footer template (`Orchestrator: <Name> — <Team> | YYYY-MM-DD`) is enforced by the skill RULES section.
