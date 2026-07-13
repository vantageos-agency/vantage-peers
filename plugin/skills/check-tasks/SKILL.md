---
name: check-tasks
description: >
  List the tasks assigned to the current orchestrator, sorted by priority and
  dependency-aware, while keeping the response under the 60 KB cap by always
  requesting the lite projection with a default limit. Use this skill whenever
  the user says "check tasks", "my tasks", "what tasks", "pending tasks",
  "task list", "todo list", "what should I work on", "backlog" — even if they
  don't say "check-tasks" explicitly.
description_fr: >
  Listez les tâches assignées à votre orchestrateur courant, triées par priorité
  et conscientes des dépendances, en maintenant la réponse sous le plafond de
  60 Ko via la projection allégée et une limite par défaut. Mobilisez ce skill
  dès que l'utilisateur dit "vérifiez mes tâches", "mes tâches", "tâches en
  attente", "liste de tâches", "todo", "sur quoi travailler", "backlog" — même
  sans prononcer "check-tasks" explicitement.
allowed-tools: "mcp__vantage-peers__list_tasks, mcp__vantage-peers__list_tasks_by_mission"
metadata:
  version: "2.0.0"
  user-invocable: true
license: Proprietary
---

Read-only task lister that always projects `fields=lite` with a default `limit=20`, renders a compact priority-ordered table, and (on explicit user request) chains to `dispatch-task-start` on the highest-priority unblocked todo.

**Canonical source**: VantageRegistry (`get_skill_content name=check-tasks`). The local `.claude/skills/check-tasks/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. End of hand-copy — fetch from VR, do not edit locally.

V2 PRINCIPLE — ENVELOPE-FRIENDLY BY DEFAULT: Day 89 introduced `capListResponseBytes` (60 KB) on bulk list tools. Calling `list_tasks` without a projection or limit will silently truncate or trip the envelope. This skill pins `fields=lite` and `limit=20` on every call, so the response always fits. Drill-down on a specific task uses `get_task` (single-row, no cap risk), not a bigger list.

V2 PRINCIPLE — READ-ONLY UNLESS ASKED: this skill READS and DISPLAYS tasks only. It does NOT call `start_task`, `complete_task`, or `update_task`. The auto-pick chain only fires when the user explicitly says "pick next", "start next", "auto-pick", or "take the next one" — and even then it delegates to the `dispatch-task-start` skill, which owns the IRP / evidence-bound writes.

## WORKFLOW

**Step 1 — Detect orchestrator role + instance**

1. Read the first 20 lines of `CLAUDE.md` in the current workspace.
2. Extract role (e.g., `pi`, `sigma`, `eta`, `alpha`, `lambda`, `tau`, `phi`, `omega`, `zeta`) from the header line `You are <Role>`.
3. Extract instanceId from CLAUDE.md (e.g., `<role>-<host>`) or fall back to hostname.
4. If both extraction attempts fail, ask the user once for the role; do NOT guess.

**Step 2 — Parse user intent**

Three modes are supported from a single skill entrypoint:

- DEFAULT: list todo tasks for `assignedTo=<role>`.
- MISSION-SCOPED: if the user mentions a mission id (`k<...>`) or says "tasks for mission X", switch to `list_tasks_by_mission`.
- PICK-NEXT: if the user says "pick the next one", "start next", "auto-pick", "take the next task" — run Step 3 then chain to `dispatch-task-start`.

**Step 3 — Fetch the list (envelope-friendly)**

Default branch — call `mcp__vantage-peers__list_tasks` with EXACTLY these parameters:

- `assignedTo=<role>`
- `status="todo"` (default) — or the explicit status the user named (`in_progress`, `review`, `blocked`). NEVER pass `status="all"` unless the user explicitly types "all statuses".
- `fields="lite"` — REQUIRED. Returns only `{ _id, title, priority, status, dependsOn, assignedToInstance, _creationTime }`.
- `limit=20` — default cap. If the user says "show more" / "top 50", raise to 50. NEVER omit limit.

Mission-scoped branch — call `mcp__vantage-peers__list_tasks_by_mission` with:

- `missionId=<k...>`
- `fields="lite"`
- `limit=20`

If the user passes an `instanceId` (e.g., "tasks for `<role>-<host>`"), additionally call `list_tasks` with `assignedToInstance=<instanceId>`, same `fields=lite` + `limit=20`, and merge dedup by `_id`.

**Step 4 — Sort + dependency-resolve client-side**

1. Drop any task with `status="done"` (defense-in-depth; the filter should already exclude).
2. Sort: priority order `urgent > high > medium > low`, then `_creationTime` ascending.
3. For each task with non-empty `dependsOn`: fetch the status of each dependency via a single `list_tasks` call constrained by `_id IN (...)` with `fields=lite` and `limit=<len(deps)>`. If any dependency is not `done`, mark the task `BLOCKED` regardless of its stored status.
4. Identify the FIRST task whose `dependsOn` is empty OR fully `done` — this is the "next actionable" task.

**Step 5 — Render compact table**

Output shape:

```
TASKS (<role>) — todo:N in_progress:N review:N blocked:N

