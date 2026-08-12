---
name: dispatch-task-create
description: >
  Create a VantagePeers task for another orchestrator with a properly-formed
  description (VERIFICATION + TESTS + IRP blocks + delegation triplet on batch
  ops + auto allow-no-notify marker on multi-task dispatch) so the
  enforce-task-quality + enforce-pi-task-doctrine + enforce-create-task-notify-followup
  hooks never block. Use this skill whenever the user says "create task for
  <orch>", "dispatch task", "queue work for <orch>", "ask <orch> to do X" —
  even if they don't say "dispatch-task-create" explicitly.
description_fr: >
  Créez une tâche VantagePeers pour un autre orchestrateur avec une description
  bien formée (blocs VERIFICATION + TESTS + IRP + triplette delegation sur
  batch ops + marker allow-no-notify auto-injecté sur dispatch multi-tâches)
  afin que les hooks enforce-task-quality + enforce-pi-task-doctrine +
  enforce-create-task-notify-followup ne bloquent jamais. Utilisez ce skill dès
  que votre interlocuteur dit "crée une tâche pour <orch>", "dispatche une
  tâche", "file ce travail à <orch>", "demande à <orch> de faire X" — même
  sans citer explicitement "dispatch-task-create".
allowed-tools: "mcp__vantage-peers__create_task, mcp__vantage-peers__send_message"
metadata:
  version: "1.0.7"
  user-invocable: true
license: Proprietary
---

Wrap `mcp__vantage-peers__create_task` so every dispatched task ships with the IRP doctrine blocks (VERIFICATION, TESTS, IRP) that `enforce-task-quality.py` requires, the delegation triplet (`subagent_type` + `run_in_background` + `model`) that `enforce-pi-task-doctrine.py` requires for batch ops, the `// allow-no-notify` marker that `enforce-create-task-notify-followup.py` requires for multi-task dispatches to the same assignee, plus the drain-notify-queue check (Step 1.3) that prevents cross-assignee dispatch blocks, plus the right assignee, priority, mission link, and dependency wiring.

