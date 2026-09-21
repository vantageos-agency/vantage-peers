# VantagePeers — Railway Template Page (Self-host)

**Product:** VantagePeers **Self-host**. This is not VantagePeers Cloud
(the multi-tenant, Clerk/MCP-multi-client hosted product). The Railway
one-click template (https://railway.com/deploy/vantagepeers-mcp) is the
storefront for the self-host product: a deployer runs their own Railway
service and their own Convex project.

This file is the single source of truth for the Railway page's text. When
this doc changes, the template owner copies the updated text into the
Railway dashboard (see "How this page is updated" at the end).

---

## Section A — Page text

### Headline facts (all derived, command shown)

| Fact | Value | Source |
|---|---|---|
| Package version | `2.19.0` | `mcp-server/package.json` `"version"` field (`grep version mcp-server/package.json`) |
| npm published version | `2.19.0` (dist-tag `latest`) | `npm view vantage-peers-mcp dist-tags` → `{ latest: '2.19.0' }` |
| Tools **registered** by the server | `108` | `node scripts/check-tool-counts.mjs` → `tools.ts canonical surface = 108` |
| Tools **advertised** to MCP clients (`tools/list`) | `70` | `jq '.core|length' mcp-server/tool-exposure.json` → `70` |

**A deployer's MCP client sees 70 tools, not 108.** Since v2.18.0 the
server masks non-`CORE` tools out of `tools/list` via a data file
(`mcp-server/tool-exposure.json`, key `"core"`) — masking, not deletion:
the other 38 tools stay registered and handler-wired but are not listed
to clients (`mcp-server/CHANGELOG.md` 2.18.0 entry; confirmed live by
`registerTools()` at `mcp-server/src/tools.ts:1661-1717`, which loads
`tool-exposure.json` and hides everything not in `core`).

The live page currently says "82 tools" and "VantagePeers v2.2.0
(2026-05-08)" — both are stale against the current release; see Section B3.

### Categories

Source: `### <Name> (<count>)` headings in `mcp-server/README.md`
(`grep -n '^### ' mcp-server/README.md`). 22 headings, matching
`check-tool-counts.mjs`'s "registered names 108 vs documented names 108 —
OK" self-consistency check:

Memory (8), Episodes (3), Profiles (3), Tasks (18), Missions (6), Mission
Templates (3), Messages (8), Diary (4), Briefing Notes (5), Search / RAG
(6), Issues (6), Fix Patterns (6), Error Monitoring (2), Deployments &
Repos (6), Business Units (5), Mandates (7), Recurring Tasks (7), OKF
Bundles (3), Identity (1), Session (1), Billing (1), Observability (1).

Note: `tool-exposure.json`'s 70 advertised tools are a subset scattered
across these 22 categories — the page's category list should keep saying
"up to N tools per category," not repeat the README's registered-count
badge, because a deployer's client will see fewer than the README number
in several categories.

### Environment variables (Railway "Variables" tab)

Source: `mcp-server/server-http.ts` lines 25-31 (module header comment,
the file Railway actually runs — `main`/`start` resolves to
`dist/server-http.js`, built from `server-http.ts`) cross-checked against
every `process.env.*` read in `mcp-server/src/auth.ts` and
`mcp-server/server-http.ts`.

| Variable | Required at boot? | What happens if missing | Source |
|---|---|---|---|
| `CONVEX_URL_INTERNAL` | **Yes** | `internalClient()` throws `"CONVEX_URL_INTERNAL is required for HTTP transport."` on first Convex call (auth resolution for every request) | `mcp-server/src/auth.ts:159-162` |
| `BEARER_SECRET_MASTER` | Functionally required (no boot-time throw, but every OAuth mint/refresh path and the master-bearer layer refuse without it) | `[oauth] BEARER_SECRET_MASTER not set` logged, request refused | `mcp-server/server-http.ts:557-560,748-751,879-882` |
| `PUBLIC_BASE_URL` | Conditionally required | Falls back to deriving the issuer from the request's `Host` header; if the deploy sits behind a proxy that strips `Host`, or for a `curl` smoke test without a `Host` header, `resolveIssuer()` throws `"Server misconfigured: ... Self-host deploys MUST set PUBLIC_BASE_URL."` | `mcp-server/server-http.ts:102-119` |
| `PORT` | No — defaults to `3000` | n/a | `mcp-server/server-http.ts:1644` |
| `NODE_ENV` | No | Set to `production` on Railway by convention | header comment only, no runtime branch found in `server-http.ts` for this var beyond what dependencies read |
| `CLERK_DOMAIN` | No — optional, only affects layer 2.5 (Clerk JWT) | Defaults to `https://sharp-sponge-67.clerk.accounts.dev` (a VantageOS-owned dev Clerk instance — self-host deployers who want Clerk MUST override this) | `mcp-server/src/auth.ts:425-427` |
| `CLERK_JWT_AUDIENCE` | No — optional | Defaults to `"convex"` | `mcp-server/src/auth.ts:437` |

**`mcp-server/railway.json` does not declare a `variables`/`environments`
block** (`cat mcp-server/railway.json` — only a `deploy` key:
`restartPolicyType`, `restartPolicyMaxRetries`, `healthcheckPath`,
`healthcheckTimeout`). The template's variable prompts (what a deployer
sees in the Railway dashboard at deploy time) are therefore configured
**outside this repo**, in the Railway template's own dashboard
configuration — not derivable from the repo. Per the brief's own
KNOWN FACTS, that dashboard config currently prompts for
`CONVEX_URL_INTERNAL` and `BEARER_SECRET_MASTER` only.

