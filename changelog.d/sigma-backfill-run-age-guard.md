---
section: Fixed
---
- **`backfill_org_clerk_id:run` no longer writes a slug's current holder onto a row it did not stamp.** The backfill resolved every row's org ID from the CURRENT `client_org_mapping` with no age comparison, so a slug that changed hands wrote the new holder's ID onto the former holder's row, on all 19 tables. `run` now goes through the shared guarded resolve `resolveSlugForRow` (also used by `clerkOrgIdCoverage` and `tenantOrgIdCoverage`): a mapping created after the row, or an inactive one, leaves the row unwritten and listed as `mappingNewerThanRow` / `inactiveMapping`. A sweep fails the build on any other caller of the raw `resolveSlug(`. Evidence: `convex/__tests__/backfillRunAgeGuard.test.ts`.
