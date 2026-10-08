---
section: Changed
---
- **`startBinding` proves the org admin BY ID through `@vantageos/cloud-identity`.** The caller is resolved from the Clerk session's `org_id` (matched against `client_org_mapping.clerkOrgId`) and its role is the same token's `org_role`, admitted by the package's `assertOrgAdmin` (`org:admin` only); the local `requireOrgAdmin` session re-read is gone from this door. A session token without `org_id` or `org_role`, an org whose mapping has no `clerkOrgId`, a member, and the fleet service account are refused `RBAC_DENIED`. The install state now carries the Clerk org ID; `completeBindingInternal` re-reads that org and refuses (`org-not-active`) if it was removed or deactivated after the state was issued. Requires `@vantageos/cloud-identity` 0.12.0.
