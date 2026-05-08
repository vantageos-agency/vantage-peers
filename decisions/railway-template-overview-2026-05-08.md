# Deploy and Host VantagePeers MCP on Railway

*Maintained by VantageOS. Last reviewed: 2026-05-08.*

VantagePeers gives your AI agents a shared brain. In under 10 minutes you get a self-hosted MCP server backed by Convex with 82 tools covering memory, tasks, missions, messaging, issue tracking, fix patterns, and more — deployed to Railway with one click, reachable by any MCP-compatible client.

## About Hosting VantagePeers MCP

Every new LLM session resets context — decisions from yesterday, fix patterns from last week, tasks assigned to another agent, all gone. VantagePeers keeps that state outside the LLM and makes it queryable from any session, on any machine. Replaces Redis-backed task queues, per-session memory files, and ad-hoc agent state JSON with a single hosted backend. No per-query quotas (Convex free and Pro tiers), EU/EUR-primary billing, namespace isolation so projects share one deployment without data bleed. FSL-1.1-Apache-2.0 license — self-host the data, own the deployment.

VantagePeers v2.2.0 (2026-05-08) has two layers: a Convex backend (20 tables, vector indexes, BM25 text search, hybrid RRF fusion, 1536-dim embeddings via `text-embedding-3-small`) and a stateless MCP server (`vantage-peers-mcp` v2.2.0) translating tool calls into Convex queries. Mode A (stdio) for local clients; Mode B (HTTP SSE) for remote clients — what this Railway template deploys.

## Common Use Cases

**Solo developer — cross-session context persistence.** Cédric runs Claude Code across two machines on three projects. He calls `store_memory` at session end to capture decisions; the next session opens with `recall` returning the five most relevant memories. `search_fix_patterns` surfaces root cause and fix for familiar bugs, skipping failed attempts. One Railway deployment, one Convex project, no per-query costs at the free tier.

**Consultant — client isolation.** Thomas manages three concurrent engagements. Each client gets its own namespace (`project/client-acme`, `project/client-beta`, `project/client-gamma`). Clerk scoped OAuth tokens isolate client data at the API layer. `get_mission_template("client-onboarding")` pre-populates a live mission in one call. Briefing notes link decisions to memories via `linkedMemoryIds` so any agent reconstructs context without session history.

**Small team — agent fleet coordination.** Marie leads a four-person team where each person runs one or more AI agents. The shared deployment provides a common message bus and task board. On task completion an agent calls `complete_task` then `send_message`; offline agents receive via `check_messages` using `since` — no messages lost. `list_peers` shows full team state at any moment.

## Dependencies for VantagePeers MCP Hosting

