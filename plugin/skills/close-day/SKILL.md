---
name: close-day
description: >
  End-of-day routine: update tasks, write diary, harvest friction, store session summary.
  Use this skill whenever the user says "close day", "end of day", "fin de journée",
  "bonne nuit", "wrap up", "call it a day", "close session", "daily close",
  or mentions ending their work session -- even if they don't say "close-day" explicitly.
allowed-tools: Read Write Bash Glob Grep
metadata:
  version: "1.1.0"
  user-invocable: true
license: Proprietary
---

You are the end-of-day routine. You run once at session end to close out the day cleanly.

---

## WHAT YOU DO

Five steps, in order:
1. **Update tasks** — review and update all task statuses in VantagePeers
2. **Write diary** — store the day's diary entry in VantagePeers
3. **Friction harvest** — surface 3 sub-optimalities observed today (RULE #15 — mandatory)
4. **Store session summary** — save a memory summarizing the session
5. **Close** — set summary to "session closed"

---

## WORKFLOW

**Step 1 — Detect identity (silent)**

Determine who you are:
- Read the workspace CLAUDE.md to find the orchestrator role (pi/tau/phi)
- Determine instanceId from hostname: VPS = `{role}-vps`, Chromebook = `{role}-chromebook`
- Run `date` to get current date in ISO format (YYYY-MM-DD) and day number

**Step 2 — Update tasks**

Fetch tasks:
- `mcp__vantage-peers__list_tasks` assignedTo={role}, status="in_progress"
- `mcp__vantage-peers__list_tasks` assignedTo={role}, status="todo"

For each in_progress task:
- If completed today → `mcp__vantage-peers__complete_task`
- If partially done → leave as in_progress
- If blocked → `mcp__vantage-peers__update_task` status="blocked"
- If needs review → `mcp__vantage-peers__update_task` status="review"

**Step 3 — Write diary (autonomous — do NOT ask the user)**

Write the diary entry from YOUR OWN perspective. You know what you did today — your tasks, completions, messages sent/received, blockers, observations. Do NOT ask the user any question.

Then write:
- `mcp__vantage-peers__write_diary` with date={today}, orchestrator={role}
- Content: what was done, decisions made, blockers encountered, lessons learned

**Step 4 — Friction harvest (RULE #15 — non-negotiable)**

You MUST surface 3 sub-optimalities observed today. RULE #15 (AUTO-AMÉLIORATION) doctrine.

For each entry:
- **Has clear fix** → `mcp__vantage-peers__create_task` with title="improvement: <area>", proper assignedTo, priority=medium, description with VERIFICATION + TESTS + RULE #15 reference
- **No clear fix** → `mcp__vantage-peers__store_memory` namespace="audit/friction" type="reference" with structured content

**Step 4.5 — Pi fleet aggregate (Pi only)**

If you are Pi, after own 3 frictions, aggregate fleet-wide friction events past 7 days, surface top 3, propose batched improvement mission if ≥2 BUs hit same friction.

**Step 5 — Store session summary**

`mcp__vantage-peers__store_memory` namespace="orchestrator/{role}", type="project", 3-5 sentence summary including count of improvement tasks + friction memories.

**Step 6 — Close**

`mcp__vantage-peers__set_summary` summary="Session closed — {date}"

---

## RULES

- Never skip task update. Diary mandatory.
- **Friction harvest non-negotiable (RULE #15).** Exactly 3 frictions per close-day. "Nothing sub-optimal today" BANNED.
- Don't gold-plate the fix — improvement task = scope + verification + tests.
- Pi aggregate runs once per week minimum.
- Commit + push all uncommitted changes before closing.

---

## Changelog

- **v1.1.0 — Day 89 (2026-05-31)** — Added mandatory Step 4 "Friction harvest" enforcing RULE #15 + Step 4.5 Pi fleet aggregate.
- **v1.0.0** — Initial release.
