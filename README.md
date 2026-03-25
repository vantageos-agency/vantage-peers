# VantageMemory

Shared memory system for AI orchestrators. Built on Convex + `@convex-dev/rag`. Exposes MCP tools that any Claude Code session can use.

## Architecture

```
Pi (ElPi Corp) ──┐
Tau (VantageStarter) ──┤── vantage-memory MCP ── Convex cloud (efficient-guineapig-356)
Phi (Perfect AI Agent) ──┘
```

One Convex deployment. One MCP server. All orchestrators share the same brain.

## How it works

### Store → Embed → Search

1. **Store** — orchestrator calls `store_memory` or `store_episode`
2. **Embed** — Convex scheduler triggers `@convex-dev/rag` to generate a 1536-dim vector via Vercel AI Gateway (OpenAI text-embedding-3-small)
3. **Search** — `recall` runs semantic vector search, returns top K memories ranked by cosine similarity

Embedding is async — there's a ~2-5 second delay between store and searchability.

### Memory types

| Type | Purpose | Example |
|------|---------|---------|
| `user` | Facts about the user | "Laurent is a solo founder, prefers English" |
| `feedback` | Behavioral guidance | "Never output unaccented French" |
| `project` | Project state/decisions | "Three orchestrators: Pi, Tau, Phi" |
| `reference` | Pointers to external resources | "Pipeline bugs tracked in Linear project INGEST" |
| `episode` | Structured lessons from experience | context→goal→action→outcome→insight |

### Episodes — the differentiator

Episodes are not just facts. They capture **what happened and what was learned**:

```
Context:  Day 16 — enforce-background-agents.sh used basic grep
Goal:     Block foreground agents, allow background ones
Action:   grep -q with \s* (basic mode doesn't support \s)
Outcome:  Hook blocked ALL agents — foreground AND background
Insight:  Use grep -qE with [[:space:]]* or Python json.load()
Severity: critical (shared across all orchestrators)
```

Severity levels:
- `critical` — cross-orchestrator lesson, everyone must know
- `major` — important within a namespace
- `minor` — nice to have

### Namespaces

| Namespace | Who sees it | Use for |
|-----------|------------|---------|
| `global` | All orchestrators | Universal rules, user prefs, critical episodes |
| `orchestrator/pi` | Pi only | ElPi Corp routing, client context |
| `orchestrator/tau` | Tau only | VantageStarter build patterns |
| `orchestrator/phi` | Phi only | Novel structure, diary voice |
| `project/vantage-starter` | Anyone working on VS | Project-specific decisions |

### Graph relations

When a memory supersedes another:

```
store_memory({
  content: "New rule replaces old one",
  relatesTo: { targetId: "old_memory_id", type: "updates" }
})
```

Relation types:
- `updates` — supersedes the target (target gets `isLatest: false`, removed from search)
- `extends` — adds detail to the target
- `derives` — inferred from the target

Only `isLatest: true` memories appear in recall results.

### Profiles

Each orchestrator has a profile with static (identity) and dynamic (session state) fields:

```
{
  orchestratorId: "pi",
  name: "Pi",
  static: {
    role: "ElPi Corp orchestrator — architect, strategist, delegator",
    workspace: "/home/laurentperello/coding/ElPi Corp",
    capabilities: ["orchestration", "delegation", "strategy"]
  },
  dynamic: {
    currentTask: "Day 16 — VantageMemory launch",
    lastSeen: 1742673600000,
    sessionCount: 1
  }
}
```

## MCP Tools

### store_memory
Store a typed memory entry.

| Param | Required | Description |
|-------|----------|-------------|
| namespace | yes | e.g. "global", "orchestrator/pi" |
| type | yes | user, feedback, project, reference, episode |
| content | yes | Human-readable memory text |
| createdBy | yes | pi, tau, phi, system |
| relatesTo | no | `{ targetId, type: "updates"|"extends"|"derives" }` |
| ttl | no | ISO timestamp for auto-expiry |

### recall
Semantic vector search over all memories.

| Param | Required | Description |
|-------|----------|-------------|
| query | yes | Natural language search query |
| namespace | no | Filter to a namespace |
| type | no | Filter to a memory type |
| limit | no | Max results (default 5, max 50) |

Returns: array of `{ memoryId, score, namespace, type, content }`

### store_episode
Store a structured episodic memory.

| Param | Required | Description |
|-------|----------|-------------|
| namespace | yes | e.g. "orchestrator/tau" |
| createdBy | yes | pi, tau, phi, system |
| context | yes | What was the situation |
| goal | yes | What was being attempted |
| action | yes | What was done |
| outcome | yes | What happened (success/failure) |
| insight | yes | The lesson — what to do differently |
| severity | yes | critical, major, minor |

### get_profile
Fetch an orchestrator's profile.

| Param | Required | Description |
|-------|----------|-------------|
| orchestratorId | yes | pi, tau, phi |

### update_profile
Create or update an orchestrator profile.

| Param | Required | Description |
|-------|----------|-------------|
| orchestratorId | yes | pi, tau, phi |
| name | yes | Human-readable name |
| static | yes | { role, workspace, capabilities[] } |
| dynamic | yes | { lastSeen, sessionCount, currentTask? } |

### list_memories
List memories by namespace with optional type filter.

| Param | Required | Description |
|-------|----------|-------------|
| namespace | yes | Which namespace to list |
| type | no | Filter to a type |
| limit | no | Max results (default 50) |

## Search modes

The Convex backend supports three search modes (via `@convex-dev/rag`):

1. **Vector search** (`recall` MCP tool) — semantic similarity via cosine distance
2. **Text search** — BM25 full-text search
3. **Hybrid search** — vector + text merged via Reciprocal Rank Fusion (RRF)

The MCP `recall` tool uses vector search. Text and hybrid search are available via direct Convex function calls.

## Installation

Already installed as user-scoped MCP in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "vantage-memory": {
      "command": "bun",
      "args": ["/home/laurentperello/coding/vantage-memory/mcp-server/server.ts"],
      "env": {
        "CONVEX_URL": "https://efficient-guineapig-356.convex.cloud"
      }
    }
  }
}
```

The Vercel AI Gateway key (`AI_GATEWAY_API_KEY`) is set as a Convex environment variable, not in the MCP config.

## Convex deployment

- Project: vantage-memory
- Dashboard: https://dashboard.convex.dev/d/efficient-guineapig-356
- Deploy: `cd ~/coding/vantage-memory && npx convex dev --once`

## CLAUDE.md integration

Add to any orchestrator's CLAUDE.md:

```markdown
## SHARED MEMORY (non-negotiable)

You have access to VantageMemory via MCP tools.

1. On session start: `recall` your namespace for relevant context.
2. After every failure: `store_episode` with context/goal/action/outcome/insight.
3. Before repeating a mistake: `recall` similar past episodes.
4. Store non-obvious learnings via `store_memory`.
5. Use `orchestrator/[name]` for personal, `global` for shared.
```

## Tech stack

- **Convex** — real-time database + vector search
- **@convex-dev/rag** — embedding, indexing, hybrid search
- **Vercel AI Gateway** — OpenAI text-embedding-3-small via `@ai-sdk/openai-compatible`
- **MCP SDK** — `@modelcontextprotocol/sdk` for Claude Code integration
- **Bun** — runtime for MCP server
