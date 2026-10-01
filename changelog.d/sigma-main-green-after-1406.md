---
section: Fixed
---
- **Main is green again after #1406.** Seven tests still pinned the behaviour #1406 changed. No runtime logic changes.
  - The `deleteMessage` fixtures now stamp `tenantId`, as `sendMessage` does. A new pole pins the tenant gate: a member deleting another org's message gets `message-tenant-mismatch`.
  - `preOrgTypedRefusal` now asserts the refusal envelope from `getProjectSummary`, and the coded `RBAC_DENIED` raise from `getDashboardSummary` and `orchestratorStats` at a signed-in caller with no organisation. Both raising reads carry an `isolation-contract:` marker: the dashboard's org gate (dashboard PR #62) never mounts their pages for such a caller.
  - `.backend-doctor/vp-by-tool.csv` is regenerated: the OKF export/import doors resolve their caller through `withOrgScope` (#1399, #1401).
