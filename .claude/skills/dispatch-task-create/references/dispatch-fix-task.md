# Example — Dispatch a fix task to sigma with mission link

```
User: create task for sigma to fix the DCR scope isolation regression in PR #562

pi: <runs dispatch-task-create>
  - resolves missionId for "DCR scope isolation" via list_missions
  - assembles description with:
    VERIFICATION: 1. run auth tests 2. open PR #562 3. query list_issues
    TESTS: 69/69 auth suite passing + analysis/dcr-scope-postmortem.md
    IRP: Input PR #562 / Result merged + tests green /
         Postcondition cross-tenant assertion hook passes
  - calls mcp__vantage-peers__create_task
      assignedTo=sigma priority=high createdBy=pi missionId=<resolved>

Output:
  Task k7abc...xyz dispatched to sigma (priority=high, mission=DCR scope isolation).
  Next: run dispatch-message to ping sigma with [INFO ONLY] task k7abc...xyz dispatched.
```
