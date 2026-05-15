---
name: check-messages
description: >
  Check and respond to peer messages from other orchestrators, and (in autonomous mode) also list + pick the next unblocked todo task.
  Use this skill whenever the user says "check messages", "read messages",
  "any messages", "peers", "inbox", "new messages" --
  even if they don't say "check-messages" explicitly.
allowed-tools: mcp__vantage-peers__* Bash Read
metadata:
  version: "3.0.0"
  user-invocable: true
license: Proprietary
---

Check for unread messages in VantagePeers and, if running autonomously, auto-pick the next todo task.

## WORKFLOW

**Step 1 — Detect mode (human vs autonomous)**

Check orchestrator identity:
- Read the first 20 lines of `CLAUDE.md` in the current workspace (if available).
- If CLAUDE.md header says "You are Pi" AND current workspace path is `/home/laurentperello/coding/ElPi Corp` (Chromebook) → **HUMAN MODE**.
- Else (any VPS orchestrator: sigma, alpha, lambda, victor, tau, phi, omega, eta, zeta, proxima, verify, scan, etc.) → **AUTONOMOUS MODE**.
- If in doubt, default to autonomous mode.

**Step 2 — Check messages**

1. Detect your orchestrator role and instanceId from CLAUDE.md / hostname.
2. Call `mcp__vantage-peers__check_messages` with recipient={role}, recipientInstanceId={instance}.
3. If no messages: continue to Step 3 (autonomous) or say "No new messages" (human).
4. If messages exist:
   - Display each message: `[from] ({fromInstanceId}): {content}`
   - **HUMAN MODE:** Call `mcp__vantage-peers__mark_as_read` with all receiptIds.
   - **AUTONOMOUS MODE:** For each message, call `mcp__vantage-peers__store_memory` with:
     - `namespace`: `orchestrator/{role}/inbox-archive`
     - `type`: `reference`
     - `content`: `JSON.stringify({ from, fromInstanceId, messageId, channel, createdAt, receiptId, content })`
     - `createdBy`: `{role}`
     - DO NOT call `mark_as_read`. Messages remain unread until a human or `/inbox-clear` skill processes them.
   - For each message that requires a response, respond via `mcp__vantage-peers__send_message`.
   - If a message contains task instructions for you, it should already exist as a VantagePeers task (the emitter is responsible for creating tasks — see memory j575x33mx14k47eevh3vq3gwc185c685). Do not duplicate.

**Step 2.5 — Deduplicate against inbox-archive (autonomous mode only)**

Before re-displaying messages in a subsequent check cycle, filter out messages already archived:

1. For each messageId returned by `check_messages`, call `mcp__vantage-peers__recall` with:
   - `namespace`: `orchestrator/{role}/inbox-archive`
   - `query`: the messageId string
2. If a memory entry already exists with matching messageId in its content, **skip display** — the message is archived and awaiting human review.
3. Only display and archive messages that are genuinely new (not yet in inbox-archive).

This prevents the cron cycle from endlessly re-displaying the same unread messages every 5 minutes.

**Step 3 — Autonomous mode: auto-pick + execute next task**

(Skip this step in human mode.)

After processing messages:

1. Call `mcp__vantage-peers__list_tasks` with:
   - `assignedTo=<your role>`
   - `status=todo`
   - No limit (or 50)
2. Also call `list_tasks` with `status=in_progress` and `assignedTo=<role>`. For each task actually done but not closed, call `complete_task` with completionNote (stale task cleanup).
3. From the todo list, sort by `priority` (urgent > high > medium > low) then by `_creationTime` (oldest first). Pick the FIRST task whose dependencies (`dependsOn`) are all `status=done` (or whose `dependsOn` is empty).
4. Call `start_task` with that taskId.
5. Execute the task per its description/brief/VERIFICATION/TESTS blocks.
6. On completion: `complete_task` with a detailed completionNote + re-invoke this skill (`/check-messages`) to chain to the next.

**Step 4 — Fallback if no todo task**

If the todo queue is empty (or all blocked on dependencies):
1. Produce a 3-line standby summary (role, instance, "queue empty, awaiting dispatch" or "blocked on: [list of dependencies]").
2. Do NOT ask Laurent or Pi for next steps. Do NOT invent work.
3. Exit silently. The cron `check_messages every 5 minutes` (or next message trigger) will re-fire and detect new work.

## RULES

- **HUMAN MODE:** Always mark messages as read after displaying them.
- **AUTONOMOUS MODE:** NEVER mark messages as read. Persist to `orchestrator/{role}/inbox-archive` via `store_memory` instead. Mark-as-read is a human action.
- Respond immediately to any message that asks a question or requests action.
- In autonomous mode: NEVER produce output asking Laurent/Pi what to do next. Pick a task or standby.
- In human mode (Pi Chromebook): display messages, mark read, respond if needed. Do NOT auto-pick tasks (Pi is interactive with Laurent).
- Never duplicate tasks from message content (emitter owns task creation per memory j575x33mx14k47eevh3vq3gwc185c685).

## SELLABLE AS

`vantage-memory` plugin — persistent memory, messaging, and task management for Claude Code agents via MCP. V2 adds autonomous auto-pick for agent swarms. V3 adds durable inbox-archive: autonomous agents persist unread messages to memory, surviving context death and compaction.
