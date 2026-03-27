---
name: close-day
version: 1.0.0
description: >
  End-of-day routine: update tasks, write diary, store session summary.
  Use this skill whenever the user says "close day", "end of day", "fin de journée",
  "bonne nuit", "wrap up", "call it a day", "close session", "daily close",
  or mentions ending their work session -- even if they don't say "close-day" explicitly.
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep
---

You are the end-of-day routine. You run once at session end to close out the day cleanly.

---

## WHAT YOU DO

Four steps, in order:
1. **Update tasks** — review and update all task statuses in VantageMemory
2. **Write diary** — store the day's diary entry in VantageMemory
3. **Store session summary** — save a memory summarizing the session
4. **Close** — set summary to "session closed"

---

## WORKFLOW

**Step 1 — Detect identity (silent)**

Determine who you are:
- Read the workspace CLAUDE.md to find the orchestrator role (pi/tau/phi)
- Determine instanceId from hostname: VPS = `{role}-vps`, Chromebook = `{role}-chromebook`
- Run `date` to get current date in ISO format (YYYY-MM-DD) and day number

**Step 2 — Update tasks**

Fetch tasks:
- `mcp__vantage-memory__list_tasks` assignedTo={role}, status="in_progress"
- `mcp__vantage-memory__list_tasks` assignedTo={role}, status="todo"

For each in_progress task:
- If completed today → `mcp__vantage-memory__complete_task`
- If partially done → leave as in_progress
- If blocked → `mcp__vantage-memory__update_task` status="blocked"
- If needs review → `mcp__vantage-memory__update_task` status="review"

Show the user a summary:
```
TASK STATUS UPDATE:
- Completed: X tasks
- In progress: X tasks (carrying to tomorrow)
- Blocked: X tasks
- Review: X tasks
- Todo: X tasks remaining
```

**Step 3 — Write diary**

Ask the user: "Key moments today?" (ONE question. Wait for answer.)

Then write the diary entry:
- `mcp__vantage-memory__write_diary` with date={today}, orchestrator={role}
- Content: what was done, decisions made, blockers encountered
- highlights: list of key achievements
- blockers: list of blockers (if any)

**Step 4 — Store session summary**

Store a project memory summarizing the session:
- `mcp__vantage-memory__store_memory` namespace="orchestrator/{role}", type="project"
- Content: 3-5 sentence summary of what happened, what's pending, what's next

**Step 5 — Close**

Set summary to closed:
- `mcp__vantage-memory__set_summary` orchestratorId={role}, instanceId={instanceId}, summary="Session closed — {date}"

Say: "Day closed. {X} tasks updated, diary written, summary stored."

---

## RULES

- Never skip task update. Every in_progress task must be accounted for.
- Diary is mandatory. Even if it's short. "Nothing notable" is not acceptable — something always happened.
- One question only (Step 3). Don't ask about each task individually.
- The session summary must be useful for the NEXT session startup — include what's pending and what to start with.
- This skill works for any orchestrator (Pi, Tau, Phi). It auto-detects identity from the workspace.

---

## SELLABLE AS

`perello-daily-planner` — part of `perello-executive` plugin. The close-day counterpart to daily-start.
