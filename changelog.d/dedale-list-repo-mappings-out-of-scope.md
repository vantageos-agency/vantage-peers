---
section: Fixed
---
- **`list_repo_mappings` no longer refuses its own result when an organisation holds an out-of-scope repo mapping (VantagePeers Cloud and Self-host).** The served output schema required `orchestrator` on every row, while the backend made it optional for a repo owned by nobody, so the whole page was rejected with "Output validation error ... items.N.orchestrator: expected string, received undefined". `orchestrator` is now optional, full rows describe `outOfScope { reason }` and the three agent-ID fields, and the lite-row description says a lite row carries `orchestrator` only for a routed repo. `add_repo_mapping`'s served schema also describes the agent IDs it returns. Regression test: `mcp-server/src/__tests__/list_repo_mappings.tool.test.ts`.
