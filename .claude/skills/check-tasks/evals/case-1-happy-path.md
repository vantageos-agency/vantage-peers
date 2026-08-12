# Case 1 — Happy path (default list)

## Input
User prompt: `check tasks`
Workspace CLAUDE.md header: `You are Sigma`.

## Expected behavior
- Detect role=`sigma` from CLAUDE.md (Step 1).
- Single call to `mcp__vantage-peers__list_tasks` with `assignedTo="sigma"`, `status="todo"`, `fields="lite"`, `limit=20`.
- Client-side sort: urgent > high > medium > low, then `_creationTime` asc.
- Render compact table with NEXT line on top.

## Hooks pre-satisfied
- Envelope cap `capListResponseBytes=60000` respected (fields=lite + limit=20).
- READ-ONLY — no `start_task` / `complete_task` invocation, so `enforce-irp-sequence` and `enforce-evidence-bound-completion` are not triggered.

## PASS criteria
Output begins with `TASKS (sigma) —` header, includes a `NEXT` line, no envelope truncation marker, no write tool was called.
