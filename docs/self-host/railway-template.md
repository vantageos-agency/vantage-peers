# VantagePeers — Railway Template Page (Self-host)

**Product:** VantagePeers **Self-host**. This is not VantagePeers Cloud
(the multi-tenant hosted product). The Railway one-click template
(https://railway.com/deploy/vantagepeers-mcp) is the storefront for the
self-host product: a deployer runs their own Railway service and their own
Convex project.

This file is the single source of truth for the Railway page's text. When
this doc changes, the template owner copies the updated text into the
Railway dashboard (see "How this page is updated" at the end).

**Derived from:** `origin/main` at `72a97e11873e2030be6d13c53709e5760b625f05`
(measured with `git rev-parse origin/main` on 2026-11-03). Every value
below was re-run against that tree on 2026-11-03; the command is next to the
value. Line numbers refer to that tree. Where a value could not be derived
it says UNKNOWN and why.

---

## Section A — Page text

### Headline facts (all derived, command shown)

| Fact | Value | Source |
|---|---|---|
| Package version | `5.0.0` | `grep '"version"' mcp-server/package.json` -> `"version": "5.0.0"` |
| npm published version | `4.0.0` (dist-tag `latest`, the only tag) | `npm view vantage-peers-mcp dist-tags` -> `{ latest: '4.0.0' }` (run 2026-11-03) |
| Tools **registered** by the server | `116` | `node scripts/check-tool-counts.mjs` -> `tools.ts canonical surface = 116`, `registered names 116 vs documented names 116` |
| Tools **advertised** to MCP clients (`tools/list`) | `90` | `jq '.core\|length' mcp-server/tool-exposure.json` -> `90`; `mcp-server/README.md` line 177: "90 tools are advertised to clients" |
| Registered, not advertised | `26` | `mcp-server/README.md` heading `### Registered, not advertised (26)`; 116 - 90 = 26 |
| Node engine | `26.12.1` | `grep -A1 '"engines"' mcp-server/package.json` -> `"node": "26.12.1"` |
| Backend contract version required | `17` | `grep REQUIRED_CONTRACT_VERSION mcp-server/src/backendContract.ts` -> `= 17`; `grep BACKEND_CONTRACT_VERSION convex/lib/backendManifest.ts` -> `= 17` |
| Backend functions the server calls | `144` | count of `"module:function"` entries in `MCP_CALLED_FUNCTIONS` (`mcp-server/src/backendContract.ts:46`) |

A deployer's MCP client sees 90 tools, not 116. The server masks non-`core`
tools out of `tools/list` via a data file (`mcp-server/tool-exposure.json`,
key `"core"`, still an array of names) — masking, not deletion: the other 26
tools stay registered but a client can neither list nor call them
(`mcp-server/CHANGELOG.md` 2.18.0 entry; loader at `mcp-server/src/tools.ts`
around line 1870-1925, reads `tool-exposure.json`, overridable by
`VP_TOOL_EXPOSURE_PATH` for tests).

Not the same as the published release: the numbers 116 / 90 / contract 17 /
144 are the tree on `origin/main`. `mcp-server/README.md` for the 4.0.0
release text says contract version **10** and **141** functions
(`grep -n 'contract version\|141' mcp-server/README.md`), and the npm
package is `4.0.0`. Whether the `4.0.0` tarball on npm carries 116 or an
earlier count of tools is UNKNOWN (the tarball was not unpacked); a deployer
following the template's Source (`main`, see B1) gets the tree numbers.

Live page, as read via WebFetch on 2026-11-03 (a model summary of the page,
not a browser capture): version "VantagePeers v2.2.0 (2026-05-08)", "82 MCP
tools across 14 categories", setup step "set `CONVEX_URL`,
`AI_GATEWAY_API_KEY`, `BEARER_SECRET_MASTER` in Variables tab", health
example `{"status":"ok","version":"2.2.0"}`. All four are stale; see
Section B3. The live page may have changed since; re-read before editing.

### Categories

Source: the advertised-tool headings in `mcp-server/README.md`
(`grep -n '^### ' mcp-server/README.md`, lines 179-310). The README groups
the 90 advertised tools into 13 headings (these replace the 22-heading
registered-count list the page carried before):

Memory and search (9), Fix patterns (7), Missions and templates (9),
Recurring tasks (7), Tasks (16), Messages (8), Briefing notes (5),
Episodes (5), Diary (3), Billing (1), Profiles and peers (4), Knowledge
bundles (OKF) (2), Other (14). Sum = 90.

The page should say "13 categories, 90 tools", not repeat a registered
count. The 26 masked tools are listed only as names under `### Registered,
not advertised (26)`.

### Environment variables (Railway "Variables" tab)

Source: every `process.env.*` read in `mcp-server/server-http.ts` and
`mcp-server/src/` (`grep -n 'process\.env\.' mcp-server/server-http.ts
mcp-server/src/*.ts`). The file Railway runs is `dist/server-http.js`:
`mcp-server/package.json` `"start": "bun run dist/server-http.js"`
(line 30). `"main"` is `./dist/server.js`, the **stdio** server, not the HTTP
one (this corrects the earlier page, which said `main` also resolves to
`server-http.js`). `/health` reports `runtime: "bun"` on Railway
(`server-http.ts:1497-1541`).

Required for the HTTP server to serve a request:

| Variable | Needed? | What happens if missing | Source |
|---|---|---|---|
| `CONVEX_URL_INTERNAL` | **Yes** | `buildInternalClient()` throws `CONVEX_URL_INTERNAL is required for HTTP transport. Set it to your internal VantagePeers Convex deployment URL.`; boot calls `internalClient()` first (`server-http.ts:2328`) | `mcp-server/src/auth.ts:294-300` |
| `CLERK_SECRET_KEY` | **Yes, for any Convex call** | Every Convex call through the server's internal client is refused: `no service-account identity available (CLERK_SECRET_KEY / CLERK_SERVICE_ACCOUNT_USER_ID not configured) — refusing to send an unauthenticated Convex <method>()` | `mcp-server/src/serviceAccountAuth.ts:77-84`, `mcp-server/src/authenticatedConvexClient.ts:231-232` |
| `CLERK_SERVICE_ACCOUNT_USER_ID` | **Yes, for any Convex call** | Same refusal as above. Clerk user ID of a dedicated service-account user | `serviceAccountAuth.ts:77-84` |
| `BEARER_SECRET_MASTER` | Functionally required | No boot-time throw. The master-bearer layer and `/admin/*` refuse: `Server misconfigured: BEARER_SECRET_MASTER not set` (500 `server_misconfigured` on `POST /admin/organizations`) | `mcp-server/src/auth.ts:1466,1745-1749`; `server-http.ts:1647-1649` |
| `PUBLIC_BASE_URL` | Required when the `Host` header can be absent, and always for `/authorize` | `resolveIssuer()` throws `Server misconfigured: cannot determine public base URL (no Host header and PUBLIC_BASE_URL env var unset). Self-host deploys MUST set PUBLIC_BASE_URL.`; `/authorize` answers 503 | `server-http.ts:110-111,134-151`; `mcp-server/src/authorize.ts:90-91` |
| `PORT` | No — defaults to `3000` | n/a | `server-http.ts:2317` |
| `NODE_ENV` | No | Header comment names it ("set to production on Railway"); no `process.env.NODE_ENV` read in `server-http.ts` or `mcp-server/src/` | `server-http.ts:33` (comment only); `grep -n 'NODE_ENV' mcp-server/server-http.ts mcp-server/src/*.ts` |

Required only for person sign-in (`/authorize`, `/authorize/callback`,
`/authorize/org`). If any is missing, every one of these routes answers
503 `temporarily_unavailable` and logs the missing names, never an
auto-approve (`server-http.ts:668-690`):

| Variable | Rule | Source |
|---|---|---|
| `AUTHORIZE_STATE_SECRET` | at least 32 characters | `mcp-server/src/authorize.ts:82-83` |
| `CLERK_DOMAIN` | a URL with an origin | `authorize.ts:84-85` |
| `AUTHORIZE_SIGN_IN_URL` | a URL with an origin | `authorize.ts:86-87` |
| `AUTHORIZE_CALLBACK_URL` | a URL with an origin | `authorize.ts:88-89` |
| `PUBLIC_BASE_URL` | a URL with an origin | `authorize.ts:90-91` |
| `CLERK_SECRET_KEY` | non-empty | `authorize.ts:92-96` |
| `AUTHORIZE_AUTHORIZED_PARTIES` | optional, comma-separated extra origins | `authorize.ts:106-110` |

Optional:

| Variable | Default | Source |
|---|---|---|
| `CLERK_DOMAIN` | `https://sharp-sponge-67.clerk.accounts.dev` (a VantageOS-owned dev Clerk instance; a deployer using their own Clerk MUST override it) | `mcp-server/src/auth.ts:1133-1134`; `serviceAccountAuth.ts:82` |
| `CLERK_JWT_AUDIENCE` | `"convex"` | `auth.ts:1145` |
| `CLERK_JWT_TEMPLATE` | `"convex"` (Clerk JWT template the service account mints from) | `serviceAccountAuth.ts:83` |
| `CLERK_PUBLISHABLE_KEY` | `""`; read by `/authorize/callback` for Clerk's handshake | `server-http.ts:812,922` |
| `VANTAGE_ACTOR_CREDENTIAL_MODE` | unset = `strict` (a typed agent name without an agent credential is refused `AGENT_CREDENTIAL_REQUIRED`); `permissive` restores the old behaviour | `auth.ts:454,489-497` |
| `VP_EMIT_UI_MARKERS` | off; `1` or `true` appends UI result markers | `mcp-server/src/tools.ts:95-96` |
| `STATE_TOKENS_DEFAULT_REPO`, `GITHUB_TOKEN` | read by tool code for `{{pr:...}}`-style tokens | `tools.ts:3608,3644-3645` |
| `RAILWAY_GIT_COMMIT_SHA` | set by Railway; shown in `/health` | `server-http.ts:1509` |

Not for Railway: `VP_TOOL_EXPOSURE_PATH` and `VP_TEST_MODE` are test-only
(`tools.ts:1881`, `server-http.ts:2322`).

**`mcp-server/railway.json` does not declare a `variables` block**
(`cat mcp-server/railway.json` -> only `deploy`: `restartPolicyType`
`ON_FAILURE`, `restartPolicyMaxRetries` 5, `healthcheckPath` `/health`,
`healthcheckTimeout` 30). The template's variable prompts are configured in
the Railway dashboard, outside this repo, and cannot be read from here:
UNKNOWN which variables the live template prompts for today. The earlier
version of this page recorded "`CONVEX_URL_INTERNAL` and
`BEARER_SECRET_MASTER` only" as of 2026-09-21 (taken from a brief, not read
from the dashboard).

