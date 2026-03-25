# VantagePeers

**Shared memory, messaging, and task management MCP server for multi-agent Claude Code.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## What It Is

VantagePeers is a shared brain for multiple Claude Code agents. It provides persistent memory with semantic search, inter-agent messaging, task management, and structured episodic learning -- all exposed as MCP tools that any Claude Code session can call. Built on [Convex](https://convex.dev) for the real-time database and [@convex-dev/rag](https://www.npmjs.com/package/@convex-dev/rag) for vector embeddings and hybrid search.

## Prerequisites

- **Node.js 18+**
- **Bun** (runtime for the MCP server)
- **Convex account** (free tier works) -- [https://convex.dev](https://convex.dev)
- **OpenAI API key** (for `text-embedding-3-small` embeddings, used via AI Gateway)

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/vantageos/vantage-peers.git
cd vantage-memory

# 2. Install dependencies
npm install

# 3. Start the Convex dev server (creates a new deployment on first run)
npx convex dev

# 4. Set your OpenAI-compatible API key as a Convex environment variable
npx convex env set AI_GATEWAY_API_KEY=your-openai-api-key
```

Then configure MCP in your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "vantage-memory": {
      "command": "bun",
      "args": ["/path/to/vantage-memory/mcp-server/server.ts"],
      "env": {
        "CONVEX_URL": "https://your-deployment.convex.cloud"
      }
    }
  }
}
```

Replace `/path/to/vantage-memory` with the absolute path to your clone, and `your-deployment` with the Convex deployment URL printed by `npx convex dev`.

Verify: open Claude Code and confirm that vantage-memory tools appear in the tool list.

## Architecture

```
Claude Code (Agent 1) ──┐
Claude Code (Agent 2) ──┤── MCP Server (stdio) ── Convex Cloud
Claude Code (Agent 3) ──┘        |
                          27 MCP Tools
```

One Convex deployment. One MCP server process per agent. All agents share the same database.

## Features

- **Semantic memory** -- store facts, decisions, and feedback; retrieve by meaning via vector search
- **Episodic learning** -- structured context/goal/action/outcome/insight records with severity levels
- **Memory graph** -- relations between memories (updates, extends, derives) with automatic versioning
- **Inter-agent messaging** -- send messages to specific agents, channels, or broadcast to all
- **Task management** -- create, assign, prioritize, and track tasks with dependencies and missions
- **Mission planning** -- group tasks into missions with status lifecycle (brainstorm through complete)
- **Diary and notes** -- daily diary entries and briefing notes per agent
- **Multi-instance support** -- multiple instances of the same agent role can run concurrently
- **Hybrid search** -- vector, full-text (BM25), and combined search via Reciprocal Rank Fusion

## MCP Tools Reference

### Memory and Search (6 tools)

| Tool | Description |
|------|-------------|
| `store_memory` | Store a typed memory entry with optional graph relations |
| `recall` | Semantic vector search over memories, filtered by namespace/type |
| `store_episode` | Store a structured episodic memory (context, goal, action, outcome, insight) |
| `list_memories` | List memories by namespace with optional type filter |
| `get_profile` | Fetch an orchestrator's profile (static identity + dynamic session state) |
| `update_profile` | Create or update an orchestrator profile |

### Session and Peers (2 tools)

| Tool | Description |
|------|-------------|
| `set_summary` | Set a status summary visible to other agents via list_peers |
| `list_peers` | List all registered agent instances and their current summaries |

### Messaging (4 tools)

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to a channel, agent, or broadcast |
| `check_messages` | Check for unread messages addressed to a recipient/instance |
| `mark_as_read` | Mark message receipts as read by receipt ID |
| `list_messages` | List messages with filters (channel, sender, date range) |

### Tasks (5 tools)

| Tool | Description |
|------|-------------|
| `create_task` | Create a new task with assignee, priority, and optional dependencies |
| `list_tasks` | List tasks filtered by assignee, status, project, or priority |
| `update_task` | Update any task fields (status, priority, description, etc.) |
| `complete_task` | Mark a task as done with a mandatory completion note |
| `start_task` | Claim a task and set its status to in_progress |

### Missions (4 tools)

| Tool | Description |
|------|-------------|
| `create_mission` | Create a mission grouping related tasks under a project |
| `list_missions` | List missions filtered by project, pilot, or status |
| `update_mission` | Update mission fields (description, brief, agents, dates) |
| `update_mission_status` | Advance a mission through its lifecycle stages |

### Tasks by Mission (1 tool)

| Tool | Description |
|------|-------------|
| `list_tasks_by_mission` | List all tasks belonging to a specific mission |

### Diary and Notes (5 tools)

| Tool | Description |
|------|-------------|
| `write_diary` | Write a daily diary entry for an agent instance |
| `get_diary` | Retrieve a diary entry by orchestrator and date |
| `list_diaries` | List diary entries with optional date range and orchestrator filter |
| `create_briefing_note` | Create a briefing note with topic, participants, and decisions |
| `list_briefing_notes` | List briefing notes filtered by topic or creator |

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

1. **Vector search** -- semantic similarity using cosine distance on 1536-dim embeddings (`text-embedding-3-small`). This is what the `recall` MCP tool uses.
2. **Text search** -- BM25 full-text search for exact keyword matching.
3. **Hybrid search** -- combines vector and text results using Reciprocal Rank Fusion (RRF).

Text and hybrid search are available via direct Convex function calls. The MCP `recall` tool exposes vector search.

Embedding is asynchronous -- there is a 2-5 second delay between storing a memory and it becoming searchable.

## Multi-Instance Support

VantagePeers distinguishes between **roles** and **instances**:

- A **role** (e.g., `pi`, `tau`, `phi`) is a logical agent identity.
- An **instance** (e.g., `pi-chromebook`, `pi-vps`, `tau-client-acme`) is a specific running copy of that role.

Multiple instances of the same role can run concurrently. Messages can be routed to a role (all instances receive it) or to a specific instance. Each instance can set its own status summary and claim tasks independently.

## Running Tests

```bash
# Integration tests (29 tests, requires a running Convex deployment)
bun scripts/test-mcp.ts

# Unit tests (34 tests)
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
4. Store non-obvious learnings via `store_memory`.
5. Use `orchestrator/[name]` for personal namespace, `global` for shared.
```

## Tech Stack

- **Convex** -- real-time database, serverless functions, vector search
- **@convex-dev/rag** -- embedding generation, indexing, hybrid search
- **@modelcontextprotocol/sdk** -- MCP server implementation for Claude Code
- **Bun** -- TypeScript runtime for the MCP server process
- **OpenAI text-embedding-3-small** -- 1536-dimension embeddings via AI Gateway
- **TypeScript** -- end to end, both server and Convex functions

## License

[MIT](LICENSE)
