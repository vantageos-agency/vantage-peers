---
name: daily-start
description: >
  Run the morning session-start routine — load VantagePeers context, present routines and pending tasks, and either ask the user for the day's goals (human mode) or auto-pick the next unblocked task via dispatch-task-start (autonomous mode). Use this skill whenever the user says "daily start", "morning routine", "begin day", "what should I work on", "start the day", "morning plan", "daily planning", "what's on my plate today", "plan today", "session start" — even if they don't say "daily-start" explicitly.
description_fr: >
  Mobilisez la routine de demarrage de session du matin — chargez le contexte VantagePeers, presentez les routines et les taches en attente, puis demandez a l'utilisateur ses objectifs du jour (mode humain) ou laissez le skill choisir automatiquement la prochaine tache non bloquee via dispatch-task-start (mode autonome). Invoquez ce skill des que votre interlocuteur dit "demarrage du jour", "routine du matin", "commencez la journee", "sur quoi travailler", "plan du jour", "demarrage de session" — meme sans mentionner explicitement "daily-start".
allowed-tools: "mcp__vantage-peers__recall, mcp__vantage-peers__list_missions, mcp__vantage-peers__list_tasks"
metadata:
  version: "3.0.0"
  user-invocable: true
license: Proprietary
---

Session-start routine: detect mode, load VP context, show routines + pending, then either prompt the user for goals (human) or chain to `dispatch-task-start` on the highest-priority unblocked task (autonomous). When the user's stated goal needs a new mission scaffold, chain to `mission-bootstrap` instead of raw `create_mission`.

**Canonical source**: VantageRegistry (`get_skill_content name=daily-start`). The local `.claude/skills/daily-start/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. End of hand-copy — fetch from VR, do not edit locally.

V3 PRINCIPLE — NEVER RAW `start_task` AT SESSION-START. Every transition from "task picked" to "task running" goes through `dispatch-task-start` so the IRP-sequence hook (`enforce-irp-sequence.py`) cannot block on a stale `in_progress` task left over from the previous session. Same rule applies whether Pi confirms a human-mode pick or sigma/eta auto-pick autonomously.

V3 PRINCIPLE — NEW MISSION ⇒ `mission-bootstrap`. When the user's stated goal is "start a mission for X" / "scaffold mission Y" / "new mission Z", do not call `create_mission` directly. Chain to the `mission-bootstrap` skill, which wires VERIFICATION/TESTS-compliant child tasks and pre-satisfies the task-quality hook.

## WORKFLOW

**Step 1 — Detect mode (human vs autonomous)**

HUMAN MODE is opt-in via a HOST-SIDE marker that lives outside every repo and every published package. Never key it on a hardcoded filesystem path or a person's name: a published plugin must not carry its maintainer's home directory — that is an internal-identifier leak, and it is meaningless to any external user of the plugin.

- **HUMAN MODE** iff the marker is present: env `VANTAGE_HUMAN_MODE=1`, or the file `~/.claude/vantage-human-mode` exists.
- **AUTONOMOUS MODE** otherwise (any VPS orchestrator: sigma, alpha, lambda, victor, tau, phi, omega, eta, zeta, proxima, verify, scan, etc.). No marker = autonomous.

This degrades in the safe direction: an interactive operator who forgets the marker gets an autonomous run, which is immediately visible. The reverse default would silently freeze a VPS orchestrator waiting on a human who is not there.

**Step 2 — Load context (silent, both modes)**

Run these in parallel where possible:
- `mcp__vantage-peers__recall` query="today priorities urgent pending" namespace="global"
- `mcp__vantage-peers__recall` query="reference CLI commands tools" namespace="global"
- `mcp__vantage-peers__list_missions` status="active"
- `mcp__vantage-peers__list_tasks` assignedTo=<your role> status="todo" fields="lite" limit=20
- `mcp__vantage-peers__list_tasks` assignedTo=<your role> status="in_progress" fields="lite" limit=20

Read if present: `context/routines.md`, `PROGRESS.md`, `context/current-priorities.md`, `context/goals.md`. Run `date` for day-of-week + date.

**Step 3 — Stale in_progress sweep (both modes)**

For each task returned in `status=in_progress`:
- If genuinely finished (evidence exists): close via `complete_task` with evidence-bound `completionNote` (URL / SHA / PR# / VP id / ratio / counted artifact / file path — ≥40 chars).
- If genuinely still in progress: leave it.
- If dead (cancelled scope, superseded): `update_task status="blocked"` with a clear blocker note.

This step exists so Step 5A / Step 6H never trips `enforce-irp-sequence.py`.

---

## HUMAN MODE (Pi on Chromebook)

**Step 4H — Present routines + pending**

```
ROUTINES FOR TODAY ([day], [date]):

Daily:
- [ ] Check calendar — summarize today's schedule
- [ ] Check emails (1/3) — morning triage
- [ ] Check emails (2/3) — afternoon follow-up
- [ ] Check emails (3/3) — evening sweep, inbox zero
- [ ] BIP diary entry (end of session)
- [ ] PROGRESS.md update (end of session)

