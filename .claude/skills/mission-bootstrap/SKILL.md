---
name: mission-bootstrap
description: >
  Bootstrap a VantagePeers mission with the full IRP task chain (plan → execute → verify → ship) wired with dependencies in a single skill invocation. Use this skill whenever the user says "bootstrap mission", "start a mission for X", "scaffold IRP for X", "create mission with tasks" — even if they don't say "mission-bootstrap" explicitly.
description_fr: >
  Initialisez une mission VantagePeers avec sa chaîne complète de tâches IRP (planifier → exécuter → vérifier → livrer) câblée avec ses dépendances, en une seule invocation de skill. Mobilisez ce skill chaque fois que votre utilisateur dit "bootstrap mission", "lance une mission pour X", "monte une chaîne IRP pour X", "crée une mission avec des tâches" — même sans dire "mission-bootstrap" explicitement.
allowed-tools: "mcp__vantage-peers__create_mission, mcp__vantage-peers__add_task_dependency, mcp__vantage-peers__update_mission_status, Bash"
metadata:
  version: "1.2.0"
  user-invocable: true
license: Proprietary
---

Create a VantagePeers mission and its full IRP task chain (T0 plan, T1..Tn execute, T(n+1) verify, T(n+2) ship) with sequential `dependsOn` wiring, in one call instead of the 8–15 raw MCP calls Pi does by hand today.

