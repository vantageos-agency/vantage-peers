# VantageMemory MCP Server

MCP server that wraps VantageMemory Convex functions as Claude Code tools via stdio transport.

## Tools

| Tool | Description |
|------|-------------|
| `store_memory` | Create a typed memory (user/feedback/project/reference) |
| `recall` | Semantic vector search over memories |
| `store_episode` | Create an episodic memory with context/goal/action/outcome/insight |
| `get_profile` | Fetch an orchestrator profile (pi/tau/phi) |
| `update_profile` | Create or update an orchestrator profile |
| `list_memories` | List active memories by namespace with optional type filter |

## Prerequisites

- [Bun](https://bun.sh) installed
- Convex deployment running (`.env.local` must have `CONVEX_URL`)
- OpenAI API key set (`OPENAI_API_KEY`) — used by the `recall` tool for embeddings

## Installation as user-scoped MCP server

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "vantage-memory": {
      "command": "bun",
      "args": ["/home/laurentperello/coding/vantage-memory/mcp-server/server.ts"],
      "env": {
        "CONVEX_URL": "https://efficient-guineapig-356.convex.cloud",
        "OPENAI_API_KEY": "<your-key>"
      }
    }
  }
}
```

Or omit `CONVEX_URL` from env and let the server read it from `.env.local` (auto-resolved from project root).

## Verify the server starts

```bash
cd /home/laurentperello/coding/vantage-memory
bun run mcp-server/server.ts
```

The server will wait for MCP JSON-RPC messages on stdin. No output = healthy (MCP uses stdio).

## Local dev install (node_modules)

```bash
cd /home/laurentperello/coding/vantage-memory/mcp-server
npm install
```
