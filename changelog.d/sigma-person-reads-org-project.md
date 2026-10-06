---
section: Changed
---
- **VantagePeers Cloud: a signed-in person now reads their organisation's shared agent memory.** A person's OAuth token (`POST /token`, `mcp-server/server-http.ts`) and a Clerk-JWT bearer (`mcp-server/src/auth.ts`, Path B) get read prefixes `team/<org>` and `project/<org>`; write prefixes stay `team/<org>` only, so a person cannot write the agents' namespace. `<org>` is the verified org key, never an argument; another organisation's `project/*` stays refused. No Convex change. Evidence: `mcp-server/test/oauth-authorize-requires-user.test.ts` 42/42 (4 red before), mutant dropping the prefix 4 red. Pi ruling k175syk4m5a54ra8k36rxdcha58frsnw.
