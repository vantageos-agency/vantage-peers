---
section: Added
---
- **The operator onboards a new client org from the dashboard with his own Clerk session.** `oauth:provisionOrganization` accepts, without a master bearer, a verified `org:admin` of the operator organisation (`orgKind: "operator"`) creating an org whose slug has no mapping yet; the new mapping is `orgKind: "client"`. Existing orgs, the operator slug, non-admin operator members, client-org admins and anonymous callers are refused `RBAC_DENIED` with a reason. Master path unchanged. Tests: `convex/__tests__/provisionOrgOperatorAdmin.test.ts`.