**Inconsistency found, to fix on the live page:**
- The live page's setup text says to set `CONVEX_URL` and
  `AI_GATEWAY_API_KEY` in Railway. Both are wrong for the HTTP/Railway
  transport:
  - `CONVEX_URL` (no `_INTERNAL` suffix) is read only by the **stdio**
    server (`mcp-server/server.ts:47-72`, used for `npx vantage-peers-mcp`
    local/Claude Code installs) — the Railway/HTTP server reads
    `CONVEX_URL_INTERNAL` instead (`mcp-server/src/auth.ts:159`). These are
    two different variables for two different transports.
  - `AI_GATEWAY_API_KEY` is a **Convex-side** variable (set in the Convex
    dashboard, consumed by `convex/lib/aiClient.ts` for embeddings), never
    a Railway variable. Confirmed: no reference to `AI_GATEWAY_API_KEY`
    anywhere under `mcp-server/` (`grep -rn AI_GATEWAY_API_KEY` matches
    only `convex/`).
- `PUBLIC_BASE_URL` is **missing entirely** from the live page's variable
  list, but the code requires it as a fallback whenever the `Host` header
  is absent, and the code comment states self-host deploys MUST set it
  (`mcp-server/server-http.ts:117`). It should be added, with the
  Railway-specific literal-`https://` prefix caveat already captured in
  `decisions/railway-template-overview-2026-05-08.md`
  ("`PUBLIC_BASE_URL=https://${{ RAILWAY_PUBLIC_DOMAIN }}`" — the
  `https://` prefix is required because Railway interpolates
  `RAILWAY_PUBLIC_DOMAIN` to a bare host).

**Corrected Railway "Variables" tab, in order:**
```
NODE_ENV=production
CONVEX_URL_INTERNAL=<your Convex deployment URL>
BEARER_SECRET_MASTER=<a secret you choose — set the same value in Convex>
PUBLIC_BASE_URL=https://${{ RAILWAY_PUBLIC_DOMAIN }}
# Optional (Clerk-scoped OAuth):
CLERK_DOMAIN=<your Clerk instance domain>
```

`AI_GATEWAY_API_KEY` (or `OPENAI_API_KEY`) and a second copy of
`BEARER_SECRET_MASTER` go in the **Convex** dashboard, not Railway — see
Section B2.

### Health check

Source: `mcp-server/server-http.ts:921-942`, `GET /health`, unauthenticated.

Actual response shape (quoted from the handler, not invented):
```json
{
  "status": "ok",
  "service": "vantage-peers-mcp-http",
  "version": "2.19.0",
  "commit": "<RAILWAY_GIT_COMMIT_SHA or \"unknown\">",
  "transport": "streamable-http",
  "oauth": "supported",
  "scopes": ["mcp:full"]
}
```
`version` is read from `package.json` at import time (`pkg.version`, lines
54-65). `commit` is `process.env.RAILWAY_GIT_COMMIT_SHA` set by Railway's
build system, falling back to the literal string `"unknown"` — added
after a Railway silent-failure incident where `/health` could not
say which commit was actually serving traffic
(`mcp-server/server-http.ts:930-936`).

The live page's example (`{"status":"ok","version":"2.2.0"}`) omits
`service`, `commit`, `transport`, `oauth`, and `scopes`, and shows a stale
version. It should be replaced with the full shape above.

