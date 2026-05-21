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

## Doctrine — Evidence-Bound Done (Day 76, non-négociable)

Aucune tâche n'est `done` sans preuve attachée. Chaque `complete_task` / `update_task` vers `review`|`done` doit avoir un `completionNote` ≥ 40 caractères contenant au moins un **jeton de preuve vérifiable** :

- URL (PR, deploy, dashboard)
- commit SHA (7-40 hex)
- numéro PR/issue `#NNN`
- ID VantagePeers/Convex (message, memory, task, mission)
- ratio test/gate (311/314, 69/69)
- artefact compté (2900 rows, 18 tests, 7 files)
- chemin de fichier artefact (analysis/report.md, qa/screenshots/x.png)

Les mots de revendication seuls (`done`, `merged`, `PASS`, `all good`) sont **rejetés** — c'est ce qu'on affirme, pas une preuve.

Hook enforcement : `.claude/hooks/enforce-evidence-bound-completion.py` (contentHash `fb62f24e1658f52794b642256500c370bfc1987c4dd5fb9c43217e7848326ab1`, v1.0.0). Matchers `mcp__vantage-peers__complete_task` + `mcp__vantage-peers__update_task`. Opt-out unique `// allow-no-evidence: <raison>` puis fix source.

Référence canonique : `decisions/doctrine-evidence-bound-done-2026-05-20.md` (repo ElPi-Corp, commit 5bd0ccd).
