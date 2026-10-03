---
section: Fixed
---
- **An organisation member can list its own tasks.** `tasks:list` for a non-master caller now reads org-keyed indexes (`by_orgId_status`, `by_orgId_assignee_status`, `by_orgId_project_status`, …) instead of scanning fleet-wide indexes and filtering by org afterwards, which threw `SCAN_CAP_EXCEEDED` for a member of the fleet org on prod. Isolation unchanged (unstamped rows stay master-only). New dry-run-able backfill `migrations/fleetOrgStamp:run` stamps fleet rows only where attribution is provable. Evidence: `convex/__tests__/memberReadsOrgKeyed.test.ts` 11/11, red 3 before.
