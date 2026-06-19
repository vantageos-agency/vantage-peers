# VantagePeers — Railway Template Overview

*Maintained by VantageOS. Last reviewed: 2026-05-08.*

## VantagePeers: Shared Memory and Coordination Infrastructure for AI Agent Teams

VantagePeers gives your AI agents a shared brain. In under 10 minutes you get a self-hosted MCP server backed by Convex with 82 tools covering memory, tasks, missions, messaging, issue tracking, fix patterns, and more — deployed to Railway with one click, reachable by any MCP-compatible client.

Built for solo developers running multiple Claude sessions across machines, consultants with separate client engagements, and small teams coordinating an agent fleet. Every new LLM session resets context — decisions from yesterday, fix patterns from last week, tasks assigned to another agent, all gone. VantagePeers keeps that state outside the LLM and makes it queryable from any session, on any machine.

Replaces Redis-backed task queues, per-session memory files, and ad-hoc agent state JSON with a single hosted backend. What makes it different: no per-query quotas (Convex free and Pro tiers), EU/EUR-primary billing, namespace isolation so projects share one deployment without data bleed, versioned npm package (`vantage-peers-mcp` v2.2.0) you can pin and upgrade on your own schedule. FSL-1.1-Apache-2.0 license — self-host the data, own the deployment.

---

## How to Self-Host

### What You Bring

