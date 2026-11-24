---
section: Added
---
- **VantagePeers Cloud and Self-host: explicit per-assignee queue order through MCP.** New tool `reorder_queue` {assignedToAgentId, taskIds} sets an assignee's queue in one call: listed tasks get ranks 1..N, the assignee's other open tasks lose their rank, and `[]` clears it. The order is set without fake dependencies. The tool is open to the assignee, an org admin or a listed queue coordinator. New tool `next_task` returns the next pickable task (rank, then priority, then age, dependencies done) or an explicit `found:false`; it always forwards the caller's verified organisation. `list_tasks` accepts `sort: "queue"`; calls without `sort` are unchanged. Pinned by `mcp-server/test/queue-tools.test.ts` (13 tests) and the evals.
