---
section: Changed
---
- **VantagePeers Cloud ops: the seat-memory org-stamp backfill now returns the ids it stamps and has a rollback door.** `migrations/backfill_seat_memory_org_stamp:run` additionally returns `stamped: [{ slug, ids }]` for the page (the ids it would stamp in a dry run, the ids it did stamp in a write, same shape), so the ids per org can be saved as the rollback list. New `migrations/backfill_seat_memory_org_stamp:revert` takes `{ ids, dryRun? }` (at most 200 per call, dry run by default) and unsets `clerkOrgId` only on rows in `project/<slug>` whose current stamp equals what `run` would write; every other row is skipped and counted. Selection rule, counts and `pageSize` cap are unchanged. Task k174d9hcb0h9vdsny1qcveqzjs8hdrmt.
