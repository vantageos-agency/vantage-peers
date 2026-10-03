---
section: Security
---
- **An agent credential points at the agent row, not at its name.** `agent_credentials` gains `agentId`; resolution returns the agents row, so renaming or re-casing an agent keeps its credential working and the old name is refused. Agent names are unique per organisation under `normalizeOrchestratorId` (`AGENT_NAME_TAKEN`), never globally. New `agents:renameAgent` (org admin). Two dry-run-able backfills in `convex/migrations/agentIdentityRows.ts` (names first, then credential ids). Evidence: `convex/__tests__/agentIdentityByRow.test.ts` 18/18, red 14/18 on the previous head.
