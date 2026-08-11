---
name: close-day
description: >
  End-of-day routine: close tasks with their time, leave the repository and the disk clean,
  write the diary, harvest friction, and hand over to tomorrow.
  Use this skill whenever the user says "close day", "end of day", "fin de journée",
  "bonne nuit", "wrap up", "call it a day", "close session", "daily close",
  or mentions ending their work session -- even if they don't say "close-day" explicitly.
metadata:
  version: "2.0.0"
  user-invocable: true
license: Proprietary
---

You close the working day for one orchestrator. You run once at session end.

You are one half of a pair. `daily-start` opened the day's branch this morning and will read
the handover you write tonight, under the fixed memory name `handover-close-day`. What you
leave behind is what tomorrow starts from.

**Every count you display is derived from a command whose output you paste. None is typed.**

---

## Step 1 — Identity and date (silent)

Read the first 20 lines of `CLAUDE.md` for the orchestrator role. Derive `instanceId` from the
hostname: `{role}-vps` or `{role}-chromebook`. Run `date -I`.

## Step 2 — Close the tasks, with their time

```
mcp__vantage-peers__list_tasks assignedTo={role} status="in_progress"
mcp__vantage-peers__list_tasks assignedTo={role} status="todo"
```

Every in-progress task is accounted for. Finished, `complete_task` with its evidence and its
real time line in decimal hours. Genuinely unfinished, it stays in progress and is named in
the handover. Waiting on someone, `block_task` naming who owes the unblock.

Then total the day's time per project, derived from the closures you just wrote — not
remembered:

```
TIME:
- <project>: <N.N>h   (from <M> closed tasks)
- <project>: <N.N>h
```

An unclosed task loses its time line permanently, and on a billable project that line is the
invoice.

## Step 3 — Leave the repository clean

This is the step whose absence produced dozens of abandoned branches across four repositories.
It is measured, before and after, like the disk.

```
git fetch --prune -q origin
git status --porcelain | wc -l          # BEFORE
git ls-remote --heads origin | wc -l    # BEFORE
```

Then, in this order:

1. **Every uncommitted file is decided** — committed or discarded. None is left undecided.
   The count must reach zero.
2. **The day's branch is closed.** It merges into `main` and is deleted. The branch
   `daily-start` opened this morning does not survive the night.
3. **A branch that must survive carries a written reason**, recorded in the handover — an open
   review, a delivery gated tomorrow. Without a reason, it does not survive.
4. **Never delete a branch on the strength of its name.** Prove its content is in `main`
   (`git diff --name-status origin/main <branch> | grep '^A'` returns nothing), or that the
   catalogue holds it at an identical hash, or that a newer version supersedes it. On a
   conflict, the most recent version wins.

```
git status --porcelain | wc -l          # AFTER, must be 0
git log --oneline origin/main..HEAD | wc -l   # AFTER, must be 0
git ls-remote --heads origin | wc -l    # AFTER
```

Display:

```
REPOSITORY:
- uncommitted files: <before> -> 0
- unpushed commits: <before> -> 0
- remote branches: <before> -> <after>
- branches kept, with reason: <name> (<reason>) | none
```

**If the branch count is higher than yesterday, say it out loud and name why.** A count that
rises two evenings running is a steering failure, not an accident.

## Step 4 — Leave the disk clean

A full disk makes an install die on ENOSPC, which surfaces as a false "build broken" and costs
the whole fleet review cycles refuting a regression that never existed.

1. `df -h /` **before** — record it.
2. **node_modules first**, in terminal or abandoned worktrees and stale sandboxes. It is the
   weight, it is reinstallable, and deleting it destroys zero work.
3. **Audit each worktree before removing it**: `git -C <wt> worktree list` (never delete a live
   one) and `git -C <wt> log @{u}..HEAD` (non-empty means unpushed commits — do not delete).
4. **Never touch another orchestrator's live sandbox**, and never delete client data — flag it
   to the human instead.
5. `df -h /` **after** — record it. Still above 85%, escalate to pi: the pressure comes from
   another perimeter.

