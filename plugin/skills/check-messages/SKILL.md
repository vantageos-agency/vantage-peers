---
name: check-messages
description: >
  Check and respond to peer messages from other orchestrators, and (in autonomous mode) also list + pick the next unblocked todo task.
  Use this skill whenever the user says "check messages", "read messages",
  "any messages", "peers", "inbox", "new messages" --
  even if they don't say "check-messages" explicitly.
allowed-tools: mcp__vantage-peers__* Bash Read
metadata:
  version: "3.2.0"
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

**Step 2.5b — HUMAN MODE only: stale in_progress sweep (task-closure discipline, Day 130)**

Also pull `list_tasks createdBy="pi" status="in_progress"`. For each task where the work is verifiably finished (pull the artifact — PR state, file, message evidence — never the peer's word):

- Send the assignee an immediate closure demand citing the evidence, OR close it yourself as creator with a completionNote citing the evidence and why Pi closed it.
- Client-project tasks (Pujol) MUST close with the decimal-hours time line (`pujol-time-tracking.md`) — if the assignee closes, the demand names that requirement; billing derives from these lines.

An unclosed finished task is unbilled work. Rule: `.claude/rules/task-closure-discipline.md`.

**Step 2.6 — HUMAN MODE only: pull the pending-on-me queue (never infer quiet from an empty inbox)**

An empty inbox is not proof the fleet is quiet — the silence contract makes a peer that is waiting on a Pi decision go silent. Pull the pending-on-me queue every cycle:

1. If the server returns a `pendingOnYou` signal, display it directly — it is the canonical queue.
2. Otherwise (degraded), reconstruct it from state:
   - `list_tasks createdBy="pi" status="blocked"` — tokens / reviews / merges Pi owes.
   - Fleet PRs OPEN + MERGEABLE + reviewer-APPROVED awaiting Pi's merge (from tracked review tasks / prior messages).
3. Each queue item is an ACTION Pi must take (issue a token, merge, create a review task), not a status line. RESOLVE it or explicitly PARK it with a written reason this cycle. A merge waiting more than three cycles is escalated to the operator that same cycle (Merge SLA).
4. If the queue is empty, output nothing — the silence contract holds.

Rule: `.claude/rules/pi-no-passive-block.md`. Degraded queue vs canonical server queue: the server `pendingOnYou` is authoritative; note any divergence.

**Step 3 — AUTONOMOUS MODE only: auto-pick + execute next task**

1. `list_tasks assignedTo=<role> status=todo` (no limit, or 50).
2. `list_tasks assignedTo=<role> status=in_progress` — close any actually done via `complete_task` + completionNote (stale cleanup).
3. Sort by priority (urgent > high > medium > low) then `_creationTime` oldest first. Pick FIRST task whose `dependsOn` are all `done` (or empty).
4. `start_task`. Execute per its `description`/`VERIFICATION`/`TESTS` blocks.
5. On completion: `complete_task` with detailed completionNote. **Chain at most ONCE per cron firing**: re-invoke `/check-messages` only if the completed task plausibly unblocked another (a dependsOn now satisfied). NEVER re-invoke when the todo queue was empty at Step 3.1 — the next cron firing covers it. Self-chaining on an empty queue is the endless-loop failure (Day 127).

**Step 3.5 — AUTONOMOUS MODE only: auto-nudge a stalled wait (the signal travels from both ends)**

A waiting orchestrator never stays mute on a merge/token/review it has been owed for cycles. At each firing, check whether this orchestrator has a task of its own that has awaited an authority's action (a merge, a token, a review) for three or more cycles:

1. If yes, emit ONE `[NUDGE]` to the authority (channel = the authority) citing: the full 32-char taskId, the PR/state, `cyclesWaiting`, and the action expected.
2. Idempotent — exactly one nudge per stage. Do NOT re-emit at the next firing while still at the same stage. Re-arm at the next stage (e.g. re-nudge at six cycles if still waiting), never in a tight loop.
3. This does NOT break the silence contract: with no wait of three or more cycles, emit nothing.
4. Prefer the server `cyclesWaiting` when present; degraded, compute the age from the task's `updatedAt`.

Rule: `.claude/rules/pi-no-passive-block.md` (Merge SLA — the symmetric nudge).

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
- HUMAN: always run Step 2.6. An empty inbox is never proof the fleet is quiet — pull the pending-on-me queue and resolve or park each item (`pi-no-passive-block.md`).
- AUTONOMOUS: run Step 3.5 — a wait of three or more cycles on a merge/token/review emits exactly one `[NUDGE]` to the authority, idempotent per stage. A ready wait is never left mute.
