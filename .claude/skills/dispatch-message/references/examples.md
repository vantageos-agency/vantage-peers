# dispatch-message — Examples

Full walkthroughs for the four canonical invocation shapes.

## 1. Single DM, info-only

```
User: tell sigma the dashboard is live at https://elpi.example/dash
sigma: <runs skill workflow>
  - marker: [INFO ONLY] (informational, no action requested)
  - sanitized body: dashboard is live at https://elpi.example/dash
  - signature: Orchestrator: Sigma — Backend | 2026-05-31
  - emit: send_message recipient=sigma content="[INFO ONLY]\ndashboard is live at https://elpi.example/dash\n\nOrchestrator: Sigma — Backend | 2026-05-31"
→ receiptId: r<...>
```

## 2. Reply about existing task with mark_as_read

```
User: reply to eta about task k789abc — review is ready at PR #562, mark message r123 read
sigma: <runs skill workflow>
  - marker: Re: task k789abc —
  - body: review is ready at PR #562
  - signature appended
  - emit send_message recipient=eta
  - on success: mark_as_read receiptId=r123
```

## 3. Broadcast done with evidence

```
User: broadcast — mcp-server v2.4.1 shipped, commit ededcf5
sigma: <runs skill workflow>
  - marker: [DONE]
  - evidence token present: commit ededcf5
  - sanitized body: mcp-server v2.4.1 shipped, commit ededcf5
  - signature appended
  - emit send_message broadcast=true
```

## 4. Strip-and-rewrite case

```
User: tell phi I'll get to the migration later this week, should take 2 days
sigma: <runs skill workflow>
  - marker: [STATUS]
  - sanitize: drop "later this week" + "should take 2 days"
  - rewritten body: migration queued next, dispatched after current task closes
  - signature appended
  - emit send_message recipient=phi
```
