---
section: Fixed
---
- **VantagePeers Cloud and Self-host: `list_repo_mappings` serves out-of-scope rows again.** Since contract 33 an out-of-scope row carries no `orchestrator`, but the tool's output schema still required one, so every page holding such a row failed with an output validation error (`items.N.orchestrator: expected string, received undefined`), lite and full. `orchestrator` is now optional (absent on an out-of-scope row), and the schema describes `outOfScope`, `orchestratorAgentId`, `reviewerAgentId` and `fallbackReviewerAgentId`. MCP-side only, no backend contract change. Task k174dm9s483yj3tr03d7v4tgsx8k0ecw.