**Canonical source**: VantageRegistry (`get_skill_content name=mission-bootstrap`). The local `.claude/skills/mission-bootstrap/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. End of hand-copy — fetch from VR, do not edit locally.

PRINCIPLE 1 — ONE MISSION, FULL CHAIN: a mission is useless without its task chain. This skill refuses to create a mission with fewer than 3 tasks. If the caller only has a single deliverable in mind, they want a task (call `dispatch-task-create`), not a mission.

PRINCIPLE 2 — DELEGATE TASK CREATION: every individual task is created via the `dispatch-task-create` skill, never via a direct `create_task` call. That skill auto-injects the `VERIFICATION:` + `TESTS:` blocks the `enforce-task-quality` hook requires, and the signature block the `enforce-signature` hook requires. This skill is a chain orchestrator, not a task author.

PRINCIPLE 3 — DEPENDENCY CHAIN IS LAW: tasks must be linked T0 ← T1 ← T2 ← ... ← T(last) via `add_task_dependency`. No fan-out, no skipped links, no orphan tasks. Verify and ship tasks always depend on the last execute task.

PRINCIPLE 4 — `description` AND `brief` ARE TWO DISTINCT PARAMS, BOTH REQUIRED. `mcp__vantage-peers__create_mission` accepts two textual params with different roles. Sending only `description` is the single most common scaffold failure (Day 95 — Pi + Xi both hit "Mission has no brief" in the same session). The `brief` param is hook-gated by `enforce-mission-template` (canonical hook lives in `elpi-corp/.claude/hooks/enforce-mission-template.py`). Day 95 Laurent verbatim: *"mais comment est ce possible que tu ne saches toujours pas comment créer une mission du premier coup? ce n'est pas un hook mais vantage peers plugin skill et ton claude.md!"*. This skill MUST construct both params before calling `create_mission`, and the `brief` MUST reference a known template via the accepted regex.

| Param | Role | Required | Hook-gated |
|---|---|---|---|
| `description` | One-paragraph human-readable summary of the mission (what + why). Stored as-is on the mission row, surfaced in `list_missions`. Equivalent to the `objective` collected in Step 1. | Yes (≥1 non-empty char) | No |
| `brief` | Operational charter: stage-by-stage scope, deliverables, success criteria. MUST reference a known mission template using the regex below. Stored as the canonical mission contract. | Yes (≥1 non-empty char + template ref) | Yes — `enforce-mission-template.py` |

**Known templates (canonical list — `elpi-corp/.claude/hooks/enforce-mission-template.py`)**:
- `hook-development-v1`
- `plugin-dev-v1`
- `infra-change-v1`
- `mission-generic-v1`
- `chrome-extension-mission-v1`
- `issue-resolution-v2`
- `site-launch-v1`
- `diary-perfectaiagent-v1`
- `pricing-research-v1`
- `skill-quality-pilot-template-v1`

**Accepted regex (case-insensitive)**: `template\s*(?:utilis(?:e|é)\s*)?:\s*([a-z0-9-]+-v\d+)`

This matches all of:
- `Template : mission-generic-v1`
- `Template utilise : hook-development-v1`
- `Template utilisé : plugin-dev-v1`
- `template:issue-resolution-v2` (whitespace optional around the colon)

`template foo-v1` (no colon) and `template : foo` (no `-vN` suffix) do NOT match → hook blocks.

**Minimal valid `brief` example** (used when caller did not supply one):
```
Template utilise : mission-generic-v1
Stages: T0 plan -> T1 execute -> T2 verify -> T3 ship.
Proof artifact: <PR# | commit SHA | file path | dashboard URL>.
```

**Opt-out (rare, fix the source after)**: `templateOptOut: <reason>` anywhere in the brief — hook lets it through.

**Reference**: Pi capitalize Day 95 memory `j575wfpbympmnk86pshzb0qxb1886fdv`. Pi `CLAUDE.md` fleet section "Créer une mission" was updated Day 95 with the same description-vs-brief breakdown — this skill is the executable form of that doctrine.

## WORKFLOW

**Step 1 — Collect mission inputs**

Gather (from the user invocation or by inference from the surrounding session):

1. `name` — short mission title (kebab-or-sentence form).
2. `pilot` — orchestrator role responsible (e.g. `sigma`, `eta`, `pi`).
3. `bu` — business unit id (e.g. `elpi-corp`, `vantage-peers`, `myreeldream`). Required by `create_mission`.
4. `objective` — one paragraph: what done looks like, the proof artifact expected.
5. `tList` — ordered list of task briefs. If omitted, default to the canonical IRP 4-stage skeleton:
   - T0 — `plan` — Investigate scope, list files touched, produce a plan note.
   - T1 — `execute` — Apply the change.
   - T2 — `verify` — Run tests + manual smoke; attach evidence (ratio, screenshots, file paths).
   - T3 — `ship` — Open PR / publish / deploy; cite PR# or commit SHA.
6. `assignments` — per-task `assignedTo` role. If omitted, default every task to `pilot`.

If `tList.length < 3`, abort with: `mission-bootstrap requires ≥ 3 tasks — use dispatch-task-create for a single deliverable`.

**Step 2 — Create the mission (BOTH `description` AND `brief`)**

Build the two textual params per PRINCIPLE 4, then call `mcp__vantage-peers__create_mission`:

- `name` — from Step 1
- `bu` — from Step 1
- `pilot` — from Step 1
- `description` — from Step 1 `objective` (the one-paragraph human summary).
- `brief` — operational charter referencing a known template via the accepted regex. If the caller did not supply a brief, generate one from the minimal template:
  ```
  Template utilise : mission-generic-v1
  Stages: T0 plan -> T1 execute -> T2 verify -> T3 ship.
  Proof artifact: <restate the proof artifact from objective>.
  ```
  Pick a more specific template if the mission topic matches (`hook-development-v1` for hook work, `plugin-dev-v1` for plugin scaffolding, `infra-change-v1` for migrations, etc. — full list in PRINCIPLE 4).
- `status` — `planning` (will flip to `execute` in Step 5)

If `create_mission` returns `BLOCKED: Mission has no brief — cannot verify template reference.` or `BLOCKED: Brief does not reference any mission template.`, the brief is malformed — re-derive it against the regex in PRINCIPLE 4 and retry once. Do NOT silently strip the brief or add `templateOptOut` to bypass.

Capture the returned `missionId` (form `j<32>` or `k<32>`). This id is the proof token used in every downstream task brief.

**Step 3 — Create each task via dispatch-task-create**

For each entry `Tn` in `tList`, in order:

1. Invoke the `dispatch-task-create` skill (`Skill({skill: "dispatch-task-create"})`) with arguments:
   - `title` — `T{n} — {tList[n].label}` (e.g. `T0 — plan`)
   - `assignedTo` — `assignments[n]` (fallback `pilot`)
   - `missionId` — captured in Step 2
   - `priority` — inherit from mission default (`high` for ship-class missions, `medium` otherwise)
   - `brief` — `tList[n].brief` — per-stage description. The dispatch skill auto-injects `VERIFICATION:` and `TESTS:` blocks per the `enforce-task-quality` hook contract.
2. Capture the returned `taskId` into an ordered array `taskIds[n]`.
3. If any `dispatch-task-create` invocation fails, abort the bootstrap, surface the error verbatim, and DO NOT proceed to the dependency wiring step (partial chain is worse than no chain — caller can retry).

**Step 4 — Wire the dependency chain**

For each `n` in `1..taskIds.length - 1`, call:

```
mcp__vantage-peers__add_task_dependency
  taskId    = taskIds[n]
  dependsOn = taskIds[n-1]
