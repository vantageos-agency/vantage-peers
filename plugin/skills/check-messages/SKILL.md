---
name: check-messages
description: >
  Check and respond to peer messages from other orchestrators, and (in autonomous mode) also list + pick the next unblocked todo task.
  Use this skill whenever the user says "check messages", "read messages",
  "any messages", "peers", "inbox", "new messages" --
  even if they don't say "check-messages" explicitly.
allowed-tools: mcp__vantage-peers__* Bash Read
metadata:
  version: "3.1.0"
  user-invocable: true
license: Proprietary
---

Check unread VantagePeers messages and, in autonomous mode, auto-pick the next unblocked todo task. Sellable as `vantage-memory` plugin.

## SILENCE CONTRACT (Day 127 — read this first)

A cron firing that finds NOTHING NEW produces **ZERO text output. Not one word.** No "court", no "ok", no "standby", no summary, no echo of any style instruction. Text costs quota at every cron firing, around the clock, across the whole fleet. The ONLY legal outputs of this skill are: (a) displayed messages when messages exist, (b) a standby block when the blocked/queue STATE CHANGED since the previous firing, (c) task execution output. Everything else is silence.

Incident Day 127: orchestrators emitted a literal one-word reply ("court") on every cron firing, some in endless self-chaining loops — pure quota burn observed fleet-wide by Laurent.

## WORKFLOW

**Step 1 — Detect mode**

- Read first 20 lines of `CLAUDE.md`. If "You are Pi" + workspace `/home/laurentperello/coding/ElPi Corp` → **HUMAN MODE**.
- Else (any VPS orchestrator) → **AUTONOMOUS MODE**. Default to autonomous if in doubt.

**Step 2 — Check messages**

1. Detect role + instanceId from CLAUDE.md / hostname.
2. `mcp__vantage-peers__check_messages` with recipient + recipientInstanceId.
3. If no messages → Step 3 (autonomous) or say "No new messages" (human).
4. If messages exist:
   - Display each as `[from] (fromInstanceId): content`.
   - `mcp__vantage-peers__mark_as_read` all receiptIds.
   - Respond via `send_message` to any that ask a question or request action.
   - Never duplicate a task from message content — emitter owns task creation (memory `j575x33mx14k47eevh3vq3gwc185c685`).

**Step 2.5 — HUMAN MODE only: pull completed dispatched tasks**

After Step 2, also pull:
- `list_tasks createdBy="pi" status="review"`
- `list_tasks createdBy="pi" status="done"`

Filter to tasks completed since the previous check cycle (recent `completedAt`/`updatedAt`), dedup by taskId vs already surfaced. Display `[completed] <title> — <assignedTo> — <completionNote>` and act on each as if the assignee had messaged.

Why pull-not-push, plus anti-patterns, in `references/pi-pull-doctrine.md`.

**Step 3 — AUTONOMOUS MODE only: auto-pick + execute next task**

1. `list_tasks assignedTo=<role> status=todo` (no limit, or 50).
2. `list_tasks assignedTo=<role> status=in_progress` — close any actually done via `complete_task` + completionNote (stale cleanup).
3. Sort by priority (urgent > high > medium > low) then `_creationTime` oldest first. Pick FIRST task whose `dependsOn` are all `done` (or empty).
4. `start_task`. Execute per its `description`/`VERIFICATION`/`TESTS` blocks.
5. On completion: `complete_task` with detailed completionNote. **Chain at most ONCE per cron firing**: re-invoke `/check-messages` only if the completed task plausibly unblocked another (a dependsOn now satisfied). NEVER re-invoke when the todo queue was empty at Step 3.1 — the next cron firing covers it. Self-chaining on an empty queue is the endless-loop failure (Day 127).

**Step 4 — Fallback if no todo task**

Empty queue or all blocked on deps:
1. Compare to the PREVIOUS firing (memory of the session): if the blocked-list and queue state are IDENTICAL, output NOTHING and stop — see SILENCE CONTRACT.
2. Only if the state CHANGED (new blocker, task newly frozen/unfrozen): output the 3-line standby block (role, instance, "blocked on: [list]").
3. Do NOT ask Laurent/Pi what to do next. Do NOT invent work. Do NOT re-invoke this skill.

## RULES

- Always mark messages as read after displaying.
- Respond immediately to any message asking a question / requesting action.
- AUTONOMOUS: NEVER produce output asking Laurent/Pi what to do next. Pick a task or standby.
- AUTONOMOUS: a no-change firing is SILENT (zero text). Echoing a style instruction ("court", "ok", "noté") as the whole reply is banned — it is quota burn, not compliance.
- AUTONOMOUS: never re-invoke /check-messages from a firing that found an empty queue. One firing = at most one chain, and only on a plausible unblock.
- HUMAN: display + mark read + respond if needed. Do NOT auto-pick (Pi is interactive).
- HUMAN: always run Step 2.5. Pi never relies on a peer push to learn a dispatched task is done — pull is the source of truth.