**Canonical source**: VantageRegistry (`get_skill_content name=dispatch-task-create`). The local `.claude/skills/dispatch-task-create/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. Fetch from VR — do not edit locally.

## WORKFLOW

**Step 0 — Pre-flight (typed-params recipe, Day 113)**

Before the first `create_task` of a session, load the schema:

```
ToolSearch query="select:mcp__vantage-peers__create_task,mcp__vantage-peers__send_message"
```

Read the required params: `title`, `assignedTo`, `priority`, `createdBy`, `description`. Optional: `missionId`, `dependsOn` (array of strings, NEVER bare token).

**Step 1 — Gather context**

1. Parse user intent: extract the assignee (sigma, eta, alpha, lambda, tau, phi, omega, zeta, …), the work, and any cited mission / parent task / PR / issue.
2. If the user named a mission, resolve its `missionId` via `list_missions` or `get_mission`. If they cited a prerequisite task, capture its taskId for `dependsOn`.
3. Read your own orchestrator role from `CLAUDE.md` header — that becomes `createdBy`.
4. **Track batch state in skill session**: count tasks dispatched so far per (missionId, assignedTo) tuple. This count drives Step 2.7 marker injection.
5. **Track per-turn notify queue**: maintain a list `pending_notify[]` of (taskId, assignee) pairs from previous create_task calls in THIS turn that have not yet been followed by their `send_message channel=<assignee>`. Step 1.3 drains this before the next dispatch.

**Step 1.3 — Drain pending notify queue (Day 114, v1.0.7 — 5× recurrence fix)**

Before EVERY new `create_task urgent|high` call, check `pending_notify[]` from Step 1.5.

If `pending_notify[]` is non-empty:

1. The hook `enforce-create-task-notify-followup.py` WILL block the next `create_task` because previous urgent/high tasks are un-notified. Cross-assignee dispatch is NOT exempt — the hook scans all pending un-notified urgent/high tasks across all assignees.
2. Resolution: emit `mcp__vantage-peers__send_message` to EACH `(taskId, assignee)` in the queue first. Use the canonical grid:
   ```
   [INFO ONLY] task <taskId> // allow-no-specialist: dispatch notification
   evidence:  mcp__vantage-peers__create_task <taskId> — <title>
   finding:   <one-line context>
   action:    n/a — <assignee> exécute quand queue le permet.
   next:      <next-step or standby>

   Orchestrator: <Role> — <Team> | <YYYY-MM-DD>
   ```
3. Once each pending notify is sent, clear `pending_notify[]` and proceed with the new `create_task`.

If `pending_notify[]` is empty (first dispatch of the turn OR previous dispatches already notified), proceed directly to Step 2.

**Banned pattern**: 2+ parallel `create_task urgent|high` calls in one tool batch when at least one is the first of its assignee in this turn. Always sequential: create A → notify A → create B → notify B. Parallel calls trigger the hook block on the 2nd because the 1st is un-notified in the same tool batch.

**Step 2 — Resolve missing inputs (at most one ask)**

Required: `title`, `assignedTo`, `priority`, `createdBy`, `description`. Optional: `missionId`, `dependsOn`.

If a required field is missing AND cannot be inferred, issue ONE `AskUserQuestion` covering all gaps at once (assignee, priority, mission link). In Auto Mode, prefer defaults (`priority=medium`, no missionId). Only ask when the choice changes who ships or whether it ships.

**Step 2.5 — Detect batch operations (Day 114 — enforce-pi-task-doctrine)**

A task is a **batch operation** if any of the following are true:
- Title or description contains: "every X", "for each", "batch", "audit N", "fix N hooks", "all hooks", "all workspaces", "N+ fleet", "loop", "sweep", "mass", "scan all".
- The description sets out a per-item action over a list of ≥ 3 items.
- The task spawns sub-work that the assignee orchestrator cannot perform inline (orchestrators cannot code themselves — `block-orchestrator-code-edits.py` enforces this).

If batch, the description MUST include a **delegation triplet** block AND the literal lines below:

```
Délègue à : subagent_type="<specialist>"
Mode : run_in_background=true
Model : model="sonnet"
```

Pick `<specialist>` per work type:
- Code mass-edit / refactor: `dev-senior-dev`
- Research / audit / mapping: `dev-tech-researcher`
- Backend Convex: `dev-convex-expert`
- Auth / Clerk: `dev-clerk-expert`
- UI / frontend: `dev-frontend`
- QA / tests: `dev-qa`
- Content / copy: `agency-copywriter`

Never default to `general-purpose` for batch tasks.

If the task is **pure orchestration** (META / ADMIN / MESSAGING — single side-effect, no per-item loop), tag the description with `[META]`, `[ADMIN]`, or `[MESSAGING]` at the very top. The hook recognizes these tags for non-batch ops. Batch ops cannot bypass via these tags.

If the task is **housekeeping shell** (rm/du direct via Bash, no code edit, but description mentions "scan/sweep" in common housekeeping language), inject `delegationOptOut: <reason>` instead of the delegation triplet. The hook accepts this opt-out for genuine non-batch housekeeping.

**Step 2.7 — Detect multi-task dispatch + auto-inject allow-no-notify (Day 114 — enforce-create-task-notify-followup)**

The hook `enforce-create-task-notify-followup.py` blocks every `create_task urgent|high` that lacks a same-turn `send_message` to the assignee. For BATCH dispatches (multiple tasks for the same assignee on the same mission, dispatched in a single skill invocation), per-task `send_message` is noise — ONE consolidated `send_message` at the end of the batch is the canonical pattern.

To satisfy the hook without per-task pings:

- If this is the 2nd+ create_task in the current skill session targeting the SAME `(missionId, assignedTo)` tuple AND `priority` is `urgent` or `high`, AUTO-INJECT the following marker literally into the description (one line, anywhere — placed right after the `[META]` tag for readability):

  ```
  // allow-no-notify: batch dispatch T<N> mission <missionId> assignee <assignee>, consolidated send_message after batch end
  ```

- Also auto-inject the marker on the FIRST task of a known batch when the caller signals intent via:
  - Caller passes `batch=true` in skill args, OR
  - Caller dispatches ≥ 2 tasks back-to-back to the same assignee with the same `missionId`.

- After the LAST task of the batch (skill detects via `batch_end=true` arg OR by 30s idle), the skill MUST emit ONE consolidated `mcp__vantage-peers__send_message` to the assignee summarizing the batch:
  - Subject: `[STATUS] mission <missionId> <mission-name> batch dispatched`
  - Body grid: `evidence:` = list of taskIds + titles, `finding:` = "N tasks dispatched, dependsOn chain T0→T<N>", `action:` = "start T0 when prerequisites green", `next:` = "<emitter> attend [DONE] T0 puis chain".

The hook's `// allow-no-notify: <reason>` marker is the official override. A descriptive reason ("batch dispatch …") satisfies it; "bypass" or empty does not.

**Cross-assignee case**: If the dispatches target DIFFERENT assignees (e.g. one task for sigma, then one for omega), the `allow-no-notify` marker does NOT apply. Use Step 1.3 drain-queue pattern instead: notify each assignee immediately after each `create_task`.

**Step 3 — Assemble the description**

The description MUST contain four blocks in order. Each label is literal — the hook greps for them.

