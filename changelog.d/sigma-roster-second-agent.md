---
section: Fixed
---
- **Adding a second agent to an existing client org no longer dead-ends at `ROSTER_MISSING`.** `scripts/provision-client-org-agents.mjs` refused a new name before registering it, while the only roster write path (`clientOrgMapping:addRosterMembers`) takes an agent ID that only `agents:registerAgent` creates. The script now registers the agent by ID, mints nothing, prints the operator's `addRosterMembers` and `setAgentOwner` commands and exits 3; the re-run proceeds. No backend door changed and no grant widened. Pinned by `convex/__tests__/rosterSecondAgent.test.ts` (task k170pt4msvafayrz9qx7qv11bs8h7bwz).