NEXT  [<priority>] <title> — k<taskId8>
      <empty | "blocked on: <dep title> (<dep status>)">

  1.  [<priority>] <title> — k<taskId8>
  2.  [<priority>] <title> — k<taskId8>
       blocked on: <dep title> (<dep status>)
  ...
```

- Truncate `title` to 80 chars (single line).
- Show only the first 8 chars of `_id` as `k<taskId8>` (full id available via `get_task`).
- If the list was capped at limit, append `… (N more — say "show more" to raise limit to 50)`.

**Step 6 — Optional chain: dispatch-task-start**

ONLY if Step 2 detected PICK-NEXT intent AND a non-blocked NEXT task exists, invoke the `dispatch-task-start` skill with `taskId=<id of NEXT>`. Do NOT call `start_task` directly from this skill — `dispatch-task-start` owns the IRP pre-check (`enforce-irp-sequence`) and the evidence-bound contract.

If PICK-NEXT was requested but the NEXT task is blocked or the queue is empty, print a one-line standby (`queue empty — awaiting dispatch` or `next candidate blocked on <dep>`) and exit. Do NOT invent work, do NOT prompt the user for an override.

## RULES

- ALWAYS pass `fields="lite"` and `limit=20` (50 on explicit "show more") to both `list_tasks` and `list_tasks_by_mission`. Never omit.
- NEVER pass `status="all"` unless the user explicitly types "all statuses" — default is `status="todo"`.
- ONE primary `list_tasks` call per Step 3 branch; dependency resolution batches via a single `_id IN (...)` follow-up, never per-task.
- READ-ONLY: this skill never writes. Auto-pick delegates to `dispatch-task-start`.
- Show NEXT actionable task on its own line at the top — the user should not have to re-sort.
- Zero tasks: print `No tasks assigned to <role>.` and exit silently.
- Day 89 envelope `capListResponseBytes=60000` — `fields=lite` + `limit=20` keep payload safely under the cap.
- Evidence-Bound Done (Day 76) does not apply here (no closes); the chained `dispatch-task-start` carries that contract.
- Never hardcode a real host or instance identifier in this skill — it ships inside a PUBLIC plugin package. Instance ids are DERIVED from CLAUDE.md or the hostname at runtime; examples stay generic placeholders (Day 130).

## EXAMPLES

See progressive disclosure references alongside this SKILL.md:

- `references/default-list.md` — default `assignedTo=<role>` happy path.
- `references/mission-scoped.md` — `list_tasks_by_mission` branch.
- `references/pick-next-chain.md` — explicit hand-off to `dispatch-task-start`.
- `references/empty-queue.md` — zero-result standby behavior.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=check-tasks`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly. The fleet stays aligned by pulling, not by hand-copy propagation.

## SELLABLE AS

`vantage-peers` plugin — envelope-friendly task triage that pins `fields=lite` + `limit=20` so the Day 89 60 KB `capListResponseBytes` is never tripped, renders a priority + dependency-aware table in one shot, and on explicit request hands off to `dispatch-task-start` instead of duplicating IRP logic.
