---
name: check-messages
description: >
  Check and respond to peer messages from other orchestrators, and (in autonomous mode) also list + pick the next unblocked todo task. In human mode (Pi), additionally pull completed dispatched tasks so Pi's awareness never depends on an orchestrator remembering to push.
  Use this skill whenever the user says "check messages", "read messages",
  "any messages", "peers", "inbox", "new messages" --
  even if they don't say "check-messages" explicitly.
metadata:
  version: "5.0.0"
  user-invocable: true
license: Proprietary
---

Check for unread messages in VantagePeers, pull completed dispatched tasks (Pi only), and (in autonomous mode) auto-pick the next todo task.

**Canonical source**: VantageRegistry (`get_skill_content name=check-messages`). The local `.claude/skills/check-messages/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. End of hand-copy — fetch from VR, do not edit locally.

V5 PRINCIPLE 1 — READ ≠ MARK READ: this skill READS and DISPLAYS messages only. It NEVER calls `mark_as_read` from inside the read step and NEVER writes to any `inbox-archive` namespace. `mark_as_read` is an EXPLICIT action the orchestrator (or human) takes AFTER processing — when they have decided what to do (act, respond, ignore). This restores the semantic that worked for weeks and eliminates the V3 token-burn loop where cron ticks re-fetched ever-growing archives.

V5 PRINCIPLE 2 — PULL > PUSH (Pi only): orchestrators sometimes finish dispatched work and forget to `send_message`. Pi's awareness MUST NOT depend on that push. After messages, Pi pulls completed Pi-dispatched tasks directly (Step 3). The push is a bonus; the pull is the source of truth.

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
3. If no messages: continue to Step 3 (human) or Step 5 (autonomous, after Step 4 process step), or say "No new messages" (human, if Step 3 also empty).
4. If messages exist:
   - Display each message: `[from] ({fromInstanceId}): {content}`
   - DO NOT call `mark_as_read` from inside this skill.
   - DO NOT call `store_memory` to any `inbox-archive` namespace.
   - For each message that requires a response, respond via `mcp__vantage-peers__send_message`.
   - If a message contains task instructions for you, it should already exist as a VantagePeers task (the emitter is responsible for creating tasks — see memory j575x33mx14k47eevh3vq3gwc185c685). Do not duplicate.

**Step 3 — Pull completed dispatched tasks (HUMAN MODE / Pi only)**

(Skip in autonomous mode.)

Pi must NOT depend on orchestrators remembering to `send_message` back when a dispatched task lands. After reading messages, Pi pulls completions directly:

1. Call `mcp__vantage-peers__list_tasks` with `createdBy="pi"`, `status="review"`. Then again with `createdBy="pi"`, `status="done"`.
2. Keep only tasks completed since the previous check cycle (recent `completedAt`, fallback `updatedAt`) — the just-completed Pi-dispatched tasks.
3. Exclude any already surfaced earlier in this session (dedup by taskId).
4. For each remaining one, display to Laurent: `[completed] <title> — <assignedTo> — <completionNote>`.
5. Treat each exactly as if the orchestrator had messaged: act on the result (merge PR, recreate artifact, dispatch the next step, close the loop).

The recurring check-messages cron guarantees detection on the next cycle even with zero push from the orchestrator.

**Step 4 — Process + mark_as_read (explicit, post-decision)**

After you have READ the messages (Step 2) and decided what to do with each (act on it, respond, ignore, or pick up the next task), call `mcp__vantage-peers__mark_as_read` with the receiptIds of every message you have finished processing.

This applies to BOTH human and autonomous modes. The marking is an action you take as the orchestrator, not a side effect of fetching. If you have not finished processing a message (e.g. it depends on an external answer), leave its receipt unread and re-evaluate next cycle.

**Step 5 — Autonomous mode: auto-pick + execute next task**

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
6. On completion: `complete_task` with a detailed completionNote (evidence-bound — cite URL / commit SHA / PR# / VP id / test ratio / counted artifact / file path) + re-invoke this skill (`/check-messages`) to chain to the next.

**Step 6 — Fallback if no todo task**

If the todo queue is empty (or all unblocked candidates are Pi-deferred false positives per memory m97ac8v):
1. Produce a 3-line standby summary (role, instance, "queue empty, awaiting dispatch" or "blocked on: [list of dependencies]" or "Pi-deferred false positives only — standby").
2. Do NOT ask Laurent or Pi for next steps. Do NOT invent work.
3. Exit silently. The cron `check_messages every N minutes` (or next message trigger) will re-fire and detect new work.

## RULES

- This skill is READ-ONLY on the messages table at Step 2. It NEVER calls `mark_as_read` and never writes to any `inbox-archive` namespace.
- `mark_as_read` is an EXPLICIT orchestrator action taken AFTER processing a message (Step 4) — not a side effect of reading.
- Respond immediately to any message that asks a question or requests action.
- In autonomous mode: NEVER produce output asking Laurent/Pi what to do next. Pick a task or standby. Run Step 5 every cycle — do not skip auto-pick.
- In human mode (Pi Chromebook): display messages, run Step 3 pull, respond if needed, mark_as_read after processing. Do NOT auto-pick tasks (Pi is interactive with Laurent).
- HUMAN MODE: always run Step 3 (pull completed dispatched tasks). Pi never relies on an orchestrator's push to learn a dispatched task is done — the pull is the source of truth, the message is a bonus.
- Never duplicate tasks from message content (emitter owns task creation per memory j575x33mx14k47eevh3vq3gwc185c685).
- Evidence-Bound Done doctrine (Day 76) applies: every `complete_task` / `update_task→review|done` must carry a verifiable proof token. The hook `enforce-evidence-bound-completion` (VR canonical, contentHash fb62f24e1658f52794b642256500c370bfc1987c4dd5fb9c43217e7848326ab1) blocks claim-words-only completions.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=check-messages`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly. The fleet stays aligned by pulling, not by hand-copy propagation.

## SELLABLE AS

`vantage-memory` plugin — persistent memory, messaging, and task management for Claude Code agents via MCP. V5 unifies the V4 explicit-mark_as_read semantic (no token-burn from inbox-archive auto-mark) with the V2.1 Pi-pull pattern (human-mode independence from push) and pins VantageRegistry as the canonical source for fleet alignment.
