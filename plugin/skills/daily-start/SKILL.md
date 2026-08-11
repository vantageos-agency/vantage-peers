---
name: daily-start
description: This skill should be used when the user asks to "start the day", "morning plan", "daily planning", "what's on my plate today", "plan today", "session start", "daily start", or mentions wanting to organize their day or review pending tasks -- even if they don't say "daily-start" explicitly.
metadata:
  version: "3.0.0"
  user-invocable: true
license: Proprietary
---

You open the working day for one orchestrator. You run once at session start.

You are one half of a pair. `close-day` writes a handover under a fixed memory name;
you read that exact name. A handover produced every evening and thrown away every
morning is the cheapest waste in the fleet, and it was the state before this version.

Two modes:
- **Human mode (Pi on the Chromebook)** — reports to the operator and advances the standing objective.
- **Autonomous mode (every other orchestrator)** — never asks a question, picks its own next task.

**Every count you display is derived from a command whose output you paste. None is typed.**

---

## Step 1 — Identity and date (silent)

Read the first 20 lines of `CLAUDE.md` for the orchestrator role. Derive `instanceId` from
the hostname: `{role}-vps` or `{role}-chromebook`. Run `date -I` for the date.

Human mode iff the header says "You are Pi" AND the workspace is the Chromebook Pi one.
Otherwise autonomous. In doubt, autonomous — a silent orchestrator is a safer failure than
one that interrupts a human.

## Step 2 — Register the message cron (autonomous and human alike)

Crons do not survive a restart in this environment, so they are re-registered every session,
here, once:

```
CronCreate cron='*/10 * * * *' prompt='/check-messages' recurring=true durable=true
```

Ten minutes. If a cron with that prompt is already live in this session, do not create a second.

## Step 3 — Read yesterday's handover

```
mcp__vantage-peers__recall query="handover-close-day" namespace="orchestrator/{role}" limit=1
```

`handover-close-day` is the fixed name `close-day` writes under. Read it before anything
else: it carries what was left open, what is expected first today, and any branch that
survived the night with its written reason.

If no handover exists, the previous day did not close. Say so plainly, and treat closing it
as the first work of today.

## Step 4 — Repository state, before any other count

A count read from a tree that is behind the remote is not evidence. Synchronise first, then
measure:

```
git fetch --prune -q origin
git status --porcelain | wc -l          # uncommitted files
git ls-remote --heads origin | wc -l    # remote branches
git for-each-ref --sort=-committerdate --format='%(committerdate:short) %(refname:short)' refs/remotes/origin
```

Read the result against two rules:

- **Uncommitted files must be zero.** They are not. Each one is decided now — committed or
  discarded — before any new work starts. A file left undecided overnight is how a
  workstation reaches a hundred of them.
- **A branch older than yesterday is a day that never closed.** Closing it is the first work
  of today, ahead of the queue. Land what it carries or prove its content is elsewhere; never
  delete on the strength of its name.

Then open the day's branch from a synced `main`. The same branch closes tonight — one branch,
one day, opened here and closed by `close-day`. Never a second one.

Display:

```
REPOSITORY:
- uncommitted files: <N>   (must reach 0 before work starts)
- remote branches: <N>     (any branch older than yesterday = an unclosed day)
- day branch: <name> opened from main @<sha>
```

## Step 5 — Messages before work

```
mcp__vantage-peers__check_messages recipient={role} recipientInstanceId={instanceId}
```

Read the inbox before starting anything. A countermand, a blocker, or a review verdict
waiting there changes what you should pick. Starting a task while an order cancelling it sits
unread is the failure this step exists to prevent. Mark read, answer what asks for an answer.

## Step 6 — Close what the night left open

```
mcp__vantage-peers__list_tasks assignedTo={role} status="in_progress"
```

For each task whose work is actually finished, `complete_task` now, with its real time line.
A task left open overnight loses that line, and on a billable project the line is the invoice.
A genuinely unfinished task stays in progress and is named in today's plan.

## Step 7 — Your own blocked queue

```
mcp__vantage-peers__list_tasks assignedTo={role} status="blocked"
```

For each, name who owes the unblock. Anything waiting three cycles or more gets exactly one
`[NUDGE]` to that authority. Starting new work while your own queue silently waits on someone
is how a delivery dies without anyone noticing.

## Step 8 — Pick the work

```
mcp__vantage-peers__list_tasks assignedTo={role} status="todo"
```

Sort by priority (urgent, high, medium, low), then oldest first. Pick the first task whose
dependencies are all done.

**A task that names no sellable product is not started.** It goes back to its creator with
that question. This is the gate that keeps a day from being spent on the fleet's own tooling.

If no candidate exists, say so in three lines — role, instance, what blocks — and stop. Do not
invent work. Do not ask anyone what to do. The message cron re-fires when work arrives.

**Human mode** additionally: after reporting the state above, advance the standing objective.
Read the current north star from the project memory, identify the next brick, and bring an
arbitrated decision — not a question. The operator gives the vision; you execute and
anticipate. Do not open the day by asking what to do.

## Step 9 — Start

`start_task` on the picked task, write the active-task flag, and begin. No floating between
the plan and the work.

Complete each task as it finishes, with its evidence and its time. Then stop. **Do not loop
back to pick another task on your own** — the message cron is what re-fires the session. A
skill that re-invokes itself runs all night on an empty queue.

---

## RULES

- Every displayed count carries the command that produced it. A typed count is wrong tomorrow.
- Steps 1 to 5 are mandatory in both modes, in this order. The repository state comes before
  the task queue: work started on a dirty tree ends up on a branch nobody closes.
- One branch per day, opened here, closed by `close-day`. Never a second branch, never a
  branch left open across a night without a written reason.
- Never delete a branch on the strength of its name. Prove its content is in `main`, or that
  the catalogue holds it, or that a newer version supersedes it.
- Autonomous mode never asks the operator or the coordinator what to do next. It picks, or it
  stands by. Genuine blockers travel as one message and then standby.
- No writing to `PROGRESS.md`. VantagePeers is the source of truth.
- A task with no named sellable product is not started.

## SELLABLE AS

`perello-daily-planner` — part of the `perello-executive` plugin, paired with `close-day`.

## Changelog

- **v3.0.0** — Pairs with `close-day` through the fixed `handover-close-day` memory name, which
  was written every evening and never read. Adds: message-cron registration at ten minutes;
  inbox before work; repository state measured on a synced tree, with the day's branch opened
  here and an older branch treated as an unclosed day; overnight in-progress closure with its
  time line; own blocked queue with a single nudge; the sellable-product gate at pick time.
  Removes the endless self-chaining loop, which contradicted `check-messages`, the question
  "what do you want to accomplish today", which contradicted proactive mode, and the writes to
  `PROGRESS.md`.
- **v2.0.0** — Two modes, human and autonomous.
