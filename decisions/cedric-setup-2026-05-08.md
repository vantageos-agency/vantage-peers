# Cédric Onboarding Kit — VantagePeers Pro Support

*Issued by VantageOS · 2026-05-08 · Tier: Pro Support €99/year (self-host)*

Welcome aboard. This kit walks you from zero to a running VantagePeers MCP deployment with Claude Code in under 15 minutes. Pro Support includes 1 year of email support for setup, environment troubleshooting, and tool usage questions.

---

## How to connect — three options

| Client            | Auth method            | Setup                                    |
|-------------------|------------------------|------------------------------------------|
| Claude Code       | BEARER token           | `.mcp.json` with `Authorization` header  |
| Claude Desktop    | BEARER token           | `claude_desktop_config.json` same pattern|
| Claude.ai (web)   | OAuth 2.1 DCR          | Add custom MCP integration → enter URL   |

Claude.ai web is the simplest: you just paste your Railway URL and click Authorize. No tokens, no config files.

---

## What you get

- **Self-hosted MCP server** — your own deployment of `vantage-peers-mcp` v2.2.0 (npm), running on Railway, backed by your Convex project. No quotas. No per-seat fees.
- **82 MCP tools** — memory, tasks, missions, messaging, fix patterns, briefing notes, diary, more. Full reference at [vantagepeers.com/docs/tools](https://vantagepeers.com/docs/tools).
- **Plug-and-play plugin** — `/plugin marketplace add vantageos-agency/vantage-peers-plugin` then `/plugin install vantage-peers@vantage-peers-plugin` adds an expert agent + 5 skills + CLAUDE.md template to any Claude Code workspace.
- **License key** — your `VP_LICENSE_KEY` (sent separately by email).

---

## Setup (9 steps)

### 1. Click the Railway template

If you don't have a Railway account yet, create one first: [https://railway.com?referralCode=vantagepeers](https://railway.com?referralCode=vantagepeers) (free plan is sufficient).

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/vantagepeers-mcp)

Direct link: <https://railway.com/deploy/vantagepeers-mcp>

This forks `vantageos-agency/vantage-peers` into your Railway project and starts the build. Don't set env vars yet — we'll do that in step 5.

### 2. Provision a Convex deployment

