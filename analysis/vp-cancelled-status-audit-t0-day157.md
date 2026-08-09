# T0 Audit — `cancelled` task status + `delete_task` guard message

Mission `vp-fix-cancelled-status-v1` (k576vya59gycygdaq09wsczpq18c5qh0), task T0 (k1762t1hejgp9ykb3fc9njbpe18c436a).
Read-only. Tree proven synced: HEAD == origin/main == `7b187b7a9f291de58534243d583c90e9fc323205` (`git fetch origin` + `rev-parse` equality). Facts only, each with file:line.

## 1. Status enum — defined in THREE places, all must gain `cancelled`

| # | Location | Role |
|---|---|---|
| 1 | `convex/schema.ts:241-247` | tasks table `status` union — the DB-level validator; `ctx.db.patch` with an unknown status is rejected here. Currently `todo\|in_progress\|review\|blocked\|done`. |
| 2 | `convex/tasks.ts:28-34` (`statusValidator`) | arg validator on mutations — referenced at `:140`, `:197`, `:740`, `:817` (update/start/complete/recurring). Same 5 literals. |
| 3 | `convex/tasks.ts:37-43` (`TASK_STATUSES` runtime array) | used by `expandTaskStatuses` for runtime `.includes()` validation (`:110`, `:121`). `type TaskStatus` derives from it (`:44`). |

There is **no status-transition state machine**. Status is set freely by `update`/`start`/`complete`. The only conditional gate is the closure gate fired when `patch.status === "done"` (`convex/tasks.ts:851`, and inside `complete`) via `enforceClosureGate` (machine-timestamp/actualMinutes requirement). No code restricts which status→status transitions are legal.

## 2. `open`/`active` aliases — `expandTaskStatuses` (`convex/tasks.ts:96-125`)

- `"open"` → `["todo","in_progress","review","blocked"]` (`:119`) — enumerated explicitly, **excludes `done`**.
- `"active"` → `["todo","in_progress"]` (`:120`).
- `"all"` → `undefined` (no filter) (`:100`).
- Aliases forbidden inside an array (`:105-108`).

**Consequence for `cancelled`:** because `"open"` and `"active"` enumerate the actionable statuses explicitly, a new terminal `cancelled` is **naturally excluded** from both — no change needed at `:119-120` to keep cancelled out of actionable queues. (`"all"` returns undefined = includes it, which is correct for audits.)

## 3. `delete_task` guard

- **Client-side PreToolUse hook** `.claude/hooks/block-delete-on-prod.py:26-33`. Blocks `mcp__vantage-peers__delete_task` / `delete_mission` / `delete_message` (`:16-20`), exit 2. Exact current message:
  ```
  BLOCKED: Destructive operations are not allowed on production data.
  Use complete_task with a completionNote instead of delete_task.
  Close tasks, never delete them.
  ```
- **Backend mutation** `convex/tasks.ts:1206-1236` (`deleteTask`) — owner-only hard delete: requires `callerOrchestrator` (`:1219-1223`), only `createdBy` or `"system"` may delete (`:1224-1231`). No message leak.

### Audit finding on the "Respond with exactly: …" leak Pi reported
`grep -rn "Respond with exactly"` over `.claude/`, `convex/`, `mcp-server/`, and `/home/elpi/.claude/` hooks returns **zero** matches (only the session-transcript `.jsonl` echoes it). **The leak is NOT reproducible in this workspace's `delete_task` guard.** The VP guard message (block-delete-on-prod.py) is clean but is still sub-optimal: it points the user to `complete_task`, which falsifies an erroneous task as `done`. That is the real defect to fix (redirect to the new cancel path), independent of the phantom leak string.

## 4. Insertion points for T1 (fix)

1. `convex/schema.ts:241-247` — add `v.literal("cancelled")` to tasks `status` union; add optional `cancelledBy` (creatorValidator) + `cancelReason` (string) fields to the tasks table.
2. `convex/tasks.ts:28-34` — add `cancelled` to `statusValidator`.
3. `convex/tasks.ts:37-43` — add `"cancelled"` to `TASK_STATUSES`.
4. New mutation `cancelTask({ taskId, callerOrchestrator, reason })` — creator-only RBAC mirroring `deleteTask:1219-1231`; sets `status:"cancelled"`, `cancelledBy`, `cancelReason`; `reason` required (non-empty). Keeps cancelled out of `open`/`active` automatically (§2).
5. `.claude/hooks/block-delete-on-prod.py:27-31` — rewrite message: human-readable, redirect to `cancel_task` (not `complete_task`), no internal directive phrasing.
6. `mcp-server/src/tools.ts` — new `cancel_task` MCP tool (RULE #24 schema-mirror; `enforce-mcp-tool-coverage-schema-mirror.py` requires an `mcp-server/src/tools/*` edit in the same commit that touches `convex/schema.ts`). Model on `delete_task` at `:4454-4490`.

TDD strict for T1: RED tests first — (a) `cancelTask` sets `cancelled` + stores creator/reason; (b) non-creator refused; (c) cancelled excluded from `list status="open"`/`"active"`, included in `"all"`; (d) empty reason rejected.
