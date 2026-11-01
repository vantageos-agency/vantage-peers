---
section: Fixed
---
- **VantagePeers Cloud ops tooling: `scripts/provision-client-org-agents.mjs` authenticates its service-account Convex client with the `convex`-template token.** It used Clerk's native session token (no `aud`), which prod Convex rejects with `NoAuthProvider` at the first service-account query. It now mints the same `convex`-template token as the MCP service client (`getServiceAccountToken`). No Convex change, no contract bump. Task k17cz887yft38cv3cgttv9s1ys8hcy8x.
