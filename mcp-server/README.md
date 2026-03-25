# VantagePeers MCP Server

MCP server that exposes VantagePeers Convex functions as Claude Code tools via stdio transport.

## Prerequisites

- [Bun](https://bun.sh) installed
- Convex deployment running (`CONVEX_URL` set)
- OpenAI API key set as Convex env var (`AI_GATEWAY_API_KEY`)

## Setup

Add to `~/.claude/settings.json` (user-scoped) or `.claude/settings.json` (project-scoped):

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

Or omit `CONVEX_URL` and let the server read it from `.env.local` in the project root.

## Verify

```bash
bun run mcp-server/server.ts
```

The server waits for MCP JSON-RPC messages on stdin. No output = healthy.

## 27 Tools

See the main [README](../README.md) for the complete tool reference.
