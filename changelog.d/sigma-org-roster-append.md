---
section: Added
---
- **A client org's roster can now be appended to after creation.** `clientOrgMapping:addRosterMembers` (internal mutation, operator-run via `npx convex run`) appends normalised names to `client_org_mapping.allowedOrchestrators`: append-only (never removes or reorders), de-duplicated, client orgs only (the operator org and inactive orgs are refused), names must match `^[a-z][a-z0-9-]{0,40}$` (`*` and empty refused), and a name on an active operator org's roster (pi, sigma) is refused. Returns `{clerkOrgSlug, previous, current}`. No schema change. Task k173nws3xcp969t7dtvet5zqd58fr8gr (first use: agent "bob" in cgt-alsachimie). Tests: `convex/__tests__/orgRosterAppend.test.ts` 15/15. `runbooks/onboard-client-org.md` step 2 updated.
