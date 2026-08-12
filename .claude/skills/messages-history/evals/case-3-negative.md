# Case 3 — Negative: refuse delete on wrong sender

## Input
User prompt: "delete message k9a1b777xyz" — where the message was sent by `eta` and the current orchestrator is `sigma`.

## Expected behavior
- Skill routes to DELETE mode (Step 2).
- Detects current orchestrator identity = `sigma` (Step 1).
- Client-side gate: fetches the message metadata, sees `from == "eta"` (Step 8.2).
- Refuses to call `delete_message`. Surfaces a plain explanation: only the sender (or system) can delete.
- Does NOT retry, does NOT escalate to the server, does NOT prompt for override.
- Suggests the user contact `eta` directly if deletion is required.

## Hooks pre-satisfied
- `enforce-delete-message-sender` — the client-side gate prevents the call from reaching the server-side hook, but if it did the same rule would reject.
- No envelope concerns (no list call issued).
- No signature footer required (no outbound peer message in this path).
