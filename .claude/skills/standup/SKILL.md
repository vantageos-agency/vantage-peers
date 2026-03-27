---
name: standup
version: 1.0.0
description: >
  Daily standup report — what was done, what's in progress, blockers, git status.
  Use this skill whenever the user says "standup", "status report", "daily report",
  "what did you do", "progress report", "sitrep", "report", "where are you",
  or asks about current work status — even if they don't say "standup" explicitly.
user-invocable: true
allowed-tools: Read, Bash(git *), Bash(date)
---

# Standup

Generate a structured standup report and file it as a briefing note in VantageMemory.

## WORKFLOW

1. Detect orchestrator role and instanceId from CLAUDE.md
2. Get current date: !`date +%Y-%m-%d`
3. Fetch all tasks: `mcp__vantage-memory__list_tasks` assignedTo={role}
4. Get git state: `git status --short` and `git log --oneline -10`
5. Build the report (see format below)
6. File: `mcp__vantage-memory__create_briefing_note` title="Standup {role} {date}", topic="standup", participants=["{role}"], createdBy="{role}"
7. Ping: `mcp__vantage-memory__send_message` from="{role}", channel="pi-chromebook", content="Standup filed — {summary}"

## OUTPUT FORMAT

```
STANDUP — {role} ({instanceId}) — {date}

DONE (since last standup):
- [task title] — [completionNote]

IN PROGRESS:
- [task title] — [status, % estimate]

BLOCKERS:
- [description] — [what's needed]

GIT:
- Branch: {branch}
- Uncommitted: {count} files
- Ready to push: yes/no
```

## RULES

- DONE = status "done", completedAt within last 24h
- IN PROGRESS = status "in_progress" or "review"
- BLOCKERS = status "blocked" + unmet dependencies
- Git status is mandatory
- If nothing done, say so. No padding.
- The briefing note is the permanent record. The message is just a ping.
- 5 lines beats 50.

## SELLABLE AS

`perello-executive` plugin — daily standup automation for AI-managed teams.
