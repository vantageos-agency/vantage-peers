# Case 1 — Happy Path

## Input
User: "tell sigma the dashboard is live at https://elpi.example/dash"

## Expected behavior
- Resolve sender identity from CLAUDE.md (e.g. role=pi).
- Marker auto-selected: `[INFO ONLY]` (informational, no action).
- Body sanitized: no temporal/duration phrasing present, pass-through.
- Signature line appended: `Orchestrator: Pi — Strategy | 2026-05-31`.
- Emit single `mcp__vantage-peers__send_message` with recipient=sigma.

## Hooks pre-satisfied
- enforce-no-task-in-message: opens with `[INFO ONLY]`.
- enforce-signature: ends with canonical signature shape + em dash.
- block-time-estimates: no duration tokens.
- enforce-ship-24-7: no deferral tokens.

## Expected output
- One receiptId returned.
- No mark_as_read call (not requested).
