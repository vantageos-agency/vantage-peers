---
section: Security
---
- **An OAuth access token reads the organisation it was minted for, by its permanent ID, not by a slug another organisation can take over (VantagePeers Cloud).** `orgRoster:getAgentDirectoryForAccessToken` looked up the token's mapping by `clerkOrgSlug`; after organisation A was renamed and organisation B took the slug, A's token listed B's agents. The lookup is now keyed on the token's `clerkOrgId`. A token row stamped with a slug only (no `clerkOrgId`) is refused (`RBAC_DENIED`), never matched by slug, as the person-refresh path already does. Public arguments and returns are unchanged. Pinned by `convex/__tests__/tokenMappingSlugTakeover.test.ts`.
