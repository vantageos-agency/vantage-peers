---
name: check-messages
description: >
  Check and respond to peer messages from other orchestrators, and (in autonomous mode) also list + pick the next unblocked todo task.
  Use this skill whenever the user says "check messages", "read messages",
  "any messages", "peers", "inbox", "new messages" --
  even if they don't say "check-messages" explicitly.
allowed-tools: mcp__vantage-peers__* Bash Read
metadata:
  version: "4.0.0"
  user-invocable: true
license: Proprietary
---

Check for unread messages in VantagePeers and, if running autonomously, auto-pick the next todo task.

V4 PRINCIPLE: this skill READS and DISPLAYS messages only. It NEVER calls `mark_as_read` and NEVER writes to any `inbox-archive` namespace. `mark_as_read` is an EXPLICIT action the orchestrator (or human) takes AFTER processing — when they have decided what to do (act, respond, ignore). This restores the original semantic that worked for weeks and eliminates the V3 token-burn loop where cron ticks re-fetched ever-growing archives.

## WORKFLOW

**Step 1 — Detect mode (human vs autonomous)**

Check orchestrator identity:
- Read the first 20 lines of `CLAUDE.md` in the current workspace (if available).
- If CLAUDE.md header says "You are Pi" AND current workspace path is `/home/laurentperello/coding/ElPi Corp` (Chromebook) → **HUMAN MODE**.
- Else (any VPS orchestrator: sigma, alpha, lambda, victor, tau, phi, omega, eta, zeta, proxima, verify, scan, etc.) → **AUTONOMOUS MODE**.
- If in doubt, default to autonomous mode.

**Step 2 — Read + display messages (no side effects)**

1. Detect your orchestrator role and instanceId from CLAUDE.md / hostname.
2. Call `mcp__vantage-peers__check_messages` with recipient={role}, recipientInstanceId={instance}.
3. If no messages: continue to Step 3 (autonomous) or say "No new messages" (human).
4. If messages exist:
   - Display each message: `[from] ({fromInstanceId}): {content}`
   - DO NOT call `mark_as_read` from inside this skill.
   - DO NOT call `store_memory` to any `inbox-archive` namespace.
   - For each message that requires a response, respond via `mcp__vantage-peers__send_message`.
   - If a message contains task instructions for you, it should already exist as a VantagePeers task (the emitter is responsible for creating tasks — see memory j575x33mx14k47eevh3vq3gwc185c685). Do not duplicate.

**Step 3 — Process + mark_as_read (explicit, post-decision)**

After you have READ the messages and decided what to do with each (act on it, respond, ignore, or pick up the next task), call `mcp__vantage-peers__mark_as_read` with the receiptIds of every message you have finished processing.

This applies to BOTH human and autonomous modes. The marking is an action you take as the orchestrator, not a side effect of fetching. If you have not finished processing a message (e.g. it depends on an external answer), leave its receipt unread and re-evaluate next cycle.

**Step 4 — Autonomous mode: auto-pick + execute next task**

(Skip this step in human mode.)

After processing messages and marking them read:

1. Call `mcp__vantage-peers__list_tasks` with:
   - `assignedTo=<your role>`
   - `status=todo`
   - No limit (or 50)
2. Also call `list_tasks` with `status=in_progress` and `assignedTo=<role>`. For each task actually done but not closed, call `complete_task` with completionNote (stale task cleanup).
3. From the todo list, sort by `priority` (urgent > high > medium > low) then by `_creationTime` (oldest first). Pick the FIRST task whose dependencies (`dependsOn`) are all `status=done` (or whose `dependsOn` is empty).
4. Call `start_task` with that taskId.
5. Execute the task per its description/brief/VERIFICATION/TESTS blocks.
6. On completion: `complete_task` with a detailed completionNote + re-invoke this skill (`/check-messages`) to chain to the next.

**Step 5 — Fallback if no todo task**

If the todo queue is empty (or all blocked on dependencies):
1. Produce a 3-line standby summary (role, instance, "queue empty, awaiting dispatch" or "blocked on: [list of dependencies]").
2. Do NOT ask Laurent or Pi for next steps. Do NOT invent work.
3. Exit silently. The cron `check_messages every 5 minutes` (or next message trigger) will re-fire and detect new work.

## RULES

- This skill is READ-ONLY on the messages table. It never calls `mark_as_read` and never writes to any `inbox-archive` namespace.
- `mark_as_read` is an EXPLICIT orchestrator action taken AFTER processing a message — not a side effect of reading.
- Respond immediately to any message that asks a question or requests action.
- In autonomous mode: NEVER produce output asking Laurent/Pi what to do next. Pick a task or standby.
- In human mode (Pi Chromebook): display messages, respond if needed, mark_as_read after processing. Do NOT auto-pick tasks (Pi is interactive with Laurent).
- Never duplicate tasks from message content (emitter owns task creation per memory j575x33mx14k47eevh3vq3gwc185c685).

## SELLABLE AS

`vantage-memory` plugin — persistent memory, messaging, and task management for Claude Code agents via MCP. V2 adds autonomous auto-pick for agent swarms. V4 restores the explicit-mark_as_read semantic and removes the V3 inbox-archive over-complexification: cron ticks no longer re-fetch ever-growing archives, eliminating token burn while preserving message delivery reliability.