```
DISK:
- df /: <X%> -> <Y%>
- node_modules purged: <N> | worktrees reaped: <M> (unpushed=0 verified on each)
- escalated: yes/no
```

## Step 5 — What can a client buy or use today

One line, in sales terms: **what can a client buy or use today that they could not
yesterday?** Derived from what actually shipped — a release, a deployment proven live, a
delivery accepted.

If the answer is nothing, write "nothing". Two consecutive days of nothing is reported to the
operator in exactly those words, that same evening. Activity is not progress; a product state
change is.

## Step 6 — Write the diary

Write it yourself, from your own vantage point. Never ask the user for input — you know what
happened today. Build the context from the tasks you closed, the messages exchanged, and what
surprised or defeated you.

`mcp__vantage-peers__write_diary` with date, orchestrator, what was done, the decisions, the
blockers, the lessons.

## Step 7 — Harvest the friction

Every friction you actually met today. Not a quota: a quota manufactures filler on a clean day
and truncates a hard one.

- **You know the fix** — create an improvement task: `title="improvement: <area>"`, assigned by
  area (fleet doctrine and hooks to pi, protocol gaps to sigma, catalogue gaps to omega,
  extensions to their owner), tagged `[META]`, carrying what failed, the suspected root cause,
  and `VERIFICATION:` / `TESTS:` sections. Do not fix it here — scope it.
- **You only know it hurts** — store it: `namespace="audit/friction"`, `type="reference"`,
  content `friction: <area> | observed: <what> | impact: <cost> | hypothesis: <guess or none>`.

Zero friction is allowed. But a day with zero friction and nothing shipped is itself the
signal, and you say so.

**Pi only** — aggregate the fleet: `list_memories namespace="audit/friction"` over the past
seven days, grouped by area and recurrence. If two or more business units hit the same
friction, propose one batched improvement mission in `plan` status. Otherwise store the weekly
snapshot for next week's aggregation.

## Step 8 — Hand over to tomorrow

```
mcp__vantage-peers__store_memory
  namespace="orchestrator/{role}" type="project"
  content="handover-close-day | date: <date> | ..."
```

**The name `handover-close-day` is fixed.** `daily-start` recalls exactly that string tomorrow
morning. Change it here and the handover is written into the void.

It carries: what is left open and why, what to start with tomorrow, any branch kept with its
reason, the blocked tasks and who owes each unblock, the sales-terms line, and the counts of
improvement tasks and friction memories harvested.

## Step 9 — Close

`mcp__vantage-peers__set_summary` orchestratorId={role}, instanceId={instanceId},
summary="Session closed — {date}".

Then one line to the user: tasks closed, time totalled, branches before and after, disk before
and after, what shipped, handover id.

---

## RULES

- Every displayed count carries the command that produced it. A typed count is a lie in waiting.
- Steps 2, 3 and 4 are non-negotiable. A day closed on a dirty tree hands tomorrow a branch
  nobody will ever close; a day closed on a full disk hands it false regressions.
- One branch per day, opened by `daily-start`, closed here. A surviving branch carries a
  written reason in the handover, or it does not survive.
- Never delete a branch, a file, or a rule on the strength of its name. Prove the content is
  elsewhere. On a conflict, the most recent wins.
- The diary is mandatory and written autonomously. Never ask the user for its content.
- The handover memory name is fixed and shared with `daily-start`. It is not a free-text choice.
- A client task closes with its decimal-hours time line, or it does not close.

## SELLABLE AS

`perello-daily-planner` — part of the `perello-executive` plugin, paired with `daily-start`.

## Changelog

- **v2.0.0** — Repository hygiene becomes a measured step, before/after, like the disk: the
  previous version told every orchestrator to create a branch each evening and never to close
  one, which produced dozens of abandoned branches across four repositories. The day's branch
  now closes here. Adds: per-project time totals derived from the closures; the sales-terms
  line; the fixed `handover-close-day` name that `daily-start` reads. Removes the three-friction
  quota and every typed count.
- **v1.2.0** — Disk hygiene step.
- **v1.1.0** — Friction harvest.
- **v1.0.0** — Tasks, diary, summary, close.
