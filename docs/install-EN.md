---
title: "Self-Host VantagePeers — Installation Guide"
description: "Step-by-step instructions to deploy your own VantagePeers instance on Convex."
---

> Cette documentation est également disponible en francais : [install-FR.md](./install-FR.md)

VantagePeers is a self-hosted coordination layer for AI agent teams. This guide walks you through a full production deployment — from cloning the repository to sending your first MCP tool call. Budget roughly 20 minutes for a first-time setup.

---

## Supported MCP Clients

VantagePeers supports three client connection methods. Each uses a different authentication mechanism.

| Client            | Auth method            | Setup                                     |
|-------------------|------------------------|-------------------------------------------|
| Claude Code       | BEARER token           | `.mcp.json` with `Authorization` header   |
| Claude Desktop    | BEARER token           | `claude_desktop_config.json` same pattern |
| Claude.ai (web)   | OAuth 2.1 DCR          | Add custom MCP integration → enter URL    |

Claude Code and Claude Desktop use a static bearer token (`BEARER_SECRET_MASTER`) in every HTTP request. Claude.ai web uses OAuth 2.1 Dynamic Client Registration (RFC 7591) with server metadata discovery (RFC 8414) and the protected resource metadata standard (RFC 9728) — the browser handles the full OAuth flow automatically when you enter your Railway URL.

---

## Choose Your MCP Mode

Before you begin, decide how you will connect Claude to VantagePeers. There are two modes. Pick one and follow the corresponding sub-section in Step 6.

```
Mode A — stdio local (recommended if you only use Claude Code)
  - Simplest setup, no server to deploy
  - Per-machine install: runs on your laptop, not shared
  - Single user
  - Choose this if: you access VantagePeers exclusively through Claude Code
                   on your own machine

Mode B — HTTP hosted (required for Claude.ai web, or for team access)
  - Deploy the MCP server once to Railway or Fly.io
  - Multiple users supported via OAuth (bu-dashboard admin UI)
  - Production-grade, accessible from any Claude client including Claude.ai web
  - Choose this if: you need Claude.ai web access, OR you want to share
                   the deployment with colleagues
```

Both modes share Steps 1 through 5 (Convex deployment, secrets, license). They diverge at Step 6.

---

## 1. Prerequisites

Ensure the following are available on your machine and in your accounts before you begin.

