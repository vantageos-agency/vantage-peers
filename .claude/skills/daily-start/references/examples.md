# daily-start — Example walk-throughs

## Human mode — free-form goals

```
User: daily start
Pi: <runs Step 1–4H>

Output:
  ROUTINES FOR TODAY (Sunday, 2026-05-31):
    Daily:
      - [ ] Check calendar
      - [ ] Check emails (1/3)
      ...
    PENDING FROM LAST SESSION:
      - [ ] Review PR #562 mcp-server release (k7abc..., priority=high)

  Q: What do you want to accomplish today beyond routines?
```

## Human mode — mission bootstrap branch

```
User: daily start
Pi: <Step 1–5H>
Laurent: "Start a mission for the Day 89 multi-tenant DCR rollout."
Pi: <chains to mission-bootstrap with that brief>
```

## Autonomous mode — auto-pick + dispatch

```
sigma: /daily-start
sigma: <Step 1–3, then Step 4A picks task k9xyz...>
sigma: <chains to dispatch-task-start skill with taskId=k9xyz...>
sigma: <executes, complete_task with evidence, re-invokes daily-start>
```

## Autonomous mode — empty queue standby

```
eta: /daily-start
eta: <Step 1–3, todo queue empty>

Output:
  role=eta instance=eta-vps-1
  status=standby
  reason=queue empty awaiting dispatch
```