**Inconsistencies on the live page (as read via WebFetch 2026-11-03):**
- The setup text says to set `CONVEX_URL` and `AI_GATEWAY_API_KEY` in
  Railway. Both are wrong for the HTTP/Railway server:
  - `CONVEX_URL` (no `_INTERNAL`) is read only by the **stdio** server
    (`mcp-server/server.ts:55-56`, `npx vantage-peers-mcp`). The Railway
    server reads `CONVEX_URL_INTERNAL` (`auth.ts:295`).
  - `AI_GATEWAY_API_KEY` is a Convex-side variable. `grep -rn
    AI_GATEWAY_API_KEY mcp-server --include=*.ts` (excluding
    `node_modules`) returns no match; the root `CLAUDE.md` lists it as set
    in the Convex dashboard.
- `PUBLIC_BASE_URL` is missing from the page, yet the code requires it
  (rows above). The Railway literal-prefix caveat is in
  `decisions/railway-template-overview-2026-05-08.md` line 35: Railway
  interpolates `${{ RAILWAY_PUBLIC_DOMAIN }}` to a bare host, so the
  `https://` prefix is required.
- The service-account pair (`CLERK_SECRET_KEY`,
  `CLERK_SERVICE_ACCOUNT_USER_ID`) is on no page text found in this repo
  or on the live page. Whether a self-host deployer can start the HTTP
  server without them is UNKNOWN: the code refuses every Convex call
  without them (rows above), and the boot check makes a Convex call, but
  boot was not run here.

