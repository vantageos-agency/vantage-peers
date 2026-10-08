# Runbook: org identity by Clerk org ID, expand phase (VantagePeers Cloud)

Product: VantagePeers Cloud (multi-tenant). Not applicable to Self-host.

Rule: an organisation is identified by its permanent Clerk org id (`org_...`), never by its
slug (a label that can be renamed). This change only ADDS and BACKFILLS the id; every door
still compares slugs until the lanes switch to ids.

## Deploy order (each step is its own task, target named explicitly)

1. Deploy the schema and functions (columns are optional, nothing reads them yet).
2. Fill the mappings, dry run first:
   `node scripts/fill-mapping-clerk-org-id.mjs --target prod` (reads inventory, writes nothing),
   then `--apply`. Rows reported CONFLICT or UNRESOLVED are fixed by hand, never guessed.
3. Inventory: `npx convex run migrations/backfill_org_clerk_id:inventory` (every mapping must
   carry an id, the operator org included).
4. Backfill, one table at a time, dry run first:
   `npx convex run migrations/backfill_org_clerk_id:run '{"table":"missions"}'`, repeat with
   `cursor` until `isDone`, continue with `nextTable`; then the same with `"dryRun":false`.
5. Re-run step 4 as a dry run: `toFill` must be 0; `undecidableRows` lists what needs a decision.

A new organisation's mapping has no id until step 2 is run for it; its rows carry the slug
only until the backfill is re-run.
