---
section: Changed
---
- **Roster names that match no agent can be removed, dry-run first.** `migrations/backfillRosterAgentIds:backfillRosterAgentIds` takes an opt-in `removeUnknown`. With it, every `client_org_mapping.allowedOrchestrators` name that resolves to no agent in that organisation (the backfill's own `unknown` set) is listed per row, as `removed` / `kept` / `preState`, and removed on a write run (`dryRun: false`).
  - `"*"` and ambiguous names are kept, `allowedAgentIds` is never touched, and a second run is a no-op.
  - Without the flag the migration behaves as before.
  - Pi ruling 2026-10-25: ghost names go; test organisations are ignored, not deleted.
  - Task k1778c2hvae8e8vz9f5bbbbbb98g62hw. Tests: `convex/__tests__/removeGhostRosterNames.test.ts` (6).
