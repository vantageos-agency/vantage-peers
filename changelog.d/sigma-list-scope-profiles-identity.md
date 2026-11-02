---
section: Changed
---
- **VantagePeers Cloud ops: `run oauth:listScopeProfiles` now shows each profile's `agentId` and `clerkOrgId`.** Both are read-only and absent (not null) when the stored row has none. The query has its own output shape; `scopeProfileShape` (the `upsertScopeProfile` argument and the `getScopeProfile` return) is unchanged, and `scripts/seat-profile-agent-namespace.mjs` still writes only the fields it builds itself. Internal query, backend contract unchanged. Task k177pske4qj37sfw7nw2787msd8fzp0e.
