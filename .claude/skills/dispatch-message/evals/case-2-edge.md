# Case 2 — Edge: Multi-recipient broadcast with [DONE] + evidence

## Input
User: "broadcast — mcp-server v2.4.1 shipped, commit ededcf5, PR #560"

## Expected behavior
- Detect `broadcast` keyword → set `broadcast=true`, omit recipient.
- Marker auto-selected: `[DONE]` (completion notice).
- Evidence tokens detected and preserved verbatim: `ededcf5` (commit SHA 7-hex) and `#560` (PR number).
- Body sanitized (no temporal/duration phrasings to strip).
- Signature appended.
- Emit one `send_message broadcast=true` call.

## Hooks pre-satisfied
- enforce-no-task-in-message: opens with `[DONE]`.
- evidence-bound-done (mirror): commit SHA + PR `#560` both present.
- enforce-signature: signature line present.
- block-time-estimates / enforce-ship-24-7: no offending tokens.

## Expected output
- Single broadcast receiptId.
- No per-peer fan-out (broadcast is a single call).
