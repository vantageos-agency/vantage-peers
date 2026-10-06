---
section: Fixed
---
- **Four R-52 cross-tenant write sites closed.** `diary` and `businessUnits` gain an optional `orgId` stamp, derived from the caller's verified scope at insert. `businessUnits:update`, `diary:write` and `diary:deleteDiary` now refuse an org caller whose org is not the row's stamp (an unstamped row is refused to org callers; master is unchanged). `tasks:complete` auto-completes only a mission whose stamp equals the task's own. `backfill_org_stamp` gains the `diary` and `businessUnits` tables: run it for both before deploying, or org members lose writes on legacy rows.
