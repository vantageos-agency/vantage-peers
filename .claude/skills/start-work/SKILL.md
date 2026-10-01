---
name: start-work
description: >
  Guarantee a VantagePeers task exists and is really started before any work
  action (edit, mutating command, sub-agent build), and record real elapsed
  time on completion. Use this skill whenever you are about to start working —
  "start work", "begin task", "pick up task", "I'm going to edit/build/deploy" —
  or when the enforce-work-under-task hook blocks an action for lack of an
  active task.
allowed-tools: mcp__vantage-peers__* Bash Read
metadata:
  version: "2.0.0"
  user-invocable: true
license: Proprietary
---

Ensure work happens under a real task with a real duration. Companion to the
`enforce-work-under-task.py` gate and the `no-work-without-task` doctrine.

## Why

No orchestrator does substantive work without a task. Editing files, running a
mutating command, merging, deploying, or dispatching a sub-agent to build each
happen under a task in `in_progress`, owned by the actor, with its `project`
set. A message never carries the work — messages coordinate; the task carries
the instruction, scope, and acceptance criteria. And the recorded duration must
be real elapsed working time, never a typed number: an instant start->complete
records fiction.

The gate `enforce-work-under-task.py` blocks a work action when the active-task
flag is absent. This skill writes and clears that flag around real work.

## WORKFLOW

**Step 1 — Ensure the task exists**

- If a task already covers this work: `list_tasks assignedTo=<role> status=["todo","in_progress"]`, pick it, note its full 32-char `taskId`.
- If none exists: create it (via `dispatch-task-create`) with `project` set and the VERIFICATION + TESTS blocks. The scope lives in the task, not in a message.

**Step 2 — Really start the task**

1. `mcp__vantage-peers__start_task taskId=<full 32-char id>` — this stamps the real `startedAt` server-side. Read it back with `get_task` (milliseconds).
2. Write the flag with the script, never by hand:

   ```bash
   python3 .claude/scripts/active_task_flag.py start <taskId> <startedAtMs>
   ```

   The script asks the guard for the path and the station key, so the writer and the
   reader can never disagree. A hand-written path is how most stations ended up
   writing a file the guard never reads, and then reaching for an escape marker.

**Step 3 — Do the work**

Edit, run mutating commands, dispatch sub-agents — all pass the gate because the flag exists where the gate reads it. Keep the work inside the task's scope.

**Step 4 — Complete with a real duration**

1. `python3 .claude/scripts/active_task_flag.py elapsed` prints the real elapsed minutes.
2. `complete_task` when the work ends. The server derives `actualMinutes` from the recorded segments; on a billable project the time line quotes that server value, never a typed figure.
3. `python3 .claude/scripts/active_task_flag.py clear` removes the flag, so the next work action needs its own task.

## RULES

- No work action without the flag present — the gate enforces it; this skill is the sanctioned way to satisfy it, not to bypass it.
- `start_task` immediately followed by `complete_task` with no real work between is banned — it fabricates the duration. If no real work happened, return the task to `todo`, do not complete it.
- Only a task whose own title is an authorization token (`[<NAME>-AUTHORIZED]`) may close without a flag. Tagging a work task or a closing note `[META]`/`[ADMIN]` to pass the gate is a workaround around a guard, and is banned.
- If the gate refuses you, stop and send `[BLOCKER]` to pi with the refusal text. Never route around it.
- The recorded duration is derived from real timestamps or honestly logged, never typed to look plausible.
- Billable projects additionally carry the client time line (see the `billable-time-tracking` doctrine); this skill is the general case beneath it.

## Cross-ref

- `no-work-without-task.md` — the doctrine.
- `enforce-work-under-task.py` — the reactive gate (GATE A blocks work with no flag; GATE B refuses an instant or untimed completion).
- `billable-time-tracking.md` — client work invoiced on time per task.
- `dispatch-task-create` — task creation with the required quality blocks.
