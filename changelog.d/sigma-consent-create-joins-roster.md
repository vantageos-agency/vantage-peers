---
section: Fixed
---
- **VantagePeers Cloud: an agent created on the consent page joins its organisation's roster.** `applyAgentChoice` (create) now appends the agent's id to `allowedAgentIds` and its exact stored name to `allowedOrchestrators` of the org's mapping, in the same transaction (append only, idempotent; the operator org is not edited, an org with no active mapping refuses the create). Before, a new client org seeded with an empty roster left its admin's fresh agent unable to write. Task k17bckpq7bvdqk74adr9cdfpfs8hhsxj.
