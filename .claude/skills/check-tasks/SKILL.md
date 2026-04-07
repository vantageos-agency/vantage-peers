---
name: check-tasks
version: 1.0.0
description: >
  Check your tasks from VantageMemory. Use this skill whenever the user says
  "check tasks", "my tasks", "what's pending", "task list", "todo list",
  "what should I work on", "backlog", or asks about pending work --
  even if they don't say "check-tasks" explicitly.
user-invocable: true
---

Check tasks assigned to you in VantageMemory, sorted by priority with dependency awareness.

## WORKFLOW

1. Detect your orchestrator role from CLAUDE.md (pi/tau/phi) and instanceId from the session hook or hostname (e.g. pi-vps-vm, pi-chromebook)
2. Fetch ALL non-done tasks in a single call:
   - `mcp__vantage-peers__list_tasks` with assignedTo={role}
   - NOTE: If you know your instanceId, also check for instance-specific tasks:
     `mcp__vantage-peers__list_tasks` with assignedToInstance={instanceId}
     Merge both result sets, deduplicating by task _id
3. From the results, filter out status="done"
4. Sort by priority: urgent > high > medium > low, then by createdAt (oldest first)
5. Check dependencies: for each task with `dependsOn`, check if all dependency tasks have status="done". If not, mark as BLOCKED (dependency) regardless of its current status.

Present as a sorted list:

```
TASKS ({role}):
In Progress: X | Review: X | Blocked: X | Todo: X

Priority order:
1. [status] [priority] title — project
   ↳ depends on: "task title" (done/pending)
2. [status] [priority] title — project
...
```

Priority legend: urgent = do now, high = do today, medium = do this week, low = backlog.

If a task is blocked by dependencies, show:
```
[blocked-dep] [high] Task title — project
   ↳ waiting on: "Dependency task title" (in_progress)
```

## RULES

- ONE call to list_tasks, not 4 separate calls. Filter client-side.
- Always show the NEXT actionable task first (highest priority, no unmet dependencies).
- If all tasks are blocked by dependencies, say so clearly.
- Don't ask "which task?" if there's only one actionable task — just say "Starting [task]."

## SELLABLE AS

`vantage-peers` plugin — persistent memory, messaging, and task management for Claude Code agents via MCP.