```
[META | ADMIN | MESSAGING (optional, non-batch only)] <one-paragraph brief: what + why + scope boundary>
// allow-no-notify: batch dispatch T<N> mission <missionId> assignee <assignee>, consolidated send_message after batch end
                                                                                    (auto-injected by Step 2.7 if multi-task batch SAME assignee)

Délègue à : subagent_type="<specialist>"
Mode : run_in_background=true
Model : model="sonnet"
                                                                                    (omitted if housekeeping — use delegationOptOut: <reason> instead)

VERIFICATION:
1. <concrete check #1 — file, URL, command, or VP query>
2. <concrete check #2>
3. <concrete check #3 — optional>

TESTS:
<verifiable proof tokens the assignee will cite on completion>
- ratio (e.g. 311/314 passing) OR
- counted artifact (e.g. 18 tests added, 2900 rows) OR
- file path (analysis/report-YYYY-MM-DD.md, qa/screenshots/x.png) OR
- URL / PR# / commit SHA range

IRP:
Input: <starting state — repo path, mission id, PR#, dataset>
Result: <what exists when done — merged PR, published version, file at path>
Postcondition: <observable system state — hook X passes, downstream task Z unblocked>
```

For pure-orchestration tasks (non-batch), the `Délègue à` block is omitted — the `[META]`/`[ADMIN]`/`[MESSAGING]` tag at the top signals the hook to skip the delegation requirement.

Rules for the body:
- No duration phrasings ("takes N hours", "by end of day", "quick fix"). `block-time-estimates.py` rejects.
- No temporal-deferral phrasings ("later", "when we get to it"). `enforce-ship-24-7.py` rejects.
- Brief paragraph ≥1 sentence and names the artifact / system / PR under change.
- VERIFICATION steps are imperative ("Run `npm test`", "Open PR #562", "Query `list_tasks status=todo`"). Not aspirational.
- TESTS must be CONCRETE — what proof token will be produced. "All tests pass" alone is insufficient; cite the ratio shape.

**Step 4 — Create the task**

Call `mcp__vantage-peers__create_task` with EXACTLY these typed params:
- `title`: string — imperative, ≤80 chars, names the artifact.
- `assignedTo`: string — target orchestrator (lowercase).
- `priority`: string — one of `urgent`, `high`, `medium`, `low`.
- `createdBy`: string — your role.
- `description`: string — assembled body from Step 3.
- `missionId`: string — if resolved.
- `dependsOn`: array of strings — prerequisite taskIds (omit or `[]` if none). NEVER a bare token (Day 113 friction j5735jvgwyh5gb2frm21ct5wxh89ezpt).

After successful return:
- Append `(taskId, assignedTo)` to `pending_notify[]` if `priority` is `urgent` or `high` and NOT in a same-assignee batch (i.e. not covered by Step 2.7 consolidated end-of-batch send_message).
- Step 5 will drain this entry by emitting the same-turn `send_message`.

If the hook rejects, re-check the literal block headers, re-add missing markers, and re-call. Do NOT use opt-out markers unrelated to the specific hook.

**Step 5 — Confirm + drain notify queue + suggest next action**

1. Display the returned `taskId` and a one-line summary.
2. **Drain notify queue NOW** for the entry just appended in Step 4 (if any). Emit `mcp__vantage-peers__send_message channel=<assignee>` with the canonical grid (see Step 1.3 template). Remove the entry from `pending_notify[]` on success.
3. Suggest the next action:
   - Single task complete: surface taskId + suggest peer follow-up (start_task on next cycle).
   - Multi-task batch dispatch IN PROGRESS (same assignee): suggest continuing batch with next `create_task`; skill tracks count + marker.
   - Multi-task batch dispatch AT END (same assignee): emit consolidated `send_message` per Step 2.7.
   - Cross-assignee sequential dispatch: surface taskId + remind caller that the next dispatch (different assignee) must wait for THIS one's notify (already done in step 2 above).
   - Unresolved prerequisites: suggest `block_task` until deps land, or `add_task_dependency` to wire them.
   - First task of a new mission: suggest `dispatch-task-start` once the assignee accepts.

## RULES

