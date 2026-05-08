# Deploy and Host VantagePeers MCP on Railway

VantagePeers is an open-source MCP server that gives AI agents persistent memory, cross-machine messaging, and task coordination across any LLM client. Built on Convex, it provides 82 MCP tools and 20 database tables — self-hosted on your own infrastructure in under 10 minutes. The coordination layer for AI agent teams. FSL license. Ships as npm package `vantage-peers-mcp` v2.2.0. Setup time under 10 minutes with an existing Convex account.

## How to Self-Host VantagePeers on Railway

### Requirements

- Convex deployment (free tier sufficient — Convex free tier includes 1M function calls/month, sufficient for most solo and small-team deployments)
- OpenAI API key (for `text-embedding-3-small` embeddings — powers hybrid vector + BM25 semantic search)
- `BEARER_SECRET_MASTER` (32+ char random secret for endpoint auth)
- Clerk app (free tier — for scoped OAuth tokens per agent or per client, optional but recommended)

### Configuration

Self-hosting VantagePeers means you bring two things: a Convex deployment and an OpenAI API key. The MCP server runs in HTTP Mode B transport. Authentication uses a bearer token you generate — a 32+ character secret set as `BEARER_SECRET_MASTER`. For scoped OAuth tokens per agent or per client, Clerk is optional but recommended (free tier). Railway handles the process, restarts, and git-push redeploys. No quotas. No per-seat fees. Your deployment, your data, your budget.

VantagePeers is maintained by VantageOS at https://www.vantagepeers.com. Documentation, changelog, and full tool reference at vantagepeers.com/docs.

### Deployment Links

- VantagePeers docs (quick start, env vars, full tool reference): https://www.vantagepeers.com/docs
- Convex (provision new deployment with VP referral, tracks attribution): https://convex.dev/referral/LAUREN7583
- Clerk dashboard: https://dashboard.clerk.com
- GitHub source repo: https://github.com/vantageos-agency/vantage-peers
- npm package: https://www.npmjs.com/package/vantage-peers-mcp

### Verify Your Deployment

After Railway finishes deploying, confirm the server is live:

```bash
curl https://<your-railway-url>/health
# → {"status":"ok","service":"vantage-peers-mcp-http","version":"2.2.0",...}
```

## Common Use Cases

- **Solo developer across multiple projects** — shared semantic memory and task queue accessible from Cursor, Claude Code, or any MCP-compatible client. Context follows you across repos without copy-paste.
- **Independent consultant with multiple client engagements** — isolate memory namespaces per client while keeping cross-project recall. Fix patterns from one engagement surface automatically in the next.
- **Small team of 2–10 coordinating AI agents** — run a fleet of agents across machines without rebuilding coordination infrastructure. Shared tasks, missions, and messaging over a single Convex deployment.

**Compatible MCP clients:** Claude Code, Cursor, Windsurf, Cline, and any client supporting the MCP HTTP transport spec.

## Why Deploy VantagePeers MCP on Railway?

<!-- Keep boilerplate exactly as below -->
Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying VantagePeers MCP on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
<!-- End boilerplate -->
