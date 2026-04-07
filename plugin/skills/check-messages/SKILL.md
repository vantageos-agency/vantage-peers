---
name: check-messages
description: >
  Check and respond to peer messages from other orchestrators.
  Use this skill whenever the user says "check messages", "read messages",
  "any messages", "peers", "inbox", "new messages" --
  even if they don't say "check-messages" explicitly.
user-invocable: true
---

Check for unread messages in VantagePeers.

## WORKFLOW

1. Detect your orchestrator role and instanceId from CLAUDE.md / hostname
2. Call `mcp__vantage-peers__check_messages` with recipient={role}, recipientInstanceId={instanceId}
3. If no messages: say "No new messages."
4. If messages exist:
   - Display each message: `[from] ({fromInstanceId}): {content}`
   - Call `mcp__vantage-peers__mark_as_read` with all receiptIds
   - For each message that requires a response, respond via `mcp__vantage-peers__send_message`

## OUTPUT FORMAT

```
MESSAGES ({role}):

1. [from] ({fromInstanceId}): {content}
2. [from] ({fromInstanceId}): {content}

Marked {n} messages as read.
```

If a message requires a response, show:
```
-> Replied to {from}: {reply summary}
```

## RULES

- Always mark messages as read after displaying them.
- Respond immediately to any message that asks a question or requests action.
- If a message contains task instructions, create the task in VantagePeers and confirm.
- All role names are lowercase.