Open [convex.dev/referral/LAUREN7583](https://convex.dev/referral/LAUREN7583) and create a new project. Convex's free tier (1M function calls/month) is sufficient for solo and small-team use.

After provisioning, copy your deployment URL — it looks like `https://<animal-name>-<digits>.convex.cloud`. You'll paste it in step 5.

### 3. Generate your bearer secret

This secret protects every HTTP request to your MCP server. Generate a 32-byte random hex string:

```bash
openssl rand -hex 32
```

Copy the output (a 64-character string). You'll paste it in step 5 and reuse it in step 8.

### 4. Locate your VP license key

Pi sends `VP_LICENSE_KEY` via email after order confirmation. If you don't see it in your inbox, reply to the order email or write to <hello@vantageos.agency>.

### 5. Fill environment variables

Environment variables are split across two systems — Railway runs the MCP server, Convex holds the data. Each layer gets its own set.

**In Railway** (your service → **Variables** tab — 3 service vars):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `CONVEX_URL_INTERNAL` | `https://<your-deployment>.convex.cloud` (from step 2) |
| `BEARER_SECRET_MASTER` | the 64-char hex from step 3 |

Save. Railway redeploys automatically.

**In Convex** (`npx convex env set <KEY> <VALUE>` or Convex dashboard → Settings → Environment Variables — 3 backend vars):

| Variable | Value |
|---|---|
| `BEARER_SECRET_MASTER` | same 64-char hex as Railway above (must match for auth to work) |
| `AI_GATEWAY_API_KEY` | your OpenAI-compatible key via Vercel AI Gateway — OR set `OPENAI_API_KEY` instead for direct OpenAI BYOK (no Vercel account required). If both are set, `AI_GATEWAY_API_KEY` takes priority. |
| `VP_LICENSE_KEY` | from step 4 |

### 6. Smoke test the deployment

Once Railway shows the deployment as live (green status), run:

```bash
curl https://<your-deployment>.up.railway.app/health
```

Expect:

```json
{"status":"ok","service":"vantage-peers-mcp-http","version":"2.2.0","transport":"streamable-http","oauth":"scoped-tokens"}
```

If `version` is anything other than `2.2.0`, ping us — that's a deploy issue.

### 7. Install the plugin in Claude Code

In any Claude Code workspace:

```
/plugin marketplace add vantageos-agency/vantage-peers-plugin
/plugin install vantage-peers@vantage-peers-plugin
```

The plugin pulls down: an expert agent (purple, knows all 82 tools + namespacing + memory protocol), five skills (`/check-messages`, `/pre-compact`, `/daily-start`, `/close-day`, `/vantage-peers-init`), and templates for your CLAUDE.md and `.mcp.json`.

### 8. Configure `.mcp.json`

In your Claude Code workspace, copy the template from `templates/.mcp.json.template` (now part of the installed plugin) into `.mcp.json` at the project root, then fill the placeholders:

```json
{
  "mcpServers": {
    "vantage-peers": {
      "type": "http",
      "url": "https://<your-deployment>.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer <your-bearer-secret-from-step-3>"
      }
    }
  }
}
```

Restart Claude Code (`Cmd/Ctrl+R` or close + reopen) so it picks up the MCP server.

### 9. Verify and start using

In Claude Code, run the verification skill:

```
/vantage-peers-init
```

It runs three checks: config registered, `/health` returns 2.2.0, smoke `recall query="test"` succeeds. If all green, you're done. Try:

```
/check-messages
```

Or just talk to your AI: *"store a memory that we use Convex on the EU region"* — the expert agent picks the right tool automatically.

---

## Add to Claude.ai web (optional — no config file needed)

If you want to use VantagePeers directly from your browser at claude.ai, here's all you do:

1. Open [https://claude.ai](https://claude.ai) and sign in.
2. Go to **Settings → Integrations → Custom MCP servers**.
3. Click **"Add custom integration"**.
4. Paste your Railway URL: `https://<your-deployment>.up.railway.app`
5. Claude.ai will handle authentication automatically — it opens a quick authorization screen, you click Allow, and you're done.
6. All 82 tools are live in your Claude.ai web sessions immediately.

No bearer token, no JSON to edit. Claude.ai uses OAuth 2.1 under the hood, which means it generates and manages its own credentials automatically.

---

## Zero-touch auto-updates (one-time setup required)

Your Railway deployment needs one manual setting to receive automatic daily updates. Once set, every PATCH and MINOR release of `vantage-peers-mcp` reaches you overnight with no action on your part.

**ONE-TIME action** — do this once, then forget it:

1. Open your Railway project.
2. Click the **vantage-peers-mcp** service card.
3. Go to the **Settings** tab.
4. Scroll to **Cron Schedule**.
5. Enter `0 3 * * *`
6. Click **Save**.

Railway will restart your service at 03:00 UTC each night, pull the latest `vantage-peers-mcp` from npm, and run any pending schema migrations automatically. No data is lost on restart — all state lives in Convex.

MAJOR version upgrades (breaking changes) will always come with advance notice and a migration guide at [vantagepeers.com/docs/migrations](https://vantagepeers.com/docs/migrations). The cron covers PATCH and MINOR updates only.

---

## What's included in Pro Support (1 year)

- Email support for setup issues, env var debugging, plugin installation
- Tool usage questions (which MCP tool for what, namespacing conventions, memory types)
- Bug reports against `vantage-peers-mcp` and the `vantage-peers` plugin
- Convex schema migration guidance when versions bump

**Out of scope** (available as separate engagement): custom integrations, agent fleet design, namespace strategy for >5 clients, training cohorts.

---

## Quick reference

- **Docs hub**: <https://vantagepeers.com/docs>
- **Tools reference**: <https://vantagepeers.com/docs/tools>
- **Source repo**: <https://github.com/vantageos-agency/vantage-peers>
- **npm package**: <https://www.npmjs.com/package/vantage-peers-mcp>
- **Convex (provision)**: <https://convex.dev/referral/LAUREN7583>
- **Plugin marketplace entry**: <https://github.com/vantageos-agency/vantage-peers-plugin>
- **Support**: <hello@vantageos.agency>

Welcome to the VantagePeers ecosystem.

— VantageOS