---

## Section B — Update path for existing deployers

### B1. Is the template GitHub-repo based or image based?

**Cannot be fully confirmed from this repo — partially derivable, rest is
UNKNOWN and must be checked in the Railway dashboard.**

- `mcp-server/railway.json` contains only a `deploy` block (restart
  policy, healthcheck path/timeout) — no `build`/`source` block naming a
  repo, branch, or image (`cat mcp-server/railway.json`).
- No `Dockerfile` or `nixpacks.toml`/`nixpacks.json` exists anywhere in
  the repo (`find . -iname "Dockerfile*" -o -iname "*nixpacks*"` —
  empty), so the build is Railway's own auto-detected Node build
  (Nixpacks default), not a custom image — this is consistent with (but
  does not prove) a GitHub-repo-based template, since an image-based
  template would need a pre-built image reference somewhere, which is
  absent.
- The `decisions/railway-template-overview-2026-05-08.md` archive of the
  original page text states: "Automatic redeploy on push to
  `vantageos-agency/vantage-peers` (or your fork)" — this describes
  GitHub-repo-based behavior (per
  https://docs.railway.com/templates/updates: repo-based templates notify
  deployers when the root branch changes, and updates are opt-in;
  image-based templates get no update mechanism at all).
- **UNKNOWN, must be checked in the Railway dashboard:** which exact repo
  + branch the *live* template's Source is pointed at (could be
  `vantageos-agency/vantage-peers` main, a pinned tag, or a fork), and
  whether Railway's template registry entry (separate from the repo) has
  drifted from the repo's own `railway.json`. Check: Railway dashboard →
  the template's Service → Settings → Source.

**Working assumption for Section A/B text, stated as an assumption, not a
fact:** GitHub-repo-based, tracking `main`, opt-in updates per deployer —
consistent with all repo evidence above, but not directly readable from
this repo alone.

### B2. What does an update cover?

**The MCP server only.** Applying a Railway template update (or manually
redeploying from a newer commit) rebuilds and redeploys
`mcp-server/dist/server-http.js` — it does **not** touch the deployer's
own Convex project. The deployer owns a separate Convex deployment
(`docs/getting-started`/self-host convention: `npx convex dev` for local,
a named prod deployment for Railway) and must apply Convex-side changes
themselves.

**Required separate step:** from the repo root (not `mcp-server/`),
```
npx convex deploy --prod
```
(or the deployer's pinned prod deployment key, per their own Convex
project setup — this repo's `README.md` "Development" section documents
`npx convex dev` for local; the prod-deploy equivalent is the deployer's
own responsibility and is not scripted in this repo).

