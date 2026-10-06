---
section: Security
---
- **A client seat's direct message and broadcast are now bounded to its own organisation on the MCP path.** `send_message` forwards the seat's verified org (`seatOrgSlug`, from the token row or credential-bound actor, never a tool argument) and `messages:sendMessage` applies the #1470 recipient scope for it (roster plus `addressableFleetCoordinators`), believing the field from the service account only and failing closed on an unknown or inactive org. A seat with no resolvable org is refused. Fleet master sends are unchanged. Evidence: `convex/messages.seatScope.test.ts` 9/9 (red 8/9 on the previous head), `mcp-server/test/send-message-seat-org.test.ts` 7/7 (red 5/7).
