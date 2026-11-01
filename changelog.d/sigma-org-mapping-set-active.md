---
section: Added
---
- **`clientOrgMapping:setActive`, the one operator instrument to switch an organisation's mapping off or back on.** Internal mutation, by label: refuses an unknown label and an ambiguous one (both row IDs named); deactivating a row that carries a permanent Clerk org ID is refused unless `force: true`; re-activating needs no force; the same value writes nothing (`changed: false`). It returns the full row before and after. A deactivated mapping is refused by `withOrgScope` for its members; rows keyed by the org (agents, tokens) are left in place. Backend contract unchanged (internal function). Task k172a8q010wagrb10wapg1b95s8g2a84.