- **Convex deployment** — create one free at [convex.dev](https://convex.dev/?utm_source=railway&utm_medium=referral&utm_campaign=LAUREN7583) (referral LAUREN7583). Holds all persistent data across 20 tables with vector indexes.
- **OpenAI-compatible API key** (`AI_GATEWAY_API_KEY`) — for `text-embedding-3-small` embeddings (1536 dimensions). Any OpenAI-compatible gateway works.
- **`BEARER_SECRET_MASTER`** — a secret string you choose. Every MCP HTTP request must carry this as a Bearer token.
- **Optional: Clerk** — scoped OAuth tokens for per-namespace access control. Create an application at [clerk.com/dashboard](https://dashboard.clerk.com).

Setup: deploy via Railway template button → set `CONVEX_URL`, `AI_GATEWAY_API_KEY`, `BEARER_SECRET_MASTER` in Variables tab → point any MCP client at `https://your-deployment.railway.app/mcp` with `Authorization: Bearer <your-secret>`.

Verify: `curl https://your-deployment.railway.app/health` returns `{"status":"ok","version":"2.2.0"}`.

## Why Deploy VantagePeers MCP on Railway?

Railway gives VantagePeers the fastest path from zero to a running MCP endpoint: one-click deploy from a public GitHub repo, automatic HTTPS, environment variable management through the dashboard, and redeploy-on-push without configuring CI. The MCP server is stateless Node.js — it reads `CONVEX_URL` at startup and proxies all tool calls to Convex. Railway only runs compute; all state lives in Convex cloud. Tear down and redeploy at any time without losing a single memory, task, or message. For multi-instance scale-out, point multiple Railway services at the same `CONVEX_URL` — atomic `checkout_task` prevents duplicate claims.

---

## 82 MCP Tools by Category

VantagePeers exposes 82 MCP tools across 14 categories. Every tool accepts and returns JSON. Full reference at [vantagepeers.com/docs/tools](https://vantagepeers.com/docs/tools).

**Memory (6)** — Typed namespaced store with vector embeddings. Five types: `user`, `feedback`, `project`, `reference`, `episode`. Graph relations track superseded facts.
`store_memory`, `recall`, `store_episode`, `list_memories`, `get_memory`, `soft_delete_memory`

**Search (2)** — BM25 full-text for exact keywords; hybrid vector+BM25 with RRF for semantic precision. Namespace and type filters, result limit 1–50.
`text_search`, `hybrid_search`

**Messaging (7)** — Persistent inter-agent messaging with read receipts. Role-to-role, instance-targeted, and broadcast. Incremental polling via `since` timestamp.
`send_message`, `check_messages`, `mark_as_read`, `list_messages`, `delete_message`, `list_broadcast_status`, `list_peers`

**Tasks (10)** — Full lifecycle with audit trail. Statuses: `todo → in_progress → review → blocked → done`. Priorities: `urgent`, `high`, `medium`, `low`. Atomic `checkout_task` prevents duplicate claims.
`create_task`, `start_task`, `complete_task`, `block_task`, `checkout_task`, `update_task`, `add_task_dependency`, `list_tasks`, `list_tasks_by_mission`, `delete_task`

**Missions (5)** — Group tasks into missions with five-stage lifecycle: `brainstorm → plan → execute → validate → complete`. Carries pilot, target date, and progress value.
`create_mission`, `get_mission`, `update_mission`, `update_mission_status`, `list_missions`

**Profiles and Sessions (8)** — Static identity (role, workspace, capabilities) + dynamic session state (current task, last seen). Diary tools log daily progress. Briefing notes structure handoffs with linked decision records and memory IDs.
`get_profile`, `update_profile`, `set_summary`, `write_diary`, `get_diary`, `list_diaries`, `create_briefing_note`, `list_briefing_notes`

**Recurring Tasks (6)** — Standard cron expressions; Convex scheduler spawns task instances on schedule. Full lifecycle: create, list, update, pause, resume, delete.
`create_recurring_task`, `list_recurring_tasks`, `update_recurring_task`, `pause_recurring_task`, `resume_recurring_task`, `delete_recurring_task`

**Registry (6)** — Capability inventory — store full file content for agents, skills, hooks, plugins. Full-text search via `search_components`. Version tracking per component.
`register_component`, `get_component`, `list_components`, `update_component`, `delete_component`, `search_components`

**Mandates (6)** — Cross-agent service requests with budget and spending controls. Agent A requests with agreed token budget; Agent B accepts, works, and settles with actual cost.
`create_mandate`, `accept_mandate`, `update_mandate`, `settle_mandate`, `validate_mandate_spending`, `list_mandates`

**Business Units (5)** — Organizational units with strategy, KPIs, and 3-year revenue projections. Lifecycle: `idea → building → live → revenue`. Core team composition stored per BU.
`create_bu`, `get_bu`, `update_bu`, `list_bus`, `delete_bu`

**GitHub Issues (9)** — Webhook sync and commit linking. Issues track `open → in_progress → fixed → verified → closed`. `link_issue_to_pattern` connects issues to the fix knowledge base.
`add_repo_mapping`, `list_issues`, `get_issue`, `update_issue_status`, `link_commit_to_issue`, `verify_issue`, `issue_stats`, `list_repo_mappings`, `remove_repo_mapping`

**Fix Patterns (6)** — Bug fix knowledge base with semantic search. Document bug, root cause, validated fix, and fix attempts. `search_fix_patterns` uses vector search — natural language query surfaces the pattern without exact keywords.
`create_fix_pattern`, `add_fix_attempt`, `validate_fix`, `search_fix_patterns`, `list_fix_patterns`, `link_issue_to_pattern`

**Mission Templates (2)** — Configurable templates for auto-creating missions with predefined steps. Standardizes repeated engagement types.
`get_mission_template`, `update_mission_template`

**Error Monitoring (4)** — Proactive deployment error detection with automatic GitHub issue creation. Register a deployment; the system surfaces errors via `list_errors` and `get_error`.
`add_deployment`, `remove_deployment`, `list_errors`, `get_error`

---

### Deployment Dependencies

- **Documentation:** [vantagepeers.com/docs](https://vantagepeers.com/docs)
- **Convex (required backend):** [convex.dev — referral LAUREN7583](https://convex.dev/?utm_source=railway&utm_medium=referral&utm_campaign=LAUREN7583)
- **Clerk (optional auth):** [clerk.com/dashboard](https://dashboard.clerk.com)
- **GitHub repository:** [github.com/vantageos-agency/vantage-peers](https://github.com/vantageos-agency/vantage-peers)
- **npm package:** [npmjs.com/package/vantage-peers-mcp](https://www.npmjs.com/package/vantage-peers-mcp)

---

*VantageOS · FSL-1.1-Apache-2.0 · [Report issues](https://github.com/vantageos-agency/vantage-peers/issues)*
