# vantage-peers-mcp

Model Context Protocol (MCP) server for VantagePeers — Convex-backed multi-agent task, memory, and messaging primitives.

This `packages/mcp-server/` directory is a documentation index pointing to the canonical source at `mcp-server/` (sibling at repo root) and the published npm artifact.

- **npm** : [`vantage-peers-mcp`](https://www.npmjs.com/package/vantage-peers-mcp) (v2.3.3)
- **Source** : [`mcp-server/`](../../mcp-server/)
- **Issues** : [GitHub Issues](https://github.com/vantageos-agency/vantage-peers/issues)
- **License** : MIT

## Quickstart (self-host)

```bash
npm install -g vantage-peers-mcp
```

Add to your Claude Desktop `claude_desktop_config.json` (or Claude Code `.mcp.json`) :

```json
{
  "mcpServers": {
    "vantage-peers": {
      "command": "npx",
      "args": ["-y", "vantage-peers-mcp"],
      "env": {
        "CONVEX_URL": "https://your-deployment.convex.cloud",
        "BEARER_TOKEN": "your-token"
      }
    }
  }
}
```

## VP Cloud (managed beta) onboarding

VP Cloud beta is in pre-launch validation. Beta testers (e.g. Marie/Iris RH cohort) receive credentials from the VantagePeers team and configure their client with `CONVEX_URL=https://compassionate-goldfinch-737.convex.cloud` + a tenant-scoped bearer token. Reach out via the project repo for beta access.

DCR (Dynamic Client Registration) self-registration is tenant-scoped only ; master scope requires explicit admin authorization (v2.3.4+, see security note).

## List-query params (v2.3.x highlights)

The 4 list tools (`list_tasks`, `list_tasks_by_mission`, `list_missions`, `list_briefing_notes`) expose :

- `fields="lite"` — compact projection, typical 5-10x smaller payload
- `status` — single, alias (`open`/`active`/`all`), or array
- `createdBy` — filter by creator (`list_tasks` + `list_tasks_by_mission`)
- `updatedSince` — Unix ms window filter
- Auto-clamp safeguard — `fields="full"` + no explicit `limit` is clamped to 30 (15 for briefingNotes)

Example — Pi pull-cycle :
```text
list_tasks createdBy="pi" status="review" fields="lite" limit=30
```

## Tool catalog

The MCP server exposes 80+ tools across these primitives :

- **Tasks** : create, update, start, complete, block, list (with filters), list_by_mission
- **Missions** : create, update, list, get, update_status, link templates
- **Briefing notes** : create, update, list, delete
- **Memories** : store, recall (vector + BM25 + hybrid), list, get, soft_delete
- **Fix patterns** : create, list, search, link to issues, validate
- **Messages** : send, check, mark_as_read, list
- **Diary** : write, get, list
- **Profiles, BUs, Components, Mandates, Recurring tasks, Deployments, Issues** : full CRUD + lifecycle

See [main README](../../README.md) for the full reference.

## Versions

See [CHANGELOG.md](../../CHANGELOG.md) for the full version history. Current : **v2.3.3**.

## Doctrine compliance

- Multi-tenant isolation enforced at every tool via namespace scope gates
- Bearer 4-layer auth (master → OAuth scoped → DCR tenant-scoped → legacy tenants)
- Evidence-Bound Done — every task completion carries verifiable proof tokens
- STRICT TDD on the canonical `mcp-server/` source

---

Maintained by the VantageOS team.
