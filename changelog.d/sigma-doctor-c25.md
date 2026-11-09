---
section: Added
---
- **initialize's `serverInfo` carries the build identity.** It now serves `commitSha`, the same value `/health` reports as `commit`: the Railway build commit, or the honest string `"unknown"` when no build stamped one (local dev, stdio). Both read one function (`mcp-server/src/buildIdentity.ts`), so they cannot diverge; an empty `RAILWAY_GIT_COMMIT_SHA` now reads as `"unknown"` on both. Additive, no client breaks. Closes mcp-doctor rule C25 (build-identity). Task k17egf0eyp4rsvtepn5zps6qks8hx8gw.