**Variables tab to document, in order:**
```
NODE_ENV=production
CONVEX_URL_INTERNAL=<your Convex deployment URL>
BEARER_SECRET_MASTER=<a secret you choose>
PUBLIC_BASE_URL=https://${{ RAILWAY_PUBLIC_DOMAIN }}
CLERK_SECRET_KEY=<Clerk Backend API secret key>
CLERK_SERVICE_ACCOUNT_USER_ID=<Clerk user ID of a dedicated service-account user>
CLERK_DOMAIN=<your Clerk Frontend API domain>
# Only for person sign-in (/authorize):
AUTHORIZE_STATE_SECRET=<32+ characters>
AUTHORIZE_SIGN_IN_URL=<sign-in page URL>
AUTHORIZE_CALLBACK_URL=<https://your-domain/authorize/callback>
CLERK_PUBLISHABLE_KEY=<Clerk publishable key>
```
Whether `BEARER_SECRET_MASTER` must also be set in Convex is UNKNOWN: the
earlier page said so with no source, and `grep -rn BEARER_SECRET_MASTER
convex --include=*.ts` was not run for this pass.

### Health check

Source: `mcp-server/server-http.ts:1497-1541`, `GET /health`, unauthenticated.

Response shape, quoted from the handler (field names; values as the code
computes them):
```json
{
  "status": "ok",
  "service": "vantage-peers-mcp-http",
  "version": "5.0.0",
  "commit": "<RAILWAY_GIT_COMMIT_SHA or \"unknown\">",
  "runtime": "bun",
  "bun": "<Bun version or null>",
  "node": "<process.version>",
  "transport": "streamable-http",
  "oauth": "supported",
  "scopes": ["mcp:full"],
  "authorize": { "handshake": "<handshakeHealth(process.env)>" },
  "actor_credential": { "mode": "strict|permissive", "source": "configured|unset|empty|coerced" },
  "unattributed_claims": { "strict_would_refuse": 0, "since": "<ISO time>", "window_seconds": 0 }
}
```
`runtime` is `"bun"` when `process.versions.bun` is set, else `"node"`.
`version` is `pkg.version` read from `package.json` at import time.
`commit` falls back to the literal `"unknown"`. The value shape of
`authorize.handshake` is defined in `mcp-server/src/authorize.ts:504`
(`handshakeHealth`) and was not quoted here. The example values for
`version` and the counters are what the code would emit for this tree, not
a captured response: no live `/health` was fetched in this pass.