- **Convex deployment** — create one free at [convex.dev](https://convex.dev/?utm_source=railway&utm_medium=referral&utm_campaign=LAUREN7583) (referral LAUREN7583). Holds all persistent data across 20 tables with vector indexes.
- **OpenAI-compatible API key** — for `text-embedding-3-small` embeddings (1536 dimensions) via `@convex-dev/rag`. Set as `AI_GATEWAY_API_KEY` in Convex (Vercel AI Gateway mode) or as `OPENAI_API_KEY` in Convex (BYOK direct mode). This key goes in Convex, not Railway.
- **`BEARER_SECRET_MASTER`** — a secret string you choose. Set it in both Railway (service env) and Convex (backend env) with the same value. Every MCP HTTP request must carry this as a Bearer token. Keep it out of version control.
- **Optional: Clerk** — for scoped OAuth tokens, create an application at [clerk.com/dashboard](https://dashboard.clerk.com). Clerk enables per-namespace access control so client agents cannot read each other's data. Without Clerk, the master bearer covers all namespaces.

### What Railway Provides

- HTTPS endpoint on a `*.railway.app` subdomain, SSL included
- Automatic redeploy on push to `vantageos-agency/vantage-peers` (or your fork)
- Healthcheck monitoring — `GET /health` returns `{"status":"ok","version":"2.2.0"}`
- Horizontal scaling; the stateless MCP layer scales independently of Convex

### Setup Walkthrough (3 Steps)

1. **One-click deploy** — use the Railway template button. Railway clones the repo, builds the Node.js MCP server (`npm run build` → `dist/server.js`), and starts the HTTP transport.
2. **Add environment variables** — two layers, each with its own set:
   - **In Railway** (Variables tab): `NODE_ENV=production`, `CONVEX_URL_INTERNAL` (your `https://…convex.cloud` URL), `BEARER_SECRET_MASTER`, `PUBLIC_BASE_URL=${{ RAILWAY_PUBLIC_DOMAIN }}` (Railway interpolates this to your `*.up.railway.app` host; OAuth metadata discovery falls back to it when the `Host` header is absent — e.g. `curl` smoke without `-H "Host: …"`). Optionally add `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`.
   - **In Convex** (dashboard → Settings → Environment Variables, or `npx convex env set`): `BEARER_SECRET_MASTER` (same value as Railway — required for auth consistency), `AI_GATEWAY_API_KEY` (Vercel Gateway mode) or `OPENAI_API_KEY` (BYOK direct mode), `VP_LICENSE_KEY`.
3. **Connect your MCP client** — point Claude Code, Cursor, or any MCP HTTP client at `https://your-deployment.railway.app/mcp` with `Authorization: Bearer <your-secret>`. All 82 tools are immediately available.

---

## Architecture Overview

VantagePeers v2.2.0 (as of 2026-05-08) has two layers: a Convex backend that holds all data and a stateless MCP server that translates tool calls into Convex queries and mutations.

**Convex backend** — 20 tables in `convex/schema.ts` with compound indexes for low-latency reads. Semantic memory uses `@convex-dev/rag` (text-embedding-3-small, 1536 dimensions, cosine similarity). Keyword search uses BM25. Hybrid search fuses both via Reciprocal Rank Fusion with configurable `vectorWeight` and `textWeight`. The supermemory pattern marks superseded entries `isLatest=false` so recall always returns the authoritative version. Multi-tenancy via namespace strings (`global`, `orchestrator/pi`, `project/vantage-starter`) and, for Clerk users, `orgId` scoping.

**MCP server layer** — `vantage-peers-mcp` v2.2.0 (npm, `@modelcontextprotocol/sdk ^1.27.1`). Two transport modes: Mode A (`server.ts`) for stdio local clients; Mode B (`server-http.ts`) for HTTP SSE remote clients — what this Railway template deploys. Both modes call the same `registerTools()` from `tools.ts`. Requires Node.js >= 18.

**Authentication** — `BEARER_SECRET_MASTER` covers master scope (all namespaces). Clerk OAuth tokens carry a `scopeProfile` claim restricting namespace read/write. Legacy bearer tokens bypass Clerk checks entirely.

**Data persistence** — Convex cloud stores all rows; no local disk state. Railway provides compute, Convex provides the database. FSL-1.1-Apache-2.0 license: self-hosted use is permitted; commercial redistribution requires a license from ElPi Corp.

---

## 82 MCP Tools by Category

VantagePeers exposes 82 MCP tools across 14 capability categories. Every tool accepts and returns JSON. Full reference at [vantagepeers.com/docs/tools](https://vantagepeers.com/docs/tools).

### Memory (6 tools)

Typed, namespaced knowledge store with vector embeddings. Five types: `user`, `feedback`, `project`, `reference`, `episode`. Graph relations (`updates`, `extends`, `derives`) track when a fact supersedes an older one. Optional TTL for time-bounded context.

`store_memory`, `recall`, `store_episode`, `list_memories`, `get_memory`, `soft_delete_memory`

### Search (2 tools)

BM25 full-text for exact keyword matching; hybrid vector+BM25 with RRF for semantic precision. Both accept namespace and type filters, result limit 1–50.

`text_search`, `hybrid_search`

### Messaging (7 tools)

Persistent inter-agent messaging with read receipts. Messages survive agent restarts. Supports role-to-role, instance-targeted (e.g. `pi-chromebook` vs `pi-vps`), and broadcast. Incremental polling via `since` timestamp avoids re-transferring the full backlog.

`send_message`, `check_messages`, `mark_as_read`, `list_messages`, `delete_message`, `list_broadcast_status`, `list_peers`

### Tasks (10 tools)

Full lifecycle with audit trail. Statuses: `todo → in_progress → review → blocked → done`. Priorities: `urgent`, `high`, `medium`, `low`. Dependency graph via `add_task_dependency`. Atomic `checkout_task` prevents duplicate claims in multi-instance setups.

`create_task`, `start_task`, `complete_task`, `block_task`, `checkout_task`, `update_task`, `add_task_dependency`, `list_tasks`, `list_tasks_by_mission`, `delete_task`

### Missions (5 tools)

Group tasks into missions with a five-stage lifecycle: `brainstorm → plan → execute → validate → complete`. Missions carry a pilot, target date, and progress value. `list_tasks_by_mission` returns the full task board.

`create_mission`, `get_mission`, `update_mission`, `update_mission_status`, `list_missions`

### Profiles and Sessions (8 tools)

Static identity (role, workspace, capabilities) + dynamic session state (current task, last seen, session count). Diary tools log daily progress. Briefing notes structure handoffs with linked decision records and memory IDs.

`get_profile`, `update_profile`, `set_summary`, `write_diary`, `get_diary`, `list_diaries`, `create_briefing_note`, `list_briefing_notes`

### Recurring Tasks (6 tools)

Standard cron expressions; Convex scheduler spawns task instances on schedule. Full lifecycle: create, list, update, pause, resume, delete. Templates survive agent restarts.

`create_recurring_task`, `list_recurring_tasks`, `update_recurring_task`, `pause_recurring_task`, `resume_recurring_task`, `delete_recurring_task`

### Registry (6 tools)

Capability inventory — store full file content for agents, skills, hooks, plugins. Nothing lost if a filesystem is destroyed. Full-text search via `search_components`. Version tracking per component.

`register_component`, `get_component`, `list_components`, `update_component`, `delete_component`, `search_components`

### Mandates (6 tools)

Cross-agent service requests with budget and spending controls. Agent A requests a service with an agreed token budget; Agent B accepts, works, and settles with actual cost. `validate_mandate_spending` enforces per-transaction and per-period limits.

`create_mandate`, `accept_mandate`, `update_mandate`, `settle_mandate`, `validate_mandate_spending`, `list_mandates`

### Business Units (5 tools)

Organizational units with strategy, KPIs, and 3-year revenue projections. Lifecycle: `idea → building → live → revenue`. Core team composition (agents, skills, hooks, plugins) stored per BU.

`create_bu`, `get_bu`, `update_bu`, `list_bus`, `delete_bu`

### GitHub Issues (9 tools)

Webhook sync and commit linking. Issues track `open → in_progress → fixed → verified → closed`. `issue_stats` for dashboards. `link_commit_to_issue` bridges commits to tracked issues; use `link_issue_to_pattern` (Fix Patterns category) to connect issues to the fix knowledge base.

`add_repo_mapping`, `list_issues`, `get_issue`, `update_issue_status`, `link_commit_to_issue`, `verify_issue`, `issue_stats`, `list_repo_mappings`, `remove_repo_mapping`

### Fix Patterns (6 tools)

Bug fix knowledge base with semantic search. Document bug, root cause, validated fix, and multiple fix attempts. `search_fix_patterns` uses vector search — a natural language query surfaces the pattern without needing exact keywords.

`create_fix_pattern`, `add_fix_attempt`, `validate_fix`, `search_fix_patterns`, `list_fix_patterns`, `link_issue_to_pattern`

### Mission Templates (2 tools)

Configurable templates for auto-creating missions with predefined steps. Standardizes repeated engagement types (e.g. "client onboarding", "release cycle").

`get_mission_template`, `update_mission_template`

### Error Monitoring (4 tools)

Proactive deployment error detection with automatic GitHub issue creation. Register a deployment; the system surfaces errors via `list_errors` and `get_error` without log polling.

`add_deployment`, `remove_deployment`, `list_errors`, `get_error`

---

## Common Use Cases

### Solo Developer — Cross-Session Context Persistence

A solo developer runs Claude Code sessions across two machines for three separate projects. Every session opens cold without shared state. With VantagePeers, he calls `store_memory` at the end of each session to capture decisions and architectural choices. The next session opens with a `recall` call returning the five most relevant memories. When he hits a familiar bug, `search_fix_patterns` returns the root cause and fix — including failed attempts he can skip. A daily `create_recurring_task` reminds each agent to check messages at session start. One Railway deployment, one Convex project, no per-query costs at the free tier.

### Consultant — Client Isolation and Engagement Standardization

Thomas manages three concurrent client engagements. Each client gets its own namespace (`project/client-acme`, `project/client-beta`, `project/client-gamma`). With Clerk, scoped OAuth tokens mean the agent for Client Acme cannot read Client Beta's data — isolation at the API layer, not by convention. `get_mission_template("client-onboarding")` returns predefined steps; `create_mission` with those fields pre-populated launches a live mission in one call. Mandates track cross-agent service requests with agreed budgets. Briefing notes link client decisions to relevant memories via `linkedMemoryIds` so any agent can reconstruct engagement context without session history.

### Small Team — Agent Fleet Coordination and Handoffs

A small-team lead runs a four-person team where each person runs one or more AI agents. The shared deployment gives all agents a common message bus and task board. On task completion, an agent calls `complete_task` with a `completionNote` then `send_message` to the next agent. Offline agents receive messages on their next `check_messages` call using `since` — no messages are lost. `set_summary` lets each agent publish its status; `list_peers` shows the full team state at any moment. `store_episode` with `severity=critical` flags cross-team lessons so every agent benefits regardless of which session discovered them.

---

## Compatible MCP Clients

VantagePeers works with any client that supports the Model Context Protocol over HTTP SSE transport (Mode B) or stdio (Mode A, local use only).

Tested clients:
- **Claude Code** (Anthropic CLI) — HTTP transport via `~/.claude/mcp_servers.json`
- **Claude.ai (web)** — OAuth 2.1 DCR (RFC 7591 + RFC 8414 + RFC 9728); enter Railway URL in Settings → Integrations → Custom MCP servers, no bearer token required
- **Cursor** — MCP server config in `.cursor/mcp.json`
- **Windsurf** (Codeium) — MCP config in workspace settings
- **Cline** (VS Code extension) — MCP server list in extension settings
- **Continue** (VS Code / JetBrains) — `config.json` MCP block
- **Zed** — experimental MCP support via `~/.config/zed/settings.json`
- Any custom HTTP client sending `Authorization: Bearer <secret>` to `https://your-deployment.railway.app/mcp`

For stdio mode (local dev without Railway): `CONVEX_URL=https://your-deployment.convex.cloud node dist/server.js`

---

## Verify Your Deployment

After deploy: `curl https://your-deployment.railway.app/health` should return `{"status":"ok","version":"2.2.0"}`. A connection error means `CONVEX_URL` is incorrect or the Convex deployment is paused.

---

## Deployment Links

- **Documentation:** [vantagepeers.com/docs](https://vantagepeers.com/docs)
- **Convex (required backend):** [convex.dev — referral LAUREN7583](https://convex.dev/?utm_source=railway&utm_medium=referral&utm_campaign=LAUREN7583)
- **Clerk (optional auth):** [clerk.com/dashboard](https://dashboard.clerk.com)
- **GitHub repository:** [github.com/vantageos-agency/vantage-peers](https://github.com/vantageos-agency/vantage-peers)
- **npm package:** [npmjs.com/package/vantage-peers-mcp](https://www.npmjs.com/package/vantage-peers-mcp)

---

## Why Railway

Claude.ai web compatible via OAuth 2.1 DCR — enter your Railway URL in Claude.ai Settings → Integrations, no bearer token required. The Railway HTTPS endpoint satisfies the OAuth metadata discovery requirements out of the box.

Railway gives VantagePeers the fastest path from "zero" to "running MCP endpoint": one-click deploy from a public GitHub repo, automatic HTTPS, environment variable management through the dashboard, and redeploy-on-push without configuring CI. The MCP server is stateless Node.js — it reads `CONVEX_URL` at startup and proxies all tool calls to Convex. This means Railway only runs compute; all state lives in Convex cloud. You can tear down and redeploy the Railway service at any time without losing a single memory, task, or message.

For teams that outgrow the Railway free tier: run multiple Railway instances pointing at the same `CONVEX_URL`. The `checkout_task` tool uses an atomic Convex mutation to prevent duplicate task claims, so multi-instance scale-out works without extra coordination logic.

---

*Maintained by VantageOS. License: FSL-1.1-Apache-2.0. Issues: [github.com/vantageos-agency/vantage-peers/issues](https://github.com/vantageos-agency/vantage-peers/issues)*
