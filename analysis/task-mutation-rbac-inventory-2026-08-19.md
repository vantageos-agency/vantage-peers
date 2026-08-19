# Task-surface mutation RBAC inventory — TIER vs RELATIONSHIP

**Task:** k174gxk83f3rqhdx633863te1x8csz0k (Pi-specified). Measurement only — no code change, no PR, no fix.
**Instrument:** `/root/coding/backend-doctor` (commit `git -C /root/coding/backend-doctor rev-parse HEAD` — see COVERAGE section), detectors `R6`/`R16`/`scanR6`/`scanR16` from `src/detectors/source/identity.ts`, run unmodified via `runDoctor()` from `@vantageos/mcp-doctor` — **no new detector authored**.
**Standard:** `analysis/vantagepeers/backend-standard/backend-standard.md` @ ElPi-Corp `a9d7877b` (rules R-5, R-6, R-7, R-10, R-11, R-28 — the standard file itself is not re-vendored here; only its rule IDs and definitions are cited, matching what the instrument's own header comments pin to `3ae97cd` for R-6/R-16 specifically — see caveat in COVERAGE below).
**Target surface:** `/root/coding/vantage-memory/convex/tasks.ts` (+ `schema.ts` referenced for field context).

## Command trail

1. Served task-mutation surface, derived from the MCP tool inventory (not hand-typed):
   ```
   grep -n "defineTool(" /root/coding/vantage-memory/mcp-server/src/tools.ts | wc -l   # 90 total tools
   grep -n "\"[a-z_]*task[a-z_]*\"," mcp-server/src/tools.ts   # tool-name string literals containing "task"
   ```
   For each task-named tool, the `convex.mutation("tasks:<fn>" as any, ...)` call inside its handler body was grepped to resolve the served-tool → convex-mutation mapping (command: `sed -n '<toolstart>,+150p' tools.ts | grep -n 'api\.\|mutation('`).

2. R-6 (write boundary from verified identity vs caller argument) and R-16 (structured refusal code), run via the instrument's OWN static scanner, unmodified:
   ```
   node /root/coding/backend-doctor/run-vp-tasks-detail.mjs
   ```
   (script imports `scanR6`, `scanR16` from `dist/detectors/source/identity.js`, calls `runDoctor("/root/coding/vantage-memory", [captureDetector])`, filters sites to `convex/tasks.ts`). Full tree-wide run (all convex/*.ts, not filtered) via:
   ```
   node /root/coding/backend-doctor/run-vp-tasks-audit.mjs
   ```

3. Column 3 (TIER vs RELATIONSHIP) and column 5 (predicate locus) are **not** columns the instrument's R-6/R-16 detectors emit directly — R-6 emits "identity/resource guard present or not", not the tier-vs-relationship distinction itself. These two columns were filled BY HAND reading `convex/tasks.ts` at the cited line, per the task brief's instruction ("where you must read tasks.ts by hand to fill a column, say so and cite the line"). Every row below states this explicitly.

## THE INVENTORY

One row per served task mutation. `TOOL` = the MCP tool name (from tools.ts); `MUTATION` = the convex/tasks.ts export it calls.

| # | TOOL → MUTATION | verb (R-2) | reader/writer tier declared? (R-5/R-10) | TIER vs RELATIONSHIP | boundary source (R-6) | predicate locus (R-11) | remediation owed (R-28) |
|---|---|---|---|---|---|---|---|
| 1 | `create_task` → `create` (tasks.ts:228) | create | **absent** — no reader/writer tier of any kind | **NEITHER** — no check at all; `createdBy` is accepted as a plain caller-supplied string argument and inserted verbatim, no guard, no comparison of any kind (hand-read: tasks.ts:244-263, `ctx.db.insert("tasks", {...args, ...})`) | **caller-supplied argument** — `createdBy` written straight from `args.createdBy` with zero guard. backend-doctor `scanR6` VIOLATE at tasks.ts:262 (`create: writes a boundary field ... taken from a caller argument with no identity/resource guard`) | n/a — no predicate exists to have a locus | **CORRIGER**: add a resource/identity guard before insert, or explicitly document (with a written justification, R-7-style) why a fleet-internal "any orchestrator can create a task for any owner" model is intended |
| 2 | `update_task` → `update` (tasks.ts:973) | update | present, merged single column (R-14 defect — see COVERAGE) | **RELATIONSHIP** — `assertTaskCallerAuthorized` (tasks.ts:96-115): `task.createdBy === callerOrchestrator \|\| task.assignedTo === callerOrchestrator \|\| callerOrchestrator === "system"`. A caller-supplied NAME string compared against the target row's stored NAME fields — never a tier (public/org-member/org-admin/fleet-internal/master) resolved from a verified identity claim. Hand-read: tasks.ts:106-109 | resource-derived (target row) — backend-doctor `scanR6` CONFORM at tasks.ts:1110 (guard present) — but "conform" per R-6 only means *a* guard exists, it does NOT mean the guard is tier-based; R-6 does not distinguish relationship-guard from tier-guard (see COVERAGE caveat) | inside the mutation body, before the `ctx.db.patch` | **CORRIGER**: resolve caller identity to a tier (fleet-internal/org-admin/etc.) via a verified claim, not a name-equality test against the target row |
| 3 | `complete_task` → `complete` (tasks.ts:1366) | transition | same merged column | **RELATIONSHIP** — same `assertTaskCallerAuthorized` call, tasks.ts:1380 | resource-derived — `scanR6` CONFORM at tasks.ts:1421 | inside mutation body | **CORRIGER**: same as row 2 |
| 4 | `fail_task` → `failTask` (tasks.ts:1607) | transition | same merged column | **RELATIONSHIP** — same `assertTaskCallerAuthorized` call, tasks.ts:1621 | resource-derived — `scanR6` CONFORM at tasks.ts:1660 | inside mutation body | **CORRIGER**: same as row 2 |
| 5 | `start_task` → `start` (tasks.ts:1678) | transition | same merged column | **RELATIONSHIP** — `assertTaskCallerAuthorized` at tasks.ts:1691, PLUS a second, separate RELATIONSHIP check at tasks.ts:1717-1735 (`args.callerOrchestrator !== "system"` gates a concurrency-conflict query keyed on `assignedTo === callerOrc`, hand-read) | resource-derived — `scanR6` CONFORM at tasks.ts:1741 | inside mutation body (two separate predicate blocks, both inside) | **CORRIGER**: same as row 2 |
| 6 | `checkout_task` → `checkout` (tasks.ts:1754) | transition | **absent** | **NEITHER** — no authorization check of any kind; only a status-state check (`task.status !== "todo"`). Any caller can claim any unclaimed task (hand-read: tasks.ts:1754-1778) | none — `callerInstance` is written but never checked against anything; not a boundary field in the R-6 sense, so backend-doctor's `scanR6` returns `could-not-judge` at tasks.ts:1772 ("no identity/resource guard and no clearly caller-supplied boundary field") — the instrument correctly abstains rather than false-passing | n/a | **REVOIR** (human judgment owed, per R-7/R-8 could-not-judge convention): is "any orchestrator may claim any todo task" the intended fleet model, or is this a missing guard? |
| 7 | `delete_task` → `deleteTask` (tasks.ts:1786) | delete | **absent** as a distinct tier; inline relationship check only | **RELATIONSHIP** — inline (not via the shared helper): `args.callerOrchestrator !== "system" && task.createdBy !== args.callerOrchestrator` throws RBAC_DENIED (tasks.ts:1804-1810, hand-read) | resource-derived — `scanR6` CONFORM at tasks.ts:1813 | inside mutation body | **CORRIGER**: same as row 2; additionally note this is a THIRD independent reimplementation of the same relationship logic (not shared with `assertTaskCallerAuthorized`) — a duplication risk R-7 would also flag |
| 8 | `block_task` → `blockTask` (tasks.ts:1248) | transition | same merged column | **RELATIONSHIP** — `assertTaskCallerAuthorized` at tasks.ts:1267 | resource-derived — `scanR6` CONFORM at tasks.ts:1321 | inside mutation body | **CORRIGER**: same as row 2 |
| 9 | `bulk_complete_tasks` → `bulkComplete` (tasks.ts:2355) | bulk-write | same merged column | **RELATIONSHIP** — tasks.ts:2467-2476 (hand-read): `args.callerOrchestrator !== undefined && args.callerOrchestrator !== "system"` then `cappedResults.find(r => r.createdBy !== caller && r.assignedTo !== caller)` — per-row name comparison against a caller-supplied string, same class as `assertTaskCallerAuthorized` but a 4th independent reimplementation | mixed — `assignedTo` filter is a **caller-supplied argument** used to SCOPE the read (not a boundary on the write itself); the actual authorization gate reads the resolved rows' `createdBy`/`assignedTo`, so it is resource-derived once rows are fetched. backend-doctor `scanR6`: this mutation is NOT one of the sites captured in the tasks.ts-filtered scan output (bulkComplete's write is a loop `ctx.db.patch` inside `outer:` — confirm via `grep -n "ctx.db.patch" tasks.ts` shows the writes at ~2355-2556 region; the per-mutation-handler splitter in `scanR6` may have folded this write under the same handler as the auth check, giving CONFORM implicitly — **not independently re-verified column-by-column here, flagged as a gap**) | inside mutation body | **CORRIGER**: same relationship→tier fix; **also** consolidate the 4 independent reimplementations (rows 2-5/8 via the shared helper, row 7 inline, row 9 inline) into one authority-tier resolver, per R-7 coherence |
| 10 | `add_task_dependency` → `update` (tasks.ts:973, same mutation as row 2) | update | same merged column | **RELATIONSHIP** — identical to row 2 (same underlying mutation, different MCP-layer argument shaping) | resource-derived — same as row 2 | inside mutation body | **CORRIGER**: same as row 2 (fixing row 2 fixes this tool too — it is the same Convex mutation) |

### Non-served mutations in tasks.ts — SKIPPED, with reason

These export a Convex `internalMutation`, not a `mutation`, and are called only from crons/webhooks/actions internal to the deployment — they are **not** in the MCP tool inventory (`mcp-server/src/tools.ts`), so they are not part of the "task-surface mutations" this audit's brief scopes to (a caller of the served MCP surface can never reach them directly):

- `createDeployTaskWithDedup` (tasks.ts:2027) — `internalMutation`. `scanR6` VIOLATE at tasks.ts:2051 (caller-arg boundary, no guard) — noted for completeness, not counted in the headline (internal, not caller-reachable).
- `resolveStaleDeployTasks` (tasks.ts:2187) — `internalMutation`. `scanR6` CNJ at tasks.ts:2273.
- `createOrUpdateReviewTask` (tasks.ts:2944) — `internalMutation`. `scanR6` VIOLATE at tasks.ts:2972.
- `closeReviewTasksForPr` (tasks.ts:3008) — `internalMutation`. `scanR6` CNJ at tasks.ts:3024.

Confirmed non-served by grep: `grep -n "tasks:createDeployTaskWithDedup\|tasks:resolveStaleDeployTasks\|tasks:createOrUpdateReviewTask\|tasks:closeReviewTasksForPr" mcp-server/src/tools.ts` returns zero matches.

## COVERAGE assertion

Served task-mutation surface = 10 rows (9 distinct MCP tool names; `add_task_dependency` and `update_task` both call the same `update` mutation, counted as 2 surface rows because they are 2 distinct served tools per the brief's "served task-mutation surface... derive from the MCP tool inventory" instruction).

- Command producing the served surface: `grep -n '"[a-z_]*task[a-z_]*",' mcp-server/src/tools.ts` (tool-name literals) cross-referenced against `grep -n 'convex.mutation("tasks:' mcp-server/src/*.ts` (resolves each tool → mutation).
- 10 rows analysed, covering 9 distinct `mutation` exports (row 10 `add_task_dependency` reuses the same `update` export as row 2) + 4 skipped-with-reason `internalMutation` exports = 13 tasks.ts mutation/internalMutation exports total. Verified: `grep -n "^export const .* = mutation(" convex/tasks.ts` = 9 hits; `grep -n "^export const .* = internalMutation(" convex/tasks.ts` = 4 hits; 9+4=13.
- Nothing neither analysed nor exempted: all 13 `mutation`/`internalMutation` exports in tasks.ts are accounted for above (9 exports analysed via 10 served-tool rows + 4 exports skipped with a written reason).

**Caveat on instrument provenance (honest, not folded into the headline):** the backend-doctor `R6`/`R16` detectors' file header cites standard pin `3ae97cd4ca751d1a8d6a7bc9b4eb2926bbc84889`, not the task brief's `a9d7877b`. Both are ElPi-Corp `backend-standard.md` commits; this audit did NOT diff the two pins to confirm R-6/R-10/R-5's definitions are byte-identical between them — flagged as could-not-judge on pin equivalence, not silently assumed identical. R-10 and R-14/R-38's headline claim ("32 of 52 public writes test relationship not tier," "single merged rbac_qui column") is the STANDARD's own prior finding across the full oracle inventory, not something this audit re-derives fleet-wide — this audit only re-confirms the pattern holds, mutation-by-mutation, on the tasks.ts slice, by hand + backend-doctor's R-6/R-16 static scan.

## THE HEADLINE

**Of the 10 served task-mutation surface rows, 8 test a RELATIONSHIP (caller-supplied name compared against the target row's stored name field, or against another caller-supplied argument) rather than a resolved authority TIER. 2 rows (`create_task`, `checkout_task`) have NEITHER a relationship nor a tier check — no authorization predicate at all.**

Breakdown: 8 RELATIONSHIP (rows 2,3,4,5,7,8,9,10) + 2 NEITHER (rows 1,6) + 0 TIER. Zero of the 10 rows resolve a tier (public/org-member/org-admin/fleet-internal/master) from a verified identity claim before authorizing the write — every gate that exists is a name-equality test, exactly the R-10 defect the standard names ("writer authority is not recorded as a field distinct from reader authority — both merged into the single `rbac_qui` column," and separately, R-5's "a tier read from an argument is not a tier").

If counting "tests a relationship rather than a tier" strictly as its own bucket (excluding the 2 no-check rows, since they test neither), the count is **8 of 10**. If counting "does not enforce a resolved tier" (relationship OR no-check), the count is **10 of 10**.

## Where backend-doctor's detector ran vs where read by hand

- **Ran mechanically** (backend-doctor `scanR6`/`scanR16`, unmodified, via `runDoctor`): the boundary-source classification (identity/resource guard present vs caller-argument vs neither) for every write handler in `convex/tasks.ts` — columns 4 ("boundary source") for rows 1-8, and the CONFORM/VIOLATE/CNJ site list in the "non-served" section. Full raw output captured in `/root/coding/backend-doctor/run-vp-tasks-detail.mjs` output (rerun to reproduce) and `/root/coding/backend-doctor/run-vp-tasks-audit.mjs` (tree-wide rollup: 40 R-6 violations, 21 conforms, 92 could-not-judge across the WHOLE convex/ tree, not just tasks.ts).
- **Read by hand, cited by line**: column 3 (TIER vs RELATIONSHIP) for every row — this distinction is not a column any backend-doctor detector emits (R-6 only classifies guard-present/absent/argument, not relationship-vs-tier); column 5 (predicate locus) for every row; row 9's write-site independent confirmation (flagged as a gap, not silently passed); the MCP tool → convex mutation mapping (grep-derived, not detector-derived — backend-doctor has no MCP-tools.ts reader).
