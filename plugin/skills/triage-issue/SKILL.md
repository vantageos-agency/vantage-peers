---
name: triage-issue
version: 1.0.0
description: Use this skill when the user says "triage issue", "triage #NNN", "IRP triage", "process this issue", "create mission for issue", or asks to work through a GitHub issue using the IRP (Issue Resolution Protocol). Handles the full T0-T8 triage flow from KB search through mission creation and task assignment.
user-invocable: true
allowed-tools: Bash(gh issue view *), Bash(gh issue list *), Bash(date)
---

# Triage Issue (IRP T0-T8)

Run a full IRP triage on a GitHub issue: search knowledge base, create a mission, and assign actionable tasks.

---

## WORKFLOW

**T0 — Identify the issue**

If the user provided an issue number, use it. Otherwise ask: "Which issue number should I triage?"

Fetch the issue:
```
gh issue view {number} --json number,title,body,labels,assignees,milestone,state
```

Extract: title, body, labels, current assignees, milestone.

**T1 — KB search (silent)**

Search VantageMemory for relevant prior context:

- `mcp__vantage-peers__recall` query: "{issue title}" namespace: global, limit: 5
- `mcp__vantage-peers__recall` query: "{key labels joined}" namespace: global, limit: 5
- `mcp__vantage-peers__list_memories` namespace: global, type: decision, limit: 10

Summarize any relevant prior decisions or context found. This informs the mission scope.

**T2 — Classify severity**

Assign a severity tier based on issue labels and body:

| Tier | Criteria |
|------|----------|
| P0 | Production down, data loss, security breach |
| P1 | Major feature broken, blocks users |
| P2 | Degraded feature, workaround exists |
| P3 | Minor bug, UX improvement, low impact |
| P4 | Nice-to-have, future consideration |

State the tier with one sentence justification.

**T3 — Identify owner role**

Based on labels and content, identify which VM_ROLE should own this:
- `backend` / `convex` → backend role (e.g. tau)
- `frontend` / `ui` → frontend role
- `docs` / `documentation` → docs role
- `infra` / `hooks` / `plugin` → infra role (e.g. sigma)
- `general` → orchestrator role (e.g. pi)

**T4 — Draft mission**

Create a mission via `mcp__vantage-peers__create_mission`:
- `title`: "#{number}: {issue title}"
- `description`: 2-3 sentence summary of what needs to be done and why
- `priority`: derived from tier (P0→critical, P1→high, P2→medium, P3/P4→low)
- `relatedIssues`: ["{number}"]
- `createdBy`: VM_ROLE environment variable (fallback: "agent")

**T5 — Break down tasks**

Create 2-5 atomic tasks via `mcp__vantage-peers__create_task` for each work item:
- `title`: action-oriented (verb + object, e.g. "Fix null check in convex/tasks.ts")
- `description`: specific enough that any agent can pick it up cold
- `assignedTo`: owner role from T3
- `priority`: same as mission
- `relatedMission`: mission ID from T4

Each task must be independently executable. No "and" tasks.

**T6 — Recall store**

Store triage summary in VantageMemory:

`mcp__vantage-peers__write_memory`:
- `namespace`: global
- `type`: decision
- `title`: "Triage #{number}: {issue title}"
- `content`: tier + owner + mission ID + task count + one-line rationale

**T7 — Send notification**

`mcp__vantage-peers__send_message`:
- `from`: VM_ROLE
- `channel`: "pi-chromebook" (or VM_INSTANCE if set)
- `content`: "Triaged #{number} ({tier}) → mission {missionId}, {taskCount} tasks assigned to {ownerRole}"

**T8 — Report**

Print a triage summary to the user:

```
TRIAGE COMPLETE — #{number}: {title}

Severity:  {tier} — {justification}
Owner:     {ownerRole}
Mission:   {missionId}
Tasks:     {taskCount} created

Tasks:
1. {task title} [{assignedTo}]
2. {task title} [{assignedTo}]
...

KB hits: {count} relevant memories found
```

---

## RULES

- Never skip T1. KB search prevents duplicate work and surfaces relevant prior decisions.
- Never create a task that spans two concerns. Split it.
- Mission title always starts with the issue number (#NNN).
- If the issue is already closed or has a linked PR, note it at T8 and skip T4-T5 unless the user explicitly asks to proceed.
- T6 and T7 are mandatory even for P3/P4 — the record matters.
- If `gh` CLI is unavailable, ask the user to paste the issue body and proceed from T1 with that content.
