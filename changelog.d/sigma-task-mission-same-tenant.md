---
section: Security
---
- **A task may reference only a mission of its own tenant.** `tasks:create` and `tasks:update` now refuse a foreign (or fleet) `missionId` for an organisation caller with the typed refusal `MISSION_FOREIGN_TENANT`, through one shared predicate (`convex/lib/missionTenant.ts`, the R-52 `sameTenantStamp` rule); nothing is written. The fleet master acting for no organisation keeps its reach. The mission auto-complete all-done scan now counts only the mission's own tenant's tasks, so a foreign task row can no longer keep another organisation's mission open. No change to any argument or return shape: no contract bump. Task k175x770r9f6h01xt0wg0hdd798hf8m4.
