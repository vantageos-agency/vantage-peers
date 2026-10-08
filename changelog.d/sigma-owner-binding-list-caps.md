---
section: Changed
---
- **Owner-binding reads are cursor-paginated.** `githubOwnerBinding:listBindings` and `listUnprovenMappings` take `limit` (default 100, max 500) and `cursor` and return `{ items, nextCursor }` (`null` = exhausted); `get_github_owner_bindings` takes `limit`, `cursor`, `unprovenCursor` and returns `nextCursor`, `unprovenNextCursor`. The self-serve binding door (`bind_github_owner` / `startBinding`), the signed install state and the `/github/app/setup` callback are NOT part of this release: they move to a follow-up PR. Both reads are new in this release, so no released caller reads the old shapes.
