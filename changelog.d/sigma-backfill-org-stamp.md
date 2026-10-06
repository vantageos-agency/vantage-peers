---
section: Added
---
- **`backfill_org_stamp` migration stamps unstamped rows with their org or the fleet scope.** Internal, dry run by default, cursor-paginated, idempotent (`convex/migrations/backfill_org_stamp.ts`). Fleet rows carry `FLEET_SCOPE_ORG_ID` (`vantageos:fleet`); `tasks.complete`'s fleet-repo gate (`taskMayReachFleetRepoRows`) now admits that stamp, so a stamped fleet task still auto-links and fixes its issue. `fleetOrgStamp.ts` is superseded and must not be run.
