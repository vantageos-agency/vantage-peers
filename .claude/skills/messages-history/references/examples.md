# messages-history — Examples

Progressive disclosure: detailed examples extracted from SKILL.md to keep the main body under the 200-line cap.

## List today's messages

```
User: show today's messages

sigma: runs workflow
  Step 1 — identity: sigma
  Step 2 — LIST mode
  Step 3 — sessionDay = current day (e.g. 89)
  Step 4 — list_messages({ sessionDay: 89, limit: 100 })
  Step 5 — present table; highlight from=sigma and unread rows

Output:
  messageId   | day | from   | to         | snippet                                  | readAt
  k7a2x...    | 89  | sigma* | pi         | "patch shipped — PR #562 merged"         | 2026-05-31T14:02Z
  k4f9k...    | 89  | eta    | broadcast  | "[ETA-APPROVED] mcp-server v2.4.1"       | [unread]
  ...
  (* = authored by current orchestrator sigma)
```

## Messages from a specific peer

```
User: messages from eta on day 88

sigma: runs workflow
  Step 3 — sessionDay=88, from=eta
  Step 4 — list_messages({ sessionDay: 88, from: "eta", limit: 100 })
  Step 5 — present table

Output:
  messageId | day | from | to    | snippet                                       | readAt
  k9a1b...  | 88  | eta  | sigma | "review verdict: APPROVED at SHA 1b0d791"     | 2026-05-30T09:14Z
```

## Broadcast read-receipt audit

```
User: who read broadcast k4f9k...

sigma: runs workflow
  Step 2 — BROADCAST-STATUS mode
  Step 6 — list_broadcast_status({ messageId: "k4f9k..." })

Output:
  read    | pi (2026-05-31T14:05Z), sigma (2026-05-31T14:07Z)
  unread  | zeta, eta, theta
```

## Mark receipts read

```
User: mark r_aaa, r_bbb read

sigma: runs workflow
  Step 7 — mark_as_read({ receiptIds: ["r_aaa", "r_bbb"] })

Output:
  Marked 2 receipts as read.
```

## Delete (sender-only)

```
User: delete message k7a2x...

sigma: runs workflow
  Step 8 — gate: from == sigma? yes
           confirm with user → yes
           delete_message({ messageId: "k7a2x...", callerOrchestrator: "sigma" })

Output:
  Deleted message k7a2x... and 3 receipts. Irreversible.
```

## Refuse delete on wrong sender

```
User: delete message k9a1b...

sigma: runs workflow
  Step 8 — gate: from == eta, current == sigma → refuse

Output:
  Cannot delete: message k9a1b... was sent by eta. Only the sender (or system) can delete.
```