**Failure mode of a new MCP server talking to an old Convex backend:**
per `.claude/rules/railway-mcp-redeploy.md` (reader-first principle,
after a past production incident): if the MCP server (reader) is ahead of Convex
(provider) — e.g. it expects a field Convex doesn't yet return — the
failure is contained: `check_messages`-class code in this codebase is
written reader-first/tolerant (defaults missing keys, per
`mcp-server/CHANGELOG.md`'s "Unreleased" `actionableStuckCount` entry).
But the inverse — Convex deployed first, MCP server still old and reading
a field Convex no longer returns — is the dangerous order: it produced a
crash for every caller (`undefined ... .length`) in the incident cited
in that rule.

**Order to apply:**
1. Let the Railway template update land first (MCP server / reader).
2. Verify by observing behavior (a `curl .../health` showing the new
   `version`, and/or a live tool call behaving as expected) — not by
   assuming the deploy finished.
3. Only then run `npx convex deploy --prod` against the deployer's own
   Convex project.

This mirrors `.claude/rules/railway-mcp-redeploy.md`'s rule 2
("reader-first order... never Convex-first, never both-at-once for a
breaking change"), written for this project's own hosted deploy but
equally the correct order for a self-host deployer's two independently
deployed pieces.

### B3. Breaking changes between 2.2.0 and 2.19.0

Source: `mcp-server/CHANGELOG.md` (no git tags exist between `v2.1.0` and
`v2.3.1`/`v2.5.0` covering this range — `git tag --list` returns only
`v1.0.1, v2.1.0, v2.3.1, v2.5.0, backup/pre-public-flip-2026-05-08-1148`;
2.2.0 and 2.19.0 are not tagged, so this is derived from CHANGELOG.md
entries and `git log --oneline` on `mcp-server/package.json`, not `git
diff <tag>..<tag>`).

1. **Tool surface shrank, twice, in different directions.**
   - v2.17.0: 14 duplicate alias tools removed outright. Registered count
     123 → 109 (`mcp-server/CHANGELOG.md` 2.17.0 entry).
   - v2.18.0: non-`CORE` tools masked from `tools/list` (not removed) via
     `tool-exposure.json`. Advertised count dropped from 109 registered
     to 66 advertised at the time of that release
     (`mcp-server/CHANGELOG.md` 2.18.0 entry). Current measured state is
     108 registered / 70 advertised (Section A) — the exact numbers moved
     again between 2.18.0 and HEAD via further Unreleased entries (a
     six-tool `components` registry removal: 113→107, per the CHANGELOG's
     current top "Unreleased" entry). **A deployer polling
     `tools/list` after an update may see fewer tools even with no
     capability lost** — this is intentional (masking is reversible via
     `tool-exposure.json`), but is a visible behavior change a deployer
     should expect, not a regression to report.

2. **Auth/scope changes (self-host-relevant if using Clerk):**
   - `team-member` scope profile added: Clerk JWTs carrying an `org_id`
     claim now resolve to `namespaceReadPrefixes`/`namespaceWritePrefixes`
     locked to `team/<orgId>/*` (CHANGELOG "Unreleased — B4 RAG namespace
     team/<orgId> tenant enforcement").
   - New env var `CLERK_DOMAIN` (default
     `https://sharp-sponge-67.clerk.accounts.dev`) — a deployer using
     Clerk on a custom domain must now set this explicitly (same entry).
   - New env var `CLERK_JWT_AUDIENCE` (default `"convex"`) — added to
     close a cross-tenant JWT-replay finding; binds the `audience` claim
     at verification (CHANGELOG top "Unreleased" entry, "Bind the
     `audience` claim...").
   - Two legacy bearer-auth fall-through layers were **removed**: the DCR
     opaque-token layer (`oauthTokens`/`oauthClients`) and the legacy
     internal-bearer layer (`mcpTenants`). A bearer token shaped like
     either is now refused (401) instead of falling through
     (CHANGELOG top "Unreleased — grant-aware mission/mandate visibility"
     entry, "Removed" section). Self-host deployers who provisioned
     tokens via the now-deleted `scripts/seed-mcp-tenant.ts` CLI must
     re-provision via the current OAuth admin endpoints or
     `BEARER_SECRET_MASTER`.

3. **No `convex/schema.ts` table-shape breaking removals were found in the
   CHANGELOG entries reviewed** (the changes above are additive fields /
   new tables / auth-layer removals, not column renames) — but this was
   not verified against a full schema diff between 2.2.0 and HEAD; **flag
   as UNKNOWN whether any `convex/schema.ts` field was renamed or removed
   in this range** without running `git diff` across the actual commit
   range (no tag exists to diff from), which is out of scope for a doc
   pass. A deployer applying `npx convex deploy --prod` will get Convex's
   own schema-validation errors if a breaking schema change exists; that
   is the safety net, not this list.

### UNKNOWNs (explicit)

- The exact repo + branch the live Railway template's Source field points
  to (must check Railway dashboard, not derivable from this repo — B1).
- Whether the Railway template registry's variable-prompt configuration
  (separate system from `mcp-server/railway.json`) currently matches the
  corrected list in Section A, or still prompts for the old
  `CONVEX_URL`/`AI_GATEWAY_API_KEY` pair — must check the Railway
  dashboard template editor.
- Whether any `convex/schema.ts` field was renamed/removed between 2.2.0
  and 2.19.0 (B3, point 3) — not verified by a full diff in this pass.
- Whether `NODE_ENV` drives any runtime branch inside `mcp-server` beyond
  what its dependencies read internally — none found in `server-http.ts`
  itself; not traced through every dependency.

---

## How this page is updated

After this doc is merged to `main`, the template owner (Pi or whoever
holds Railway dashboard access for the `vantagepeers-mcp` template) copies
the text in Section A into the Railway template's page editor and applies
the variable-prompt corrections from Section A to the template's actual
Variables configuration. Once applied, the live page is **read back**
(fetched) and compared against this doc — not assumed to match because the
edit was made.

---

*Self-host doc — do not merge Cloud-product content into this file (see
this repo's `CLAUDE.md`, "2 PRODUITS DISTINCTS, NE JAMAIS MÉLANGER").*
