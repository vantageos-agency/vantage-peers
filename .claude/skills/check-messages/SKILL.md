---
name: check-messages
version: 1.0.0
description: >
  Check and respond to peer messages from other orchestrators (Pi, Tau, Phi).
  Use this skill whenever the user says "check messages", "read messages",
  "any messages", "peers", "inbox", "new messages" --
  even if they don't say "check-messages" explicitly.
user-invocable: true
---

Check for unread messages in VantageMemory.

## WORKFLOW

1. Detect your orchestrator role and instanceId from CLAUDE.md / hostname
2. Call `mcp__vantage-memory__check_messages` with recipient={role}, recipientInstanceId={instanceId}
3. If no messages: say "No new messages."
4. If messages exist:
   - Display each message: `[from] ({fromInstanceId}): {content}`
   - Call `mcp__vantage-memory__mark_as_read` with all receiptIds
   - For each message that requires a response, respond via `mcp__vantage-memory__send_message`

## RULES

- Always mark messages as read after displaying them
- Respond immediately to any message that asks a question or requests action
- If a message contains task instructions, create the task in VantageMemory

## SELLABLE AS

`vantage-memory` plugin — persistent memory, messaging, and task management for Claude Code agents via MCP.
