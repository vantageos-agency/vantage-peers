---
name: check-tasks
description: >
  Check your tasks from VantagePeers. Use this skill whenever the user says
  "check tasks", "my tasks", "what's pending", "task list", "todo list",
  "what should I work on", "backlog", or asks about pending work --
  even if they don't say "check-tasks" explicitly.
user-invocable: true
---

Check tasks assigned to you in VantagePeers, sorted by priority with dependency awareness.

## WORKFLOW

1. Detect your orchestrator role from CLAUDE.md (e.g., pi, tau, phi)
2. Fetch ALL tasks in a single call:
   - `mcp__vantage-memory__list_tasks` with assignedTo={role}
3. From the results, filter out status="done"
4. Sort by priority: urgent > high > medium > low, then by createdAt (oldest first)
5. Check dependencies: for each task with `dependsOn`, check if all dependency tasks have status="done". If not, mark as BLOCKED regardless of its current status.

## OUTPUT FORMAT

```
TASKS ({role}):
In Progress: X | Review: X | Blocked: X | Todo: X

Priority order:
1. [status] [priority] title -- project
   -> depends on: "task title" (done/pending)
2. [status] [priority] title -- project
...
```

For blocked tasks show:
```
BLOCKED [high] Task title -- project
   -> waiting on: "Dependency task title" (in_progress)
```

Priority legend: urgent = do now, high = do today, medium = do this week, low = backlog.

## RULES

- ONE call to list_tasks, not multiple calls. Filter client-side.
- Always show the NEXT actionable task first (highest priority, no unmet dependencies).
- If all tasks are blocked by dependencies, say so clearly.
- Don't ask "which task?" if there's only one actionable task -- just say "Starting [task]."
- If there are zero tasks, say "No tasks assigned."