- NEVER call `create_task` without literal `VERIFICATION:` and `TESTS:` labels in `description`. `enforce-task-quality.py` BLOCKS otherwise.
- NEVER call `create_task` for a BATCH operation without the delegation triplet. `enforce-pi-task-doctrine.py` BLOCKS otherwise. Reference: doctrine memory j57ehd9psbx4z721sb7hggqse987fhtk + feedback memory j5757xkcgeqd07mr9zjx1p5cn585p9wy.
- NEVER call `create_task urgent|high` 2+ times targeting the SAME `(missionId, assignedTo)` without injecting the `// allow-no-notify: batch dispatch ...` marker on the 2nd+ task. `enforce-create-task-notify-followup.py` BLOCKS otherwise. Reference: RULE #21 doctrine memory j57f7wn5qwhb7nynjp7r57tnsx88ktt5.
- **NEVER call `create_task urgent|high` for assignee B while a previous `create_task urgent|high` for assignee A (same turn, different assignee) lacks its `send_message channel=A` follow-up.** The hook scans ALL pending un-notified urgent/high tasks across all assignees. Resolution: emit the pending notify(s) BEFORE the next dispatch (Step 1.3 drain). Reference: friction memory j5712431qyyjv0fgvw5agc1ffx89fm9m (Day 114, 5× recurrence).
- After the LAST task of a multi-task batch (same assignee), ALWAYS emit ONE consolidated `send_message` to the assignee. Without it, the assignee orchestrator does not know the batch landed.
- For cross-assignee sequential dispatch, emit per-task `send_message` IMMEDIATELY after each `create_task`, in the same turn — never batch the notifies.
- Include the IRP block (Input / Result / Postcondition) — downstream skills read it.
- No duration estimates or temporal-deferral phrasing anywhere in title or description.
- `createdBy` MUST be your actual role, not a placeholder.
- `dependsOn` MUST be an array of strings, EVEN for a single predecessor. Wrap in `[...]`.
- Title is imperative and names the artifact. Vague titles are rejected.

## EXAMPLES

### Cross-assignee sequential dispatch (Step 1.3 drain pattern, v1.0.7)

```
# Turn step 1 — create task A for sigma
create_task(assignedTo=sigma, priority=high, description=[META] T0 ...)
-> taskId k176a — appended to pending_notify[]

# Turn step 2 — DRAIN immediately (Step 5)
send_message(channel=sigma, content=[INFO ONLY] task k176a ...)
-> pending_notify[] cleared for k176a

# Turn step 3 — create task B for omega (queue is empty, proceed)
create_task(assignedTo=omega, priority=high, description=[META] T0 ...)
-> taskId k176b — appended to pending_notify[]

# Turn step 4 — DRAIN immediately
send_message(channel=omega, content=[INFO ONLY] task k176b ...)
```

### Multi-task batch dispatch SAME assignee (Step 2.7 marker)

```
# Task 1 (no marker, first task)
description = """[META] T0 PREFLIGHT mission vr-rules-type-v1 — scope confirm + audit.

Délègue à : subagent_type="dev-tech-researcher"
Mode : run_in_background=true
Model : model="sonnet"
...
"""

# Task 2 (marker auto-injected by Step 2.7 — 2nd task same mission same assignee)
description = """[META] T1 mission vr-rules-type-v1 — backend rules table.
// allow-no-notify: batch dispatch T1 mission k571snz assignee omega, consolidated send_message after batch end

Délègue à : subagent_type="dev-convex-expert"
...
"""

# Task N (LAST in batch — same marker AND skill emits consolidated send_message after create_task returns)
description = """[META] T5 mission vr-rules-type-v1 — closure.
// allow-no-notify: batch dispatch T5 mission k571snz assignee omega, consolidated send_message after batch end
...
"""
# AFTER returning, skill emits:
# send_message channel=omega content=[STATUS] mission k571snz batch dispatched T0..T5 ...
```

### Single-task dispatch (no marker — normal send_message follows)

```
description = """[META] Pi merge authorization — PR #229 vantage-registry.

VERIFICATION: ...
TESTS: ...
IRP: ...
"""
# AFTER returning, skill drains pending_notify[] for THIS task — emits send_message channel=omega.
```

## ANTI-PATTERNS (refused)

- ❌ Batch op without delegation triplet — hook blocks even with [META] tag.
- ❌ 2nd+ urgent/high create_task same assignee without `// allow-no-notify` marker — hook blocks.
- ❌ Cross-assignee parallel `create_task urgent|high` calls in one tool batch — hook blocks on 2nd because 1st is un-notified. Use Step 1.3 sequential drain.
- ❌ Multi-task batch with NO consolidated send_message at end — assignee orchestrator never picks up.
- ❌ `dependsOn: "k17xxx..."` (bare string) — must be `["k17xxx..."]` array.
- ❌ Title naming the team but not the artifact ("Help Sigma fix something").
- ❌ Tagging real batch work as `[META]` to bypass delegation — hook detects keywords.
- ❌ Skipping the per-turn drain because "all dispatches happen quickly" — the hook fires synchronously per call, not at end of turn.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=dispatch-task-create`. Re-sync local copies byte-exact whenever VR is updated.

## SELLABLE AS

`vantage-peers` plugin — pre-formats `create_task` calls with the VERIFICATION + TESTS + IRP blocks the `enforce-task-quality` hook requires, the delegation triplet the `enforce-pi-task-doctrine` hook requires for batch ops, the `allow-no-notify` marker the `enforce-create-task-notify-followup` hook requires for same-assignee multi-task dispatches, AND the drain-notify-queue check (v1.0.7 Step 1.3) that prevents cross-assignee dispatch blocks, so dispatched work never blocks on any of the four hook patterns.