### Runtime

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20 or later | [nodejs.org](https://nodejs.org) |
| bun | latest | One-line install below |
| Git | any recent | [git-scm.com](https://git-scm.com) |

Install bun with a single command:

```bash
curl -fsSL https://bun.sh/install | bash
```

### Accounts

- **GitHub account** — used to clone the repository and (optionally) connect GitHub issue tracking.
- **Convex account** — the backend that stores all agent memory and coordination data. Free tier is sufficient. Sign up at [https://convex.dev](https://convex.dev).
- **Railway account** *(Mode B only)* — required if you deploy the MCP server as an HTTP service. Free plan is sufficient for most teams. Sign up at [https://railway.com?referralCode=vantagepeers](https://railway.com?referralCode=vantagepeers).
- **Claude Code or Claude Web account** — required to connect agents via MCP. [Claude Code](https://claude.ai/code) is recommended for local development; Claude Web works for browser-based agents.

---

## 2. Step 1 — Clone the Repository

Clone the repository, enter the project directory, and install all dependencies in one go:

```bash
git clone https://github.com/vantageos-agency/vantage-peers.git && cd vantage-peers && bun install
```

This pulls the source code and installs both the Convex backend dependencies and the MCP server package.

---

## 3. Step 2 — Provision a Convex Deployment

Run the Convex development server. On first run, it will walk you through a one-time provisioning flow that creates a new Convex deployment linked to your account:

```bash
npx convex dev
```

What happens during provisioning:

1. Your browser opens to the Convex login page (if you are not already authenticated).
2. Convex creates a new project and deployment in your account.
3. The CLI prints your **deployment URL** (`https://<your-project>.convex.cloud`) and writes a local `.env.local` file with your admin credentials.
4. The dev server stays running and watches for schema changes. You can leave it running in a separate terminal or stop it with `Ctrl+C` — your deployment is already created.

Keep a note of the deployment URL printed in the terminal. You will need it in Step 6.

---

## 4. Step 3 — Set Environment Variables and Secrets

VantagePeers requires several secrets to be set directly in your Convex deployment. Use `npx convex env set` for each one. These values are stored securely on Convex infrastructure and are never written to disk locally.

```bash
# Authentication — master bearer token for MCP calls (choose a strong random value)
npx convex env set BEARER_SECRET_MASTER "<your-secret-token>"

# GitHub integration — personal access token with repo + read:org scopes
npx convex env set GITHUB_TOKEN "<your-github-token>"

# Embeddings — AI key for text-embedding-3-small (choose ONE of the two options below)
#
# Option A (recommended) — Vercel AI Gateway
#   Requires a Vercel account with AI Gateway enabled.
npx convex env set AI_GATEWAY_API_KEY "<your-vercel-ai-gateway-key>"
#
# Option B — Direct OpenAI (BYOK self-host, no Vercel account required)
#   Set this instead of AI_GATEWAY_API_KEY if you do not use Vercel.
#   The system automatically uses api.openai.com when only this key is present.
npx convex env set OPENAI_API_KEY "<your-openai-api-key>"
#
# Note: if both are set, AI_GATEWAY_API_KEY takes priority.

# Gumroad license webhooks — secret provided in your Gumroad seller dashboard
npx convex env set GUMROAD_WEBHOOK_SECRET "<your-gumroad-webhook-secret>"

# Gumroad product identifiers — found in your Gumroad product URLs
npx convex env set GUMROAD_PRODUCT_ID_EN "<product-id-english>"
npx convex env set GUMROAD_PRODUCT_ID_FR "<product-id-french>"
```

**Required vs optional:** `BEARER_SECRET_MASTER` and one of `AI_GATEWAY_API_KEY` (Vercel gateway) or `OPENAI_API_KEY` (direct OpenAI) are required for the MCP server to function. The Gumroad variables are required only if you plan to sell or validate licenses. `GITHUB_TOKEN` is required only if you use GitHub issue tracking or orchestrator signatures.

You can verify your variables are set by running:

```bash
npx convex env list
```

---

## 5. Step 4 — Deploy to Production

When you are ready to go beyond the local dev server, deploy your schema and functions to the production target:

```bash
npx convex deploy --yes
```

This command pushes all Convex functions and schema changes to your production deployment using the deploy key stored in `.env.local`. The `--yes` flag skips the confirmation prompt, making it suitable for CI pipelines.

After this command completes, your backend is live and stable — independent of any running local process.

---

## 6. Step 5 — Register Your License Key

Your VantagePeers license key arrives by email within 60 seconds of a successful Gumroad purchase. Set it as a Convex environment variable:

```bash
npx convex env set VP_LICENSE_KEY "<key-from-email>"
```

This key activates the open-core features of your deployment and is validated on each MCP connection. If your key expires, renew your subscription on Gumroad and re-run this command with the new key.

---

## 7. Step 6 — Connect the MCP Server to Claude

Both modes connect Claude to the same Convex backend you provisioned above. Follow the sub-section that matches your choice from the decision tree.

### Mode A — stdio local (Claude Code only)

This mode runs the MCP server as a local child process spawned by Claude Code. No additional server infrastructure is required.

**Step 6-A-1.** Install the MCP package globally (or skip this step and use `npx` on demand — the JSON snippet below handles it automatically):

```bash
npm install -g vantage-peers-mcp@latest
```

**Step 6-A-2.** Add the following block to your Claude Code MCP configuration file at `~/.claude.json`. If the `mcpServers` key already exists, merge this entry into it:

```json
{
  "mcpServers": {
    "vantage-peers": {
      "command": "npx",
      "args": ["-y", "vantage-peers-mcp"],
      "env": {
        "CONVEX_URL": "https://<your-project>.convex.cloud",
        "VP_LICENSE_KEY": "<your-license-key>"
      }
    }
  }
}
```

Replace `<your-project>` with the subdomain printed by `npx convex dev`, and `<your-license-key>` with the key you set in Step 5.

**Step 6-A-3.** Restart Claude Code. The MCP server will start automatically on the next session.

Proceed to Step 7 to verify the connection.

---

### Mode B — HTTP hosted (Claude Code + Claude Web)

This mode deploys the MCP server as a persistent HTTP service. Both Claude Code and Claude Web connect to it over the network. A Railway one-click template is provided for the fastest path to production.

**Step 6-B-1.** Deploy to Railway using the template:

Click the button below (or visit the URL directly) to open the Railway deployment wizard:

```
https://railway.com/deploy/vantagepeers-mcp
```

**Step 6-B-2.** In the Railway wizard, set the environment variables for each layer:

**In Railway** (Variables tab — 3 service vars):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `CONVEX_URL_INTERNAL` | `https://<your-project>.convex.cloud` |
| `BEARER_SECRET_MASTER` | The same value you set in Step 3 |

**In Convex** (`npx convex env set <KEY> <VALUE>` or Convex dashboard → Settings → Environment Variables — 3 backend vars):

| Variable | Value |
|---|---|
| `BEARER_SECRET_MASTER` | The same value as Railway above (consistency required for auth) |
| `AI_GATEWAY_API_KEY` | Your Vercel AI Gateway key — OR use `OPENAI_API_KEY` for direct OpenAI (BYOK). If both are set, `AI_GATEWAY_API_KEY` takes priority. |
| `VP_LICENSE_KEY` | The license key from Step 5 |

**Step 6-B-3.** Confirm the deployment. Railway will build and start the MCP server — this typically takes around two minutes.

**Step 6-B-4.** Once the deploy is complete, note your public URL. It will look like:

```
https://vantage-peers-mcp-xxx.up.railway.app
```

**Step 6-B-5.** Connect Claude Code (HTTP transport). Add the following to `~/.claude.json`:

```json
{
  "mcpServers": {
    "vantage-peers": {
      "url": "https://vantage-peers-mcp-xxx.up.railway.app",
      "headers": {
        "Authorization": "Bearer <your-license-token>"
      }
    }
  }
}
```

Replace the URL and token with your actual Railway URL and license token.

**Step 6-B-6.** Connect Claude Code (HTTP transport, if not already done in Step 6-B-5). Confirm the `.claude.json` entry is saved.

**Step 6-B-7.** Connect Claude.ai web (OAuth 2.1 DCR — no token required).

See the dedicated section below: [Add to Claude.ai web](#add-to-claudeai-web).

**Step 6-B-8.** Restart Claude Code (or refresh Claude.ai web). Proceed to Step 7 to verify.

---

## Add to Claude.ai web

Claude.ai web connects to VantagePeers via OAuth 2.1 Dynamic Client Registration (RFC 7591). The browser negotiates credentials automatically — you do not paste any bearer token.

Requirements: Mode B (HTTP hosted) must be deployed and running. The Railway URL is all you need.

1. Open [https://claude.ai](https://claude.ai) and sign in.
2. Go to **Settings → Integrations → Custom MCP servers**.
3. Click **"Add custom integration"**.
4. Enter your Railway MCP URL: `https://<your-deployment>.up.railway.app`
5. Claude.ai performs OAuth 2.1 DCR (RFC 7591) — it discovers server metadata (RFC 8414 + RFC 9728), auto-registers a client, and obtains an access token. No manual token entry required.
6. Authorize the connection when prompted.
7. All 82 MCP tools are immediately available in your Claude.ai web sessions.

---

## 8. Step 7 — First Test Call

Once Claude Code has restarted and picked up the new MCP server configuration, ask your agent to run:

```
mcp__vantage-peers__list_peers
```

A successful response returns a JSON array of registered orchestrator profiles. On a fresh installation with no agents registered yet, the array will be empty — this is expected. It confirms the MCP server is reachable and authenticated.

```json
[]
```

To register your first peer, call `mcp__vantage-peers__register_peer` with your agent's name and role. Subsequent calls to `list_peers` will return that entry.

---

## 8b. Available MCP Tools — Fix Patterns (new in v2.2.0)

Version 2.2.0 of `vantage-peers-mcp` ships four new tools that power the knowledge-base learning cycle. They are available immediately after a successful Step 7 verification — no additional configuration required.

| Tool | Description |
|---|---|
| `create_fix_pattern` | Document a bug symptom, root cause, and fix in the shared KB so the same bug is never debugged twice. |
| `add_fix_attempt` | Log a fix attempt against an existing pattern — whether it worked and why. If it worked and no validated fix exists yet, the pattern is auto-updated. |
| `validate_fix` | Promote a candidate fix to validated status after independent production confirmation. |
| `link_issue_to_pattern` | Create a bidirectional link between a VantagePeers issue and a fix pattern. |

The recommended entry point before touching any code is `search_fix_patterns` (Search / RAG category), which queries the KB using semantic vector search.

For the full fix-pattern cycle — including when to call each tool and how they chain together — see the [Fix patterns cycle](../mcp-server/README.md#fix-patterns-cycle) section in the MCP server README.

---

## 9. Troubleshooting

### `recall` (or any embedding-based tool) returns 500

The Convex deployment cannot reach an AI embedding provider because neither `AI_GATEWAY_API_KEY` nor `OPENAI_API_KEY` is set.

**Fix:** Set at least one of the two keys in your Convex deployment:

```bash
# Option A — Vercel AI Gateway (recommended if you have a Vercel account)
npx convex env set AI_GATEWAY_API_KEY "<your-vercel-ai-gateway-key>"

# Option B — Direct OpenAI BYOK (no Vercel account required)
npx convex env set OPENAI_API_KEY "<your-openai-api-key>"
```

Then re-run `npx convex deploy --yes` to push the updated environment to production.

---

### "Unauthorized" error on any MCP call

The bearer token sent by the MCP client does not match `BEARER_SECRET_MASTER` in your Convex deployment.

**Fix:** Verify the value set in Convex matches the `BEARER_TOKEN` env var in your `~/.claude.json`:

```bash
npx convex env list | grep BEARER_SECRET_MASTER
```

Then confirm it matches the `BEARER_TOKEN` value in your MCP server config.

---

### Convex deploy fails with "Not Authorized"

This typically means you have not authenticated the Convex CLI yet, or your session has expired.

**Fix:** Run `npx convex dev` first to complete the browser-based login flow, then re-run `npx convex deploy --yes`.

---

### `list_peers` returns an empty array

This is normal on a fresh installation. No orchestrator profiles have been seeded yet.

**Fix:** This is not an error. Register your first peer with `mcp__vantage-peers__register_peer`. The list will populate as agents check in.

---

### 403 — License expired

Your `VP_LICENSE_KEY` has passed its validity period.

**Fix:** Renew your VantagePeers subscription at [https://gumroad.com/vantageos](https://gumroad.com/vantageos). Once you receive the new license key by email, update it:

```bash
npx convex env set VP_LICENSE_KEY "<new-key-from-email>"
```

---

### "Cannot resolve to a Repository" on GitHub tool calls

The `GITHUB_TOKEN` you set is missing the required scopes, or it has expired.

**Fix:** Generate a new GitHub personal access token with at minimum the `repo` scope (add `read:org` if you use organization repositories). Then update it:

```bash
npx convex env set GITHUB_TOKEN "<new-github-token>"
```

---

### Mode A — "Command not found: npx"

The MCP server process cannot find `npx` because Node.js 20+ is not installed or is not on the PATH visible to Claude Code.

**Fix:** Install Node.js 20 or later from [https://nodejs.org](https://nodejs.org), then restart your terminal and Claude Code.

---

### Mode A — "Cannot find module 'vantage-peers-mcp'"

The package is not installed globally, and `npx` failed to fetch it (e.g. offline or registry issue).

**Fix:** Run `npm install -g vantage-peers-mcp@latest` and retry. If you are in a restricted network environment, ensure `registry.npmjs.org` is reachable.

---

### Mode B — "503 Service Unavailable" on MCP calls

The Railway deployment did not start successfully, or is still building.

**Fix:** Open your Railway project dashboard, navigate to the deployment logs, and look for build or startup errors. Common causes include a missing environment variable or an out-of-memory crash during startup.

---

### Mode B — "401 Unauthorized" on HTTP MCP calls

The `Authorization` header sent by Claude does not match the token expected by the hosted MCP server.

**Fix:** Verify that the token in `~/.claude.json` (or the Claude Web connector settings) matches `BEARER_SECRET_MASTER` exactly — no extra spaces or line breaks. Update both Railway's env var and your client config if you rotate the secret.

---

> For further support, open an issue at [github.com/vantageos-agency/vantage-peers](https://github.com/vantageos-agency/vantage-peers) or contact the VantageOS team directly.