The live page's example (`{"status":"ok","version":"2.2.0"}`) omits all
fields after `status`/`version`; replace it with the shape above.

---

## Section B — Update path for existing deployers

### B1. Is the template GitHub-repo based or image based?

**Not provable from this repo; UNKNOWN until read in the Railway dashboard.**

- `mcp-server/railway.json` has only a `deploy` block, no build/source
  block (`cat mcp-server/railway.json`).
- No Dockerfile or nixpacks file exists in the tree: `find . -path
  ./node_modules -prune -o \( -iname 'Dockerfile*' -o -iname '*nixpacks*'
  -o -iname 'railway.toml' \) -print` returned nothing (it returned only
  `./mcp-server/railway.json` for `railway.json`). Consistent with, not
  proof of, a repo-based template with Railway's auto-detected build.
- `decisions/railway-template-overview-2026-05-08.md` line 27 states
  "Automatic redeploy on push to `vantageos-agency/vantage-peers` (or your
  fork)".
- https://docs.railway.com/templates/updates, as read via WebFetch on
  2026-11-03 (model summary): repo-based templates can receive update
  notifications; image-based templates cannot be updated through that
  mechanism.
- **UNKNOWN:** which repo and branch the live template's Source points to,
  and whether it tracks `main`. Check: Railway dashboard -> the template's
  Service -> Settings -> Source.

Working assumption, stated as an assumption: GitHub-repo-based, tracking
`main`, opt-in updates per deployer.

### B2. What does an update cover?

**The MCP server only.** A Railway template update redeploys
`mcp-server/dist/server-http.js`; it does not touch the deployer's own
Convex project. The deployer deploys Convex themselves.

**Order — this reverses the earlier page.** The earlier version said
"Railway template update first, Convex second". The current rule says
Convex first, MCP last (`.claude/rules/railway-mcp-redeploy.md` rule 2:
"Convex first, MCP last ... Never MCP-first, never both-at-once"), and
`mcp-server/README.md` "Backend compatibility check" says: "deploy the
backend of the same release first, then upgrade this package". The reason
is the boot check:

- Before it binds a port, the server calls `meta:backendContract` and exits
  1 if the manifest is missing, the contract version is below
  `REQUIRED_CONTRACT_VERSION` (17 in the tree), or any of the 144 functions
  in `MCP_CALLED_FUNCTIONS` is missing (`server-http.ts:2328`,
  `mcp-server/src/backendContract.ts:43,46`). Railway's healthcheck then
  fails the new deployment and the previous one keeps serving.
- The check sees a missing function, not a changed argument; a changed
  argument is covered by bumping the contract version.

**Order to apply:**
1. Deploy the matching Convex backend from the repo root (see the Convex
   deploy commands in `docs/self-host/recall-empty-troubleshooting.md`
   lines 73-76: `npx convex deploy --yes`, `npx convex deploy --yes
   --prod`). The deployer's own prod-deploy procedure is not scripted
   further in this repo.
2. Read back a function that changed, not just the deploy exit code.
3. Only then let the Railway update land, and verify with `curl
   <your-domain>/health` (`version`, `commit`) and a live tool call.

