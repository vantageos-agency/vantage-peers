---
section: Fixed
---
- **`clientOrgMapping:setAddressableFleetCoordinators` no longer scans the whole `client_org_mapping` table.** The operator-roster lookup now reads only active rows through `by_isActive` with a 500-row cap and fails closed with `ORG_MAPPING_SCAN_CAP_EXCEEDED` instead of validating against a partial roster; args, return shape and existing error codes are unchanged. Closes the one R-31 violation PR #1470 introduced (task k176aa231w1te2er5w38vkan898fsgpx). Evidence: `convex/__tests__/directMessageFleetCoordinatorsBounded.test.ts` 3/3, 1/3 red before the fix.
