---
name: daily-start
description: This skill should be used when the user asks to "start the day", "morning plan", "daily planning", "what's on my plate today", "plan today", "session start", "daily start", or mentions wanting to organize their day or review pending tasks -- even if they don't say "daily-start" explicitly.
metadata:
  version: "3.3.0"
  user-invocable: true
license: Proprietary
---

You open the working day for one orchestrator. You run once at session start.

You are one half of a pair. `close-day` leaves one index behind it; you read that index and
follow its ids. A handover produced every evening and never read the next morning is the
cheapest waste in the fleet, and reading the WRONG one is worse — it looks like a normal day.

Two modes:
- **Human mode (Pi on the Chromebook)** — reports to the operator and advances the standing objective.
- **Autonomous mode (every other orchestrator)** — chooses its own next task, proposes it to pi,
  and waits for a confirmation or a redirection before starting.

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

## Step 3 — Open yesterday's index, then follow its ids

`close-day` leaves one index in a field dedicated to it — `dynamic.endOfDayIndex` on your own peer
record. It is a single always-current value, so it is READ, never searched:

```
mcp__vantage-peers__get_profile orchestratorId={role} instanceId={instanceId}
                                        # read dynamic.endOfDayIndex
```

**Read `dynamic.endOfDayIndex`, never `dynamic.currentTask`.** `currentTask` carries only the live,
volatile status, and it is overwritten by the first `set_summary` of the day — including this
station's own, later this session. The index survives precisely because it lives in its own field.
Reading the wrong one returns whatever was written most recently, which looks like an index and is
not.

Resolution takes the instance, not the role alone: a profile lookup by role with no instance can
return nothing while the record exists.

The index carries a date, a day number, and the full id of everything the previous session
wrote: the handover, the diary, the friction memories, any briefing note.

**Check the date before you trust the content.** Compare the date in the index to the last
working day you expect. If it does not match, say so out loud and name both dates — an index
three days old may be perfectly correct after a weekend, but that is a fact to state, never one
to assume.

Then open what you need by id, starting with the handover:

```
mcp__vantage-peers__get_memory <handover id from the index>
```

The handover carries what was left open, what is expected first today, and any branch that
survived the night with its written reason. The diary and the friction ids are there when you
need the fuller story; you are not obliged to read them.

**Never reach for `recall` here.** It ranks by resemblance, and every handover ever written
resembles every other — it will hand you an arbitrary one, sometimes months old, and nothing
will look wrong. That failure cost a morning: the index exists so the question cannot be asked.

If the index is missing, or carries no handover id, the previous day did not close. Say so
plainly and treat closing it as the first work of today.

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

## Step 8 — Choose the work, and propose it

```
mcp__vantage-peers__list_tasks assignedTo={role} status="todo"
```

Sort by priority (urgent, high, medium, low), then oldest first. Choose the first task whose
dependencies are all done.

**A task that names no sellable product is not chosen.** It goes back to its creator with that
question. This is the gate that keeps a day from being spent on the fleet's own tooling.

You choose — you do not ask what to do. But you do not start yet: the choice is proposed to pi,
who confirms it or redirects you to a different priority. Pi sees the whole fleet; a queue
sorted correctly on one station can still be the wrong thing to do that morning.

If no candidate exists, say so in three lines — role, instance, what blocks — and stop. Do not
invent work. The message cron re-fires when work arrives.

**Human mode** additionally: after reporting the state above, advance the standing objective.
Read the current north star from the project memory, identify the next brick, and bring an
arbitrated decision — not a question. The operator gives the vision; you execute and
anticipate. Do not open the day by asking what to do.

## Step 9 — Report that you are up, and name the task you propose

Autonomous mode. Pi does not know your station is running until you say so.

```
mcp__vantage-peers__send_message
  from="{role}" fromInstanceId="{instanceId}" channel="pi"
  content="[STATUS] day <N> open — <date>
evidence:  index read: <date it carried> | uncommitted: <N> | remote branches: <N> | day branch: <name>
finding:   <what the handover left open, in one sentence> | queue: <N> todo, <N> blocked
action:    I propose to start <full 32-char task id> — <title>. Confirm or redirect.
next:      <what follows that task, or: standby>

Orchestrator: <Name> — <Team> | <date>"
```

Every count in that message is derived, never typed. The task id is written in full: an
abbreviated id cannot be looked up, and the answer you get back would be about nothing.

## Step 10 — Wait for pi, then start

Do not start the proposed task before pi has answered. Pi confirms it, or redirects you to
another one — and a redirection is not a reproach, it is the whole point: the priority is
arbitrated fleet-wide, not station by station.

While waiting, stand by. Do not invent work, do not start something else "in the meantime",
and do not re-send the proposal.

Once pi has answered: `start_task` on the confirmed task, write the active-task flag, and
begin. No floating between the plan and the work.

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
- Yesterday's state is READ from the index and followed by id. It is never searched: a search
  ranks by resemblance and every handover resembles every other.
- The index is `dynamic.endOfDayIndex`, never `dynamic.currentTask`. `currentTask` is the live
  status, overwritten by the first write of any day; reading it returns something that looks
  like an index and is not.
- The date carried by the index is compared to the day expected. A mismatch is stated, never
  assumed away.
- Autonomous mode never asks anyone what to do. It chooses, then proposes its choice to pi and
  waits for a confirmation or a redirection before starting. Choosing and proposing is not
  asking; starting without the answer is.
- The station reports that it is up. A station running silently is one pi cannot direct.
- Genuine blockers travel as one message and then standby.
- No writing to `PROGRESS.md`. VantagePeers is the source of truth.
- A task with no named sellable product is not started.

## SELLABLE AS

`perello-daily-planner` — part of the `perello-executive` plugin, paired with `close-day`.

## Changelog

- **v3.3.0** — The index is read from its own field, `dynamic.endOfDayIndex`, instead of the live
  status field. Sharing one field meant the morning's first write destroyed the handover before
  anyone read it, and nothing recorded that it had existed. Adds the resolution note: a profile
  lookup takes the instance, not the role alone.
- **v3.2.0** — The station reports that it is up and names the task it proposes to start, then
  waits for the coordinator to confirm or redirect before starting. A station running silently
  cannot be directed, and a queue sorted correctly on one station can still be the wrong thing
  to do that morning — the priority is arbitrated fleet-wide. Choosing and proposing is not
  asking what to do; starting without the answer is.
- **v3.1.0** — Yesterday's state is read from the index `close-day` leaves on the peer record,
  then followed by id, instead of being searched. A search ranks by resemblance, and every
  handover ever written resembles every other: it returned handovers months old with nothing
  looking wrong, and a corrected handover written an hour later never surfaced at all. Adds the
  date check — an index older than the last working day is stated, never assumed away.
- **v3.0.0** — Pairs with `close-day` through the fixed `handover-close-day` memory name, which
  was written every evening and never read. Adds: message-cron registration at ten minutes;
  inbox before work; repository state measured on a synced tree, with the day's branch opened
  here and an older branch treated as an unclosed day; overnight in-progress closure with its
  time line; own blocked queue with a single nudge; the sellable-product gate at pick time.
  Removes the endless self-chaining loop, which contradicted `check-messages`, the question
  "what do you want to accomplish today", which contradicted proactive mode, and the writes to
  `PROGRESS.md`.
- **v2.0.0** — Two modes, human and autonomous.
