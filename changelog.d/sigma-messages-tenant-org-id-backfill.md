---
section: Security
---
- **Data step before the messages-family read switch: `tenantOrgId` is counted and backfilled on `messages` and `messageReceipts`.** New `convex/migrations/tenantOrgIdCoverage.ts` (`count`, and `backfill` that is a dry run by default): a row is filled only from exactly one ACTIVE `client_org_mapping` row that carries an ID and is not newer than the row (slug-changed-hands rows are listed, never written); a row without a slug is left alone, an existing ID is never overwritten. A sweep test pins that every `messages` / `messageReceipts` insert stamps `tenantOrgId` or is a declared fleet site. Evidence: `convex/__tests__/tenantOrgIdCoverage.test.ts` 14/14, red 13/14 on the previous head.
