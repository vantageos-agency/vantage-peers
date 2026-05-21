# VantagePeers

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns.

## Stack

- Backend: Convex (real-time database, serverless functions)
- MCP Server: Node.js, `@modelcontextprotocol/sdk`
- Embeddings: `@convex-dev/rag` with text-embedding-3-small (1536 dims)
- Search: Vector (cosine), BM25 text, Hybrid (RRF fusion)

## Environment Variables

Set in Convex dashboard (Settings → Environment Variables):
- `AI_GATEWAY_API_KEY` — OpenAI-compatible API key for embeddings
- `GITHUB_WEBHOOK_SECRET` — (optional) for GitHub webhook signature validation
- `GITHUB_TOKEN` — (optional) for GitHub API calls

## Development

```bash
bun install
npx convex dev
```

## MCP Server

```bash
cd mcp-server
npm run build
CONVEX_URL=https://your-deployment.convex.cloud node dist/server.js
```
