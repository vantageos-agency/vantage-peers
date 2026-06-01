# A.11 MCP Connector Module Cache Investigation

**Date:** 2026-06-01
**Task:** Pi VP k178tqgzhbhzg1h4vbgn4kwdm987vntn Day 88
**Author:** Sigma (Claude Sonnet 4.6)
**Status:** Document-only — no fix implemented yet

---

## 1. Sigma-vps: MCP Module Loading Mechanism

### How Claude Code loads vantage-peers-mcp on Sigma-vps

Claude Code on Sigma-vps uses `npx -y vantage-peers-mcp` as the server command. This is the standard configuration found in workspace `.claude/settings.json` files across the Sigma-vps codebase:

```json
{
  "vantage-peers": {
    "command": "npx",
    "args": ["-y", "vantage-peers-mcp"],
    "env": { "CONVEX_URL": "..." }
  }
}
```

**Observed configuration files:**
- `/root/coding/vantage-peers-example/.claude/settings.json` — `npx -y vantage-peers-mcp` (no version pin)
- `/root/coding/vantage-peers-example/agent-a/.claude/settings.json` — same
- `/root/coding/vantage-peers-example/agent-b/.claude/settings.json` — same

**No version pin detected** in any Sigma-vps workspace settings. The `-y` flag tells npx to auto-install without prompting.

### npx module cache location

`npx` caches downloaded packages under the user's npm cache. On Sigma-vps:

```
/home/elpi/.npm/_npx/faaed45cc6c3338f/node_modules/vantage-peers-mcp/
```

**Pinned version in cache:** `2.4.0`
**Cache hash:** `faaed45cc6c3338f` (stable directory — npx reuses this until evicted)
**Latest published:** `2.4.8` (as of 2026-06-01, mcp-server/package.json)

**This is the gap**: npx computed a cache key of `faaed45cc6c3338f` when it first resolved `vantage-peers-mcp` without a version pin. It has been serving `2.4.0` from cache ever since, silently bypassing the `2.4.1` through `2.4.8` releases. The `npx -y` flag does not force re-resolution on every invocation — it reuses the cached resolution.

### Claude Code process model (observed)

Three Claude Code processes running simultaneously on Sigma-vps (from `ps aux`):
```
/home/elpi/.local/share/code-server/extensions/anthropic.claude-code-2.1.158-linux-x64/...
/home/elpi/.local/share/code-server/extensions/anthropic.claude-code-2.1.159-linux-x64/...  (x2)
```

Claude Code spawns the MCP server as a subprocess when a session starts. The subprocess inherits the cache path. **A running session does not pick up a new npm release** — the subprocess stays alive for the session duration. Even a "restart MCP" within a session may reuse the cached binary rather than re-resolving from registry.

---

## 2. Pi-chromebook: MCP Module Loading Mechanism

Based on Pi VP message `jn7fen8ns1askdj3s8bpk1tx8h87tcpe` Day 88 (cited in task brief):

> "Pi-chromebook consume bun direct du local source disk PAS npm"

Pi-chromebook runs `bun` directly against the local source disk — i.e. the MCP server is executed from `/root/coding/vantage-memory/mcp-server/dist/server.js` (or equivalent local path) rather than via `npx vantage-peers-mcp` from the npm registry.

**Pi-chromebook mechanism:**
- Command: `bun /path/to/vantage-memory/mcp-server/dist/server.js` (local disk, post-build)
- No npm registry lookup — no npx cache involvement
- Version in use = whatever is on disk at session start
- After a `npm run build` on the local repo, the next MCP server process start picks up the new binary immediately

---

## 3. Difference: Where Each Looks Up vantage-peers-mcp

| Dimension | Sigma-vps | Pi-chromebook |
|-----------|-----------|---------------|
| Source | npm registry via `npx` | Local disk (`bun` direct) |
| Cache | `~/.npm/_npx/<hash>/node_modules/vantage-peers-mcp/` | None (local dist/) |
| Version locked to | npx cache hash computed at first resolve | Last `npm run build` on local repo |
| Auto-updates | No — cache hash frozen at `2.4.0` | Yes — next build reflects HEAD |
| Gap risk | High — currently 8 minor versions stale | Low — build-and-restart is instant |

---

## 4. Pin/Cache Details

**Sigma-vps cache:**
- Path: `/home/elpi/.npm/_npx/faaed45cc6c3338f/node_modules/vantage-peers-mcp/`
- Version cached: `2.4.0`
- Latest available: `2.4.8`
- Gap: 8 releases missed (v2.4.1 through v2.4.8), including createdBy schema fix-ups, list_diaries/list_memories improvements, and diary hardening

**Pi-chromebook cache:** N/A — bun loads from local build

---

## 5. Root Cause of Day 88 Diagnostic Friction

The trilogy `v2.4.4 → v2.4.5 → v2.4.6` (PRs #565-#568) required 3 cycles to close a `filterCreatedBy()` gap. On Sigma-vps, these fixes were published to npm but never loaded by the running MCP server because npx continued serving the `2.4.0` cache. Sigma outbox messages sent via `send_message` during those sessions used the stale tool definitions from `2.4.0`.

---

## 6. Recommended Fix Path

**Path A: Bump pin in all workspace settings.json files to an explicit version**

Add a version pin in every workspace settings.json that uses `vantage-peers-mcp`:

```json
{
  "vantage-peers": {
    "command": "npx",
    "args": ["-y", "vantage-peers-mcp@2.4.8"],
    "env": { "CONVEX_URL": "..." }
  }
}
```

This forces npx to re-resolve when the pin changes. On each minor release, update the pin.

**Path B: Document manual reconnect step**

Document that after each `npm publish` of `vantage-peers-mcp`, Sigma-vps sessions must:
1. Kill the cached npx process: `rm -rf /home/elpi/.npm/_npx/faaed45cc6c3338f`
2. Or use `npx --ignore-existing vantage-peers-mcp` (forces registry re-check)
3. Restart Claude Code session

**Path C: Ship a hook that detects module version mismatch and alerts**

Add a session-start hook that queries the running MCP server's version (via a `get_version` tool or health endpoint) and compares against the latest npm version. Alerts if stale.

---

## 7. Recommendation

**Path A is the right call for Sigma-vps.** Pinned versions are deterministic, auditable, and require one-line updates. The vantage-peers-plugin template already uses `npx -y vantage-peers-mcp` without a pin — that template should also be updated.

Path B is a manual fallback useful to document but not sufficient as a permanent fix (human memory fails).

Path C is a good long-term addition but requires shipping infrastructure before it helps.

**Immediate action (not implemented here — Pi/Sigma decide):**
1. Update `/root/coding/vantage-peers-example/.claude/settings.json` and sub-agent variants to pin `vantage-peers-mcp@2.4.8`
2. Update plugin template `templates/CLAUDE.md.append` to pin the current release
3. Clear the stale cache: `rm -rf /home/elpi/.npm/_npx/faaed45cc6c3338f`
4. Add to release checklist: "bump version pin in vantage-peers-example settings.json"

---

## 8. Friction Observed

Day 88 trilogy v2.4.4-v2.4.6 took 3 diagnostic cycles because the Sigma-vps MCP server was serving `2.4.0` from npx cache while the repo was at `2.4.6`. The version visible in `mcp-server/package.json` and the version actually executing in the Claude Code subprocess were different. This investigation captures the exact mechanism so future diagnostics are 1-cycle: check `~/.npm/_npx/*/node_modules/vantage-peers-mcp/package.json` version against `mcp-server/package.json`.