```

This produces the linear chain T0 ← T1 ← T2 ← ... ← T(last). No task is unblocked until its predecessor is `done`. The `enforce-irp-sequence` hook then naturally serializes execution.

If a verify or ship task should depend on multiple execute tasks (parallel execute branches), the caller must pass an explicit `dependsOn` graph in `tList[n].dependsOn` — in that case use those indices instead of the linear default for that single task only.

**Step 5 — Activate the mission**

Call `mcp__vantage-peers__update_mission_status` with:
- `missionId` — captured in Step 2
- `status` — `execute`

Then ARM the IRP sequential gate for the pilot by touching the role-scoped active flag (the write-side signal `enforce-irp-sequence` v2 reads):

```
touch /tmp/.irp-active-<pilot>-<missionId>
```

`<pilot>` is the Step 1 pilot role, `<missionId>` the Step 2 id. While this flag exists, the pilot's `start_task` calls are serialized to the IRP dependency chain; standalone (non-IRP) tasks for OTHER roles are unaffected (the flag is role-scoped). The flag is removed automatically when the mission closes (`update_mission_status` → `done`|`cancelled`) by the `mission-status-irp-cleanup` PostToolUse hook — never unlink it by hand. On the shared VPS (RULE #28) the `<pilot>` prefix + `<missionId>` suffix keep flags from colliding across orchestrators.

The mission is now live. The pilot orchestrator will pick up T0 on its next `check-messages` cycle.

**Step 6 — Confirm to caller**

Emit a single confirmation block with:
- `missionId` (proof token)
- Ordered list of `taskIds` with their titles
- Dependency chain visualization: `T0 ← T1 ← T2 ← T3`
- One-line next-step: `pilot {pilot} will pick up {taskIds[0]} on next cycle`

## RULES

- Refuse missions with fewer than 3 tasks — that is a task, not a mission.
- Never call `mcp__vantage-peers__create_task` directly. Delegate to `dispatch-task-create` so `VERIFICATION:` + `TESTS:` blocks are present and `enforce-task-quality` accepts the call.
- Never skip the `add_task_dependency` chain. An orphan task in a mission is a bug.
- Never use temporal-deferral phrasings (`later`, `eventually`, `someday`, `for now we'll`) in `objective` or task briefs — `enforce-ship-24-7` rejects these.
- Never include duration estimates (`2 hours`, `1 day`, `a week`) in `objective` or briefs — `block-time-estimates` rejects these. Express scope by deliverable or file count.
- `objective` must name the proof artifact (PR#, commit SHA, file path, dashboard URL, test ratio). Vague objectives propagate to vague briefs and fail evidence-bound completion downstream.
- If `pilot` is unset, default to the caller's own orchestrator role — never default to `pi` (Pi is human; dispatching to Pi is a workflow anti-pattern).
- After Step 5, do NOT also `start_task` on T0 from inside this skill. The pilot's `check-messages` cycle owns task pickup, and `enforce-irp-sequence` rejects a `start_task` if the pilot already has an `in_progress` task.
- ALWAYS pass BOTH `description` AND `brief` to `create_mission`. Sending only `description` triggers the `enforce-mission-template` hook BLOCK ("Mission has no brief"). See PRINCIPLE 4 for the full param contract, accepted regex, and template list.

## Changelog

- **v1.2.0 (Day 126)** — Step 5 now ARMS the IRP sequential gate: `touch /tmp/.irp-active-<pilot>-<missionId>` after `update_mission_status → execute`. This is the write-side companion to `enforce-irp-sequence` v2 (read-side) + `mission-status-irp-cleanup` (unlink-side, fires at mission close). `Bash` added to `allowed-tools` for the touch. Task k171fmz5, contract `docs/fleet/irp-sequence-v2-contract.md` (Pi Q1 + Eta Q2/Q3).
- **v1.1.0 (Day 95+)** — Added PRINCIPLE 4 (description vs brief), Step 2 now builds and passes both params, RULES + brief-validation retry block added. Source: friction k175sc6c6zxgcymcmzh29qvxyd887js0 — Day 95 Pi + Xi both hit "Mission has no brief" on first try in the same session. Brief regex + 10 known templates pulled from canonical `elpi-corp/.claude/hooks/enforce-mission-template.py`.
- **v1.0.x** — Initial bootstrap skill: mission + IRP task chain + dependency wiring + status flip.

## EXAMPLES

Three worked invocation modes (default IRP skeleton, multi-execute chain, refusal on undersized mission) are documented in `references/examples.md` — load on demand.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=mission-bootstrap`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly. The fleet stays aligned by pulling, not by hand-copy propagation.

## SELLABLE AS

`vantage-peers` plugin — collapses the 8–15 raw MCP calls of manual mission scaffolding into one skill invocation, with the full IRP task chain, dependency wiring, and hook-compliant briefs guaranteed by delegation to `dispatch-task-create`.