A backend that predates the manifest door is itself refused ("backend has
no contract manifest", `mcp-server/CHANGELOG.md` 4.0.0 Breaking, Self-host).

### B3. Breaking changes between 2.2.0 and 4.0.0

Source: `mcp-server/CHANGELOG.md` (`grep -n '^## ' mcp-server/CHANGELOG.md`).
Only `v1.0.1, v2.1.0, v2.3.1, v2.5.0` exist as tags besides `archive/*` and
a backup tag (`git tag --list | grep -v '^archive'`), so this is derived
from changelog entries, not a tag diff. The published page says 2.2.0.

Self-host-relevant, newest first:

1. **4.0.0 (2026-11-01)**
   - The server refuses to start against a backend with no contract
     manifest, contract version below the required one, or missing any
     function it calls (log line `BACKEND INCOMPATIBLE (<reason>)`).
   - `engines.node` pinned to `26.12.1` (was `>=20`).
   - MCP server SDK 2.x: protocol errors lose the `MCP error <code>:`
     prefix, `tools/list` stamps the 2020-12 JSON Schema dialect,
     `execution.taskSupport` is no longer published.
   - `list_peers`, `list_tasks_by_mission`, `list_recurring_tasks` answer
     `{ items, nextCursor?, scopeFiltered }` instead of a bare array when
     scope removed rows.
   - `send_message` refuses an `evidence:` line that states a live state
     with no command on the same line.
   - Agent identity `strict` by default
     (`VANTAGE_ACTOR_CREDENTIAL_MODE`), `/authorize` requires person
     sign-in and consent, a write with no active organisation mapping is
     refused. The changelog tags these items "Cloud"; whether they reach a
     Self-host HTTP deployment is UNKNOWN (the env reads above are in the
     shared `server-http.ts`, so the code is present).
2. **3.0.0 (2026-10-01)**
   - The `components` registry (six tools) is removed.
   - Tokens from the retired dynamic-registration token store and legacy
     internal tenant bearers are refused with HTTP 401.
   - `fail_task` third terminal state; `update_task` cannot set `failed`
     or `blocked`; use `fail_task` / `block_task`.
   - `CLERK_JWT_AUDIENCE` (default `convex`) is checked on Clerk tokens.
   - The server no longer passes a privileged secret to the backend as a
     function argument.
3. **2.18.0 (2026-08-11)**: only the core tool set is advertised
   (`tool-exposure.json`); the server refuses to start if that file names
   a tool that does not exist.
4. **2.17.0 (2026-08-11)**: 14 duplicate alias tools removed. The earlier
   page's counts for this release (123 -> 109) and for 2.18.0 (66
   advertised) do not appear in the current changelog: UNKNOWN.
5. **2.12.0-2.17.0**: `check_messages` returns a bounded page (`limit`
   default 20, 2.12.0); several reads return only rows the caller owns or is
   a party to; operations tools (error logs, issue tracking, repository
   mappings) are service-operator only; cross-organisation namespace access
   refused; Clerk tokens with an organisation claim are scoped to
   `team/<orgId>`.
6. **2.5.0-2.11.0**: write tools that needed no authorisation are
   restricted to the service operator (2.5.0); agent names are normalised
   and case-insensitive (2.5.0); `text_search`, `recall`, `search_components`
   and `search_fix_patterns` were deprecated aliases (2.8.0, 2.10.0); not
   verified here which of them were removed and when beyond the 2.17.0 note.

Convex schema: whether any `convex/schema.ts` field was renamed or removed
since 2.2.0 is UNKNOWN (no tag to diff from; not run). Convex's own schema
validation on deploy is the safety net, not this list.

### UNKNOWNs (explicit)

- Repo and branch of the live template's Source (B1) — dashboard only.
- The variables the live template prompts for today — dashboard only.
- Whether the HTTP server boots without the Clerk service-account pair.
- Whether `BEARER_SECRET_MASTER` must be mirrored in Convex.
- Value shape of `/health` `authorize.handshake`, and any captured live
  `/health` response.
- Tool counts inside the published `vantage-peers-mcp@4.0.0` tarball
  versus this tree.
- Registered/advertised counts at 2.17.0 and 2.18.0 (see B3.4).
- Any `convex/schema.ts` rename or removal since 2.2.0.
- Which "Cloud" 4.0.0 behaviours apply to a Self-host deployment.

---

## How this page is updated

After this doc is merged to `main`, the template owner (whoever holds
Railway dashboard access for the `vantagepeers-mcp` template) copies the text
in Section A into the Railway template's page editor and applies the
variable-prompt corrections to the template's Variables configuration. The
live page is then **read back** (fetched) and compared against this doc —
not assumed to match because the edit was made.

---

*Self-host doc — do not merge Cloud-product content into this file (see
this repo's `CLAUDE.md`, "2 PRODUITS DISTINCTS, NE JAMAIS MÉLANGER").*
