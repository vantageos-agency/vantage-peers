---
name: dispatch-task-start
description: >
  Wrap `mcp__vantage-peers__start_task` with an automatic stale-in_progress sweep so the `enforce-irp-sequence` hook never blocks the caller. Use this skill whenever the user says "start task <id>", "begin task", "pick up <id>", "start_task" — even if they don't say "dispatch-task-start" explicitly.
description_fr: >
  Encapsule `mcp__vantage-peers__start_task` avec un balayage automatique des `in_progress` traînants afin que le hook `enforce-irp-sequence` ne bloque jamais votre appel. Utilisez ce skill dès que l'utilisateur dit "démarre la tâche <id>", "commence la tâche", "prends <id>" ou "start_task", même sans citer "dispatch-task-start" explicitement.
allowed-tools: "mcp__vantage-peers__start_task, mcp__vantage-peers__list_tasks, mcp__vantage-peers__complete_task, mcp__vantage-peers__block_task"
metadata:
  version: "1.0.0"
  user-invocable: true
license: Proprietary
---

Sweep the caller's prior `in_progress` tasks (close those actually done, block those actually blocked, escalate ambiguous ones) before issuing the `start_task` for the new taskId.

**Canonical source**: VantageRegistry (`get_skill_content name=dispatch-task-start`). The local `.claude/skills/dispatch-task-start/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. Fetch from VR, do not edit locally.

This skill exists because `enforce-irp-sequence.py` rejects any `start_task` call when the caller already has an `in_progress` task. The fix is not to bypass the hook but to pre-satisfy it: sweep first, start second.

## WORKFLOW

**Step 1 — Resolve identity and target**

1. Detect your orchestrator role (and instanceId where applicable) from `CLAUDE.md` header / hostname (sigma, eta, alpha, lambda, tau, phi, omega, zeta, pi, …).
2. Extract the target `taskId` from the user invocation (e.g. `start task k9abc…`, `pick up k9abc…`). If the user did not name a task, halt and ask which task to start — do not guess.

**Step 2 — List your current in_progress tasks**

Call `mcp__vantage-peers__list_tasks` with `assignedTo=<your role>`, `status=in_progress`, `limit=50`. If the list is empty, skip directly to Step 5.

**Step 3 — Classify each stale in_progress task**

For each task returned by Step 2, decide which of three buckets it belongs to. Use the task's `description`, `completionNote` history, linked PR/commit, and your own session context.

Bucket A — **Actually done** (proof of completion is available)
- Examples: PR merged, commit landed, artifact written, tests green, deploy URL live.
- Action: route to the `dispatch-task-complete` skill for this taskId, supplying the verifiable proof token (URL, 7–40-char SHA, `#NNN` PR/issue, VP id `k<…>` / `j<…>` / `m<…>`, ratio like `311/314`, counted artifact like `18 tests`, file path like `analysis/report.md`).
- Never call `complete_task` directly from this skill — `dispatch-task-complete` owns the proof-token formatting that satisfies `enforce-evidence-bound-completion`.

Bucket B — **Actually blocked** (a dependency is missing or upstream failed)
- Examples: depends on another peer's PR that has not merged, blocked on a Convex env var, blocked on Pi/Laurent decision, blocked on Eta APPROVED that has not arrived.
- Action: call `mcp__vantage-peers__block_task` with `taskId=<stale>` and a `reason` that names the concrete blocker (`reason="blocked on PR #573 review — awaiting Eta APPROVED"`, `reason="blocked on AI_GATEWAY_API_KEY env var in Convex prod"`). The reason MUST identify the blocker, not just say "blocked".

Bucket C — **Ambiguous** (cannot determine done vs blocked without a human call)
- Examples: long-running mission you have no recent context on, task description does not match anything in current session, conflicting signals (partial proof but no merge).
- Action: call the `dispatch-message` skill to message the appropriate user (Pi in human-loop fleets, the task `createdBy` peer otherwise) with `[STATUS] task k<stale> — ambiguous in_progress, need disposition (done | block | keep)` and HALT the workflow. Do not start the new task while ambiguous in_progress tasks remain.

**Step 4 — Verify the queue is clear**

Re-call `mcp__vantage-peers__list_tasks` with `assignedTo=<role>` and `status=in_progress`. If still non-empty:
- If only Bucket-C ambiguous tasks remain, you have already halted in Step 3 — exit.
- If Bucket-A / Bucket-B tasks remain, the close/block calls failed; surface the failure to the user and exit. Do NOT call `start_task` while in_progress is non-empty.

**Step 5 — Start the new task**

Call `mcp__vantage-peers__start_task` with the target `taskId` resolved in Step 1. Confirm the return shape (status now `in_progress`, `startedAt` populated) and display a single-line confirmation: `[started] k<id> — <title>`.

If `start_task` still rejects with an `enforce-irp-sequence` violation, re-run Steps 2–4 — a race may have created a new in_progress task since you swept.

**Step 6 — Hand off to execution**

The new task is now `in_progress`. Execution proceeds per its `description` / `VERIFICATION:` / `TESTS:` blocks (IRP doctrine, enforced by `enforce-task-quality` at creation time). When execution completes, the caller invokes the `dispatch-task-complete` skill (which formats the proof token and satisfies `enforce-evidence-bound-completion`).

## RULES

- NEVER call `start_task` before sweeping `in_progress`. The point of this skill is to pre-satisfy `enforce-irp-sequence`; calling start before sweep defeats it.
- NEVER silently close a stale task without a verifiable proof token. Bucket A always routes through `dispatch-task-complete`. A bare `complete_task` here would be rejected by `enforce-evidence-bound-completion` (contentHash `fb62f24e1658f52794b642256500c370bfc1987c4dd5fb9c43217e7848326ab1`).
- Block reasons MUST name the concrete blocker (PR#, peer, env var, decision owner). `"blocked"` alone is not a reason.
- Ambiguous tasks HALT the workflow. Do not guess; dispatch a message and wait. The cost of a wrong silent close (lost work, broken audit trail) far exceeds one round-trip clarification.
- Never start more than one task at a time. IRP doctrine is one-task-in-flight per orchestrator.
- This skill is the ONLY sanctioned wrapper for `start_task` in the fleet. Direct `mcp__vantage-peers__start_task` calls bypass the sweep and will eventually trip the hook.
- Evidence-Bound Done doctrine (Day 76) applies transitively via `dispatch-task-complete`.

## EXAMPLES

See `references/examples.md` for worked invocations covering clean queue, stale-done sweep, stale-blocked sweep, and ambiguous-halt scenarios.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=dispatch-task-start`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly.

## SELLABLE AS

`vantage-peers` plugin — turns the raw `start_task` MCP call into a hook-safe, IRP-compliant transition that sweeps stale in_progress (close-with-proof, block-with-reason, or escalate-ambiguous) before opening the new task, eliminating the most common `enforce-irp-sequence` rejection in the fleet.
