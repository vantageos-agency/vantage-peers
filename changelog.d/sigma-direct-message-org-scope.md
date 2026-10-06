---
section: Security
---
- **A client organisation can no longer send a direct message to another organisation's orchestrator or to the fleet.** `sendMessage`'s direct-channel branch resolved recipients from every profile (measured on prod 2026-10-06: a client seat reached a fleet orchestrator). Recipients are now bounded, in Convex, to the caller's own roster plus an explicit, data-held allow-list `client_org_mapping.addressableFleetCoordinators` (empty by default, never inferred, `["*"]` never a grant), set only through the internal mutation `clientOrgMapping:setAddressableFleetCoordinators` (operator-org names only). A foreign part refuses the whole send with the existing recipient-error bounce; the internal master is unchanged.
