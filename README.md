# VantagePeers

**The coordination layer for AI agent teams. Memory. Messaging. Tasks. Knowledge.**

Deploy once. Connect any Claude Code agent. Your team is coordinated.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Convex](https://img.shields.io/badge/Convex-Backend-orange.svg)](https://convex.dev)
[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/Docs-vantagepeers.com-green.svg)](https://vantagepeers.com/docs)

## What It Is

VantagePeers is a shared brain for multiple Claude Code agents. It provides persistent memory with semantic search, inter-agent messaging, task management, fix pattern knowledge base, issue tracking, business unit management, and structured episodic learning -- all exposed as 75 MCP tools that any Claude Code session can call. Built on [Convex](https://convex.dev) for the real-time database and [@convex-dev/rag](https://www.npmjs.com/package/@convex-dev/rag) for vector embeddings and hybrid search.

## Prerequisites

- **Node.js 18+**
- **Convex account** (free tier works) -- [https://convex.dev](https://convex.dev)
- **OpenAI API key** (for `text-embedding-3-small` embeddings, used via AI Gateway)

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/vantageos-agency/vantage-peers.git
cd vantage-peers

# 2. Install dependencies
bun install

# 3. Start the Convex dev server (creates a new deployment on first run)
npx convex dev

# 4. Set your OpenAI-compatible API key as a Convex environment variable
npx convex env set AI_GATEWAY_API_KEY=your-openai-api-key
```

Then configure MCP in your Claude Code settings (`~/.claude.json`):

```json
{
  "mcpServers": {
    "vantage-peers": {
      "command": "npx",
      "args": ["-y", "vantage-peers-mcp"],
      "env": {
        "CONVEX_URL": "https://your-deployment.convex.cloud"
      }
    }
  }
}
```

Replace `your-deployment` with the Convex deployment URL printed by `npx convex dev`.

Verify: open Claude Code and confirm that vantage-peers tools appear in the tool list.

## Works With

VantagePeers is an MCP server — it works with any tool that supports the Model Context Protocol:

| Tool | Support | Config |
|------|---------|--------|
| **Claude Code** | Full MCP | `~/.claude.json` |
| **Cursor** | Full MCP | `.cursor/mcp.json` |
| **Codex** (OpenAI) | Full MCP | `~/.codex/config.json` |
| **Windsurf** | Full MCP | `~/.codeium/windsurf/mcp_config.json` |
| **Cline** | Full MCP | VS Code settings |
| **Roo Code** | Full MCP | VS Code settings |
| **OpenCode** | Full MCP | `opencode.toml` |
| **Amazon Q Developer** | Full MCP | `~/.aws/amazonq/mcp.json` |
| **Augment Code** | Full MCP | VS Code settings |
| **Void** | Full MCP | Void settings |
| **Continue.dev** | Agent mode | `~/.continue/config.json` |
| **GitHub Copilot** | Agent mode | `.github/copilot-mcp.json` |

See [Supported Tools](https://vantagepeers.com/docs/getting-started/supported-tools) for config snippets per tool.

## Architecture

```
Claude Code (Agent 1) ──┐
Claude Code (Agent 2) ──┤── MCP Server (stdio) ── Convex Cloud
Claude Code (Agent 3) ──┘        |
                          75 MCP Tools
```

One Convex deployment. One MCP server process per agent. All agents share the same database.

## Features

- **Semantic memory** -- store facts, decisions, and feedback; retrieve by meaning via vector search
- **Episodic learning** -- structured context/goal/action/outcome/insight records with severity levels
- **Memory graph** -- relations between memories (updates, extends, derives) with automatic versioning
- **Inter-agent messaging** -- send messages to specific agents, channels, or broadcast to all
- **Task management** -- create, assign, prioritize, and track tasks with dependencies and missions
- **Mission planning** -- group tasks into missions with status lifecycle (brainstorm through complete)
- **Fix pattern KB** -- knowledge base of bugs, root causes, and validated fixes with semantic search
- **Issue tracking** -- GitHub issues synced via webhooks, with status lifecycle and fix verification
- **Business units** -- track BUs with strategy, KPIs, pricing, and management fees
- **Mandates** -- cross-agent service requests with budget tracking and spending limits
- **Recurring tasks** -- cron-based task templates that auto-create on schedule
- **Component registry** -- backup and inventory of agents, skills, hooks, and plugins
- **Diary** -- daily diary entries per agent
- **Briefing notes** -- shared briefing documents with topic, participants, and decisions
- **Multi-instance support** -- multiple instances of the same agent role can run concurrently
- **Hybrid search** -- vector, full-text (BM25), and combined search via Reciprocal Rank Fusion
- **Proactive error monitoring** -- detect errors across Convex deployments before users report them, auto-create GitHub issues
- **Issue resolution stats** -- daily MTTR calculation with before/after era comparison (median 4 days → 28 minutes)
- **Mission templates** -- configurable multi-step workflows (IRP 13 steps, repo-fix 10 steps, new-feature 10 steps)
- **External issue tracking** -- track issues on third-party repos, monitor PRs, coordinate open-source contributions
- **PR monitoring** -- hourly cron polls open PRs on external repos, notifies on merge/close
- **Orchestrator signatures** -- automated VantageOS Team branding on commits, PRs, and GitHub comments

## MCP Tools Reference (75 tools)

### Memory (6 tools)

| Tool | Description |
|------|-------------|
| `store_memory` | Store a typed memory entry with optional graph relations |
| `recall` | Semantic vector search over memories, filtered by namespace/type |
| `list_memories` | List memories by namespace with optional type filter |
| `soft_delete_memory` | Soft-delete a memory entry by ID |
| `store_episode` | Store a structured episodic memory (context, goal, action, outcome, insight) |
| `get_memory` | Retrieve a single memory entry by ID |

### Profiles (3 tools)

| Tool | Description |
|------|-------------|
| `get_profile` | Fetch an orchestrator's profile (static identity + dynamic session state) |
| `update_profile` | Create or update an orchestrator profile |
| `list_peers` | List all registered agent instances and their current summaries |

### Session (1 tool)

| Tool | Description |
|------|-------------|
| `set_summary` | Set a status summary visible to other agents via list_peers |

### Messaging (6 tools)

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to a channel, agent, or broadcast |
| `check_messages` | Check for unread messages addressed to a recipient/instance |
| `mark_as_read` | Mark message receipts as read by receipt ID |
| `delete_message` | Delete a message by ID |
| `list_messages` | List messages with filters (channel, sender, date range) |
| `list_broadcast_status` | List read/unread receipts for a broadcast message |

### Tasks (8 tools)

| Tool | Description |
|------|-------------|
| `create_task` | Create a new task with assignee, priority, and optional dependencies |
| `list_tasks` | List tasks filtered by assignee, status, project, or priority |
| `list_tasks_by_mission` | List all tasks belonging to a specific mission |
| `update_task` | Update any task fields (status, priority, description, etc.) |
| `complete_task` | Mark a task as done with a mandatory completion note |
| `start_task` | Claim a task and set its status to in_progress |
| `checkout_task` | Atomically claim a task (conflict-safe for multi-instance) |
| `delete_task` | Delete a task by ID |

### Missions (5 tools)

| Tool | Description |
|------|-------------|
| `create_mission` | Create a mission grouping related tasks under a project |
| `list_missions` | List missions filtered by project, pilot, or status |
| `update_mission` | Update mission fields (description, brief, agents, dates) |
| `update_mission_status` | Advance a mission through its lifecycle stages |
| `get_mission_template` | Fetch a configurable mission template by name |

### Diary (3 tools)

| Tool | Description |
|------|-------------|
| `write_diary` | Write a daily diary entry for an agent instance |
| `get_diary` | Retrieve a diary entry by orchestrator and date |
| `list_diaries` | List diary entries with optional date range and orchestrator filter |

### Briefing Notes (2 tools)

| Tool | Description |
|------|-------------|
| `create_briefing_note` | Create a briefing note with topic, participants, and decisions |
| `list_briefing_notes` | List briefing notes filtered by topic or creator |

### Components (3 tools)

| Tool | Description |
|------|-------------|
| `register_component` | Register an agent, skill, hook, or plugin with full content backup |
| `list_components` | List components filtered by type or team |
| `get_component` | Fetch a single component by name and type |

### Recurring Tasks (5 tools)

| Tool | Description |
|------|-------------|
| `create_recurring_task` | Create a cron-based task template (e.g., daily standup) |
| `list_recurring_tasks` | List recurring task templates |
| `pause_recurring_task` | Pause a recurring task (stops auto-creation) |
| `resume_recurring_task` | Resume a paused recurring task |
| `delete_recurring_task` | Delete a recurring task template |

### Mandates (6 tools)

| Tool | Description |
|------|-------------|
| `create_mandate` | Create a cross-agent service request with budget |
| `accept_mandate` | Accept a mandate (sets status to accepted) |
| `update_mandate` | Update mandate fields (status, cost, linked tasks) |
| `settle_mandate` | Settle a mandate (record actual cost, mark complete) |
| `validate_mandate_spending` | Check if spending is within mandate limits |
| `list_mandates` | List mandates filtered by requestor, fulfiller, or status |

### Business Units (5 tools)

| Tool | Description |
|------|-------------|
| `create_bu` | Create a business unit with strategy, pricing, and KPIs |
| `update_bu` | Update business unit fields |
| `get_bu` | Fetch a business unit by ID |
| `list_bus` | List all business units with optional status/orchestrator filter |
| `delete_bu` | Delete a business unit |

### Issues (6 tools)

| Tool | Description |
|------|-------------|
| `list_issues` | List tracked issues with filters (repo, status, project, assignee) |
| `get_issue` | Fetch a single issue by repo and number |
| `update_issue_status` | Update issue status (open, in_progress, fixed, verified, closed) |
| `link_commit_to_issue` | Link a git commit to an issue |
| `verify_issue` | Mark an issue as verified (fix confirmed) |
| `issue_stats` | Get issue count statistics grouped by status |

### Fix Patterns (5 tools)

| Tool | Description |
|------|-------------|
| `create_fix_pattern` | Create a fix pattern documenting a bug, root cause, and fix |
| `list_fix_patterns` | List fix patterns by project |
| `add_fix_attempt` | Document a fix attempt (worked/failed) with reasoning |
| `validate_fix` | Set the validated fix on a pattern |
| `link_issue_to_pattern` | Link a GitHub issue to a fix pattern |

### Search / RAG (3 tools)

| Tool | Description |
|------|-------------|
| `search_fix_patterns` | Semantic search over fix patterns (use BEFORE fixing bugs) |
| `text_search` | BM25 full-text search over memories |
| `hybrid_search` | Combined vector + BM25 search with RRF fusion |

### Mission Templates (1 tool)

| Tool | Description |
|------|-------------|
| `update_mission_template` | Update template steps and configuration |

### Error Monitoring (2 tools)

| Tool | Description |
|------|-------------|
| `list_errors` | List detected errors with dedup counts |
| `get_error` | Get full error details including stack trace |

### Deployments & Repos (5 tools)

| Tool | Description |
|------|-------------|
| `add_deployment` | Register a Convex deployment to monitor for errors |
| `remove_deployment` | Stop monitoring a deployment |
| `add_repo_mapping` | Map a GitHub repo to an orchestrator and project |
| `list_repo_mappings` | List all repo-to-orchestrator mappings |
| `remove_repo_mapping` | Remove a repo mapping |

## Database Schema

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `memories` | Core memory store with typed entries and graph relations | namespace, type, content, createdBy, relations, isLatest |
| `profiles` | Agent identity and session state | orchestratorId, instanceId, static, dynamic |
| `messages` | Inter-agent messages | from, channel, content, sessionDay |
| `messageReceipts` | Per-recipient read tracking for messages | messageId, recipient, recipientInstanceId, readAt |
| `missions` | High-level mission grouping for tasks | name, project, status, priority, pilot |
| `tasks` | Individual work items with dependencies | title, assignedTo, status, priority, dependsOn, missionId |
| `diary` | Daily diary entries per agent | date, orchestrator, content, highlights, blockers |
| `briefingNotes` | Shared briefing documents | title, topic, participants, content, decisions |
| `components` | Agent/skill/hook/plugin registry with content backup | name, type, team, content, version |
| `recurringTasks` | Cron-based task templates | title, assignedTo, cronExpression, active, nextRunAt |
| `missionTemplates` | Configurable multi-step workflow templates (IRP, repo-fix, etc.) | name, steps, isDefault, createdBy |
| `mandates` | Cross-agent service requests with budgets | requestedBy, fulfilledBy, service, budget, spendingLimits |
| `businessUnits` | ElPi Corp business units | name, status, businessModel, pricing, kpis, managementFee |
| `issues` | GitHub issues synced via webhook | repo, issueNumber, status, priority, fixCommits |
| `githubRepoMapping` | Maps GitHub repos to orchestrators | repo, orchestrator, project, active |
| `fixPatterns` | Bug fix knowledge base with semantic search | symptom, rootCause, validatedFix, tags, stack, severity |
| `fixAttempts` | Individual fix attempts per pattern | patternId, description, worked, why, commit |
| `monitoredDeployments` | Registry of Convex deployments polled for errors | name, deploymentUrl, deployKeyEnvVar, githubRepo, active |
| `errorLogs` | Deduplicated error log with auto-issue linking | hash, functionName, errorMessage, count, issueNumber |
| `issueStats` | Daily issue resolution metrics per repo | repo, date, medianTimeToFix, beforeVantageOS, afterVantageOS |

## Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| `user` | Facts about the user | "Laurent prefers English, solo founder" |
| `feedback` | Behavioral corrections and guidance | "Always use lowercase for orchestrator names" |
| `project` | Project state and architectural decisions | "API uses Convex mutations, not REST" |
| `reference` | Pointers to external resources | "Bug tracker is in Linear project INGEST" |
| `episode` | Structured lessons from experience | context/goal/action/outcome/insight with severity |

## Search Modes

VantagePeers supports three search strategies via `@convex-dev/rag`:

1. **Vector search** -- semantic similarity using cosine distance on 1536-dim embeddings (`text-embedding-3-small`). This is what the `recall` and `search_fix_patterns` MCP tools use.
2. **Text search** -- BM25 full-text search for exact keyword matching.
3. **Hybrid search** -- combines vector and text results using Reciprocal Rank Fusion (RRF).

Text and hybrid search are available via direct Convex function calls. The MCP `recall` tool exposes vector search for memories; `search_fix_patterns` exposes it for the fix pattern knowledge base.

Embedding is asynchronous -- there is a 2-5 second delay between storing a memory/pattern and it becoming searchable.

## Multi-Instance Support

VantagePeers distinguishes between **roles** and **instances**:

- A **role** (e.g., `pi`, `tau`, `sigma`) is a logical agent identity.
- An **instance** (e.g., `pi-chromebook`, `sigma-vps`, `tau-client-acme`) is a specific running copy of that role.

Multiple instances of the same role can run concurrently. Messages can be routed to a role (all instances receive it) or to a specific instance. Each instance can set its own status summary and claim tasks independently. The `checkout_task` tool provides atomic task claiming to prevent conflicts between instances.

## Running Tests

```bash
# Integration tests (requires a running Convex deployment)
bun scripts/test-mcp.ts

# Unit tests
npx vitest
```

## CLAUDE.md Integration

Add this snippet to any agent's `CLAUDE.md` to enable the memory protocol:

```markdown
## SHARED MEMORY (non-negotiable)

You have access to VantagePeers via MCP tools.

1. On session start: `recall` your namespace for relevant context.
2. After every failure: `store_episode` with context/goal/action/outcome/insight.
3. Before repeating a mistake: `recall` similar past episodes.
4. Before fixing a bug: `search_fix_patterns` to check if it's been seen before.
5. Store non-obvious learnings via `store_memory`.
6. Use `orchestrator/[name]` for personal namespace, `global` for shared.
```

## Tech Stack

- **Convex** -- real-time database, serverless functions, vector search
- **@convex-dev/rag** -- embedding generation, indexing, hybrid search
- **@modelcontextprotocol/sdk** -- MCP server implementation for Claude Code
- **Bun** -- TypeScript runtime for the MCP server process
- **OpenAI text-embedding-3-small** -- 1536-dimension embeddings via AI Gateway
- **TypeScript** -- end to end, both server and Convex functions

## Documentation

Full documentation at [vantagepeers.com/docs](https://vantagepeers.com/docs):

- [Getting Started](https://vantagepeers.com/docs/getting-started) -- install, deploy, configure
- [Quickstart](https://vantagepeers.com/docs/getting-started/quickstart) -- two agents exchanging messages in 5 minutes
- [Architecture](https://vantagepeers.com/docs/core-concepts/architecture) -- orchestrators, instances, namespaces
- [Tools Reference](https://vantagepeers.com/docs/tools) -- all 75 MCP tools

## Contributing

Contributions welcome. Please open an issue first to discuss what you would like to change.

## License

[FSL-1.1-Apache-2.0](LICENSE) -- source-available, free to self-host, converts to Apache 2.0 after 2 years. You may not offer VantagePeers as a competing hosted service.