Weekly (if triggered):
- [ ] [routine name] — [details]

Monthly (if triggered):
- [ ] [routine name] — [details]

PENDING FROM LAST SESSION:
- [ ] [task title] (k<id>, priority=<p>, status=<s>)
```

**Step 5H — Ask for today's goals**

Ask the user: "What do you want to accomplish today beyond routines?" Wait. One answer.

**Step 6H — Branch on goal shape**

Classify the user's stated goal:
- **"Start a mission for X" / "scaffold mission Y" / "new mission for Z"** → chain to `mission-bootstrap` skill with the mission brief. Do NOT call `create_mission` directly.
- **"Work on task k<id>" / "continue task X"** → if that task is in `todo`, chain to `dispatch-task-start` skill with that taskId. If already `in_progress`, resume.
- **Free-form goals (no explicit task/mission)** → merge with routines + pending into a prioritized list (see Step 7H).

**Step 7H — Prioritize and write**

Merge routines + pending + the user's goals into one priority-ordered list:

1. Revenue-generating — client delivery, sales, closing
2. Pipeline — offers, outreach, lead gen
3. System building — agents, skills, plugins, website
4. Routines — email, calendar, admin
5. Process improvement — internal tooling, documentation

Write the list to `PROGRESS.md` under today's `#### Today's goals (priority order)` section.

**Step 8H — Confirm and start**

Show the final plan. Say: "Plan set. Starting with [first task]."
- If first task is a VantagePeers `todo` task → chain to `dispatch-task-start` with its taskId. Never raw `start_task`.
- If first item is a routine (no VP task yet) → execute directly. No `start_task` needed.
- If first item is a new mission scaffolding need → chain to `mission-bootstrap`.

---

## AUTONOMOUS MODE (every orchestrator except Pi Chromebook)

**Step 4A — Auto-pick highest-priority unblocked task**

From the `status=todo` list returned in Step 2:
- Sort by `priority` (urgent > high > medium > low), then by `_creationTime` (oldest first).
- For each candidate, check `dependsOn`. If any dependency is not `status=done`, skip.
- The first candidate whose dependencies are all `done` (or who has none) wins.

If no candidate exists (queue empty or all blocked):
- Produce a 3-line standby summary: role, instance, "queue empty awaiting dispatch" or "blocked on: [list of dep taskIds]".
- Do NOT ask anyone for next steps. Do NOT invent work. Exit silently.

**Step 5A — Dispatch via `dispatch-task-start`**

Chain to the `dispatch-task-start` skill with the picked `taskId`. That skill re-sweeps any stale in_progress task, calls `start_task` with the new taskId, and returns control. NEVER call `mcp__vantage-peers__start_task` directly from this skill.

**Step 6A — Execute + loop**

Execute the task per its description / VERIFICATION / TESTS blocks. On completion: `complete_task` with evidence-bound `completionNote` (URL / SHA / PR# / VP id / ratio / counted artifact / file path — ≥40 chars). Re-invoke this skill (or `check-messages`) to chain to the next task.

**Step 7A — Never ask the user / Pi**

Autonomous orchestrators NEVER produce "What do you want to accomplish today?" or "Which task should I pick?" output. Decide from the queue or stand by. Only escalate via `send_message` to `pi-chromebook` for a genuine blocker. Any such `send_message` MUST open with `[INFO ONLY]` / `[STATUS]` / `[DONE]` or reference `task k<id>` (no-task-in-message hook) and MUST end with the signature line `Orchestrator: <Name> — <Team> | YYYY-MM-DD` (signature hook).

---

## RULES

- Never skip Step 1 (mode detect) + Step 2 (context load) + Step 3 (stale sweep).
- Default `list_tasks` calls: `fields="lite"`, `limit=20`.
- Routines: human mode only. Autonomous ignores them unless scheduled as a VP task.
- New mission scaffolding ALWAYS chains to `mission-bootstrap`. Never raw `create_mission`.
- Task start ALWAYS chains to `dispatch-task-start`. Never raw `start_task`.
- Evidence-Bound Done (Day 76): every `complete_task` / `update_task→review|done` cites a verifiable proof token, ≥40 chars. Hook `enforce-evidence-bound-completion` (contentHash fb62f24e1658f52794b642256500c370bfc1987c4dd5fb9c43217e7848326ab1) blocks claim-words-only completions.
- No time / duration estimates anywhere (block-time-estimates hook).

## EXAMPLES

See `references/examples.md` for full walk-throughs of: human free-form goals, human mission-bootstrap branch, autonomous auto-pick + dispatch, and autonomous empty-queue standby.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=daily-start`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly.

## SELLABLE AS

`vantage-peers` plugin — wraps `list_missions` / `list_tasks` / `recall` / `start_task` into a single mode-aware session-start routine that hooks-safely dispatches the day's first task (via `dispatch-task-start`) or scaffolds a new mission (via `mission-bootstrap`).
