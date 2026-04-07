---
name: write-diary
version: 1.0.0
description: Use this skill when the user says "write diary", "diary entry", "log my day", "BIP diary", "end of day entry", "journal entry", or asks to record what happened today. Triggers on any request to capture daily reflections or session events in VantageMemory.
user-invocable: true
allowed-tools: Bash(date)
---

# Write Diary

Write a structured diary entry for the current session and persist it to VantageMemory via `mcp__vantage-peers__write_diary`.

---

## WORKFLOW

**Step 1 — Get context (silent)**

Run `date +%Y-%m-%d` to get today's date.

Read `PROGRESS.md` if it exists — use the current session's completed tasks as a reference for the entry.

**Step 2 — Prompt for key events**

Ask the user one question:

> "What were the key events, decisions, or outcomes from today's session? (bullet points or freeform — I'll structure it)"

Wait for the response. Do not ask follow-up questions — structure whatever they give you.

**Step 3 — Structure the entry**

Format the diary entry as:

```
## Diary — {date}

### Done
- [completed task or outcome]
- [completed task or outcome]

### Decisions
- [any significant decision made today]

### Blockers / Carryover
- [anything blocked or carrying to next session]

### Notes
- [any other observations, learnings, or context worth preserving]
```

If the user provided minimal input, infer from PROGRESS.md. If PROGRESS.md is unavailable, write what was provided.

**Step 4 — Write to VantageMemory**

Call `mcp__vantage-peers__write_diary` with:
- `date`: today's date (YYYY-MM-DD)
- `content`: the structured entry text
- `author`: VM_ROLE environment variable (fallback: "agent")

**Step 5 — Confirm**

Print: "Diary entry written for {date}."

Do not repeat the full entry back to the user unless they ask.

---

## RULES

- One question only (Step 2). Do not interview the user.
- Always write the entry even if input is sparse — a minimal entry is better than none.
- The diary is for future recall, not a report to the user. Write for `mcp__vantage-peers__recall`, not for reading now.
- Never skip Step 4. The whole point is persistence.
- Date format is always YYYY-MM-DD.
