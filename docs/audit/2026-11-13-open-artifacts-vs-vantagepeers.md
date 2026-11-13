# Audit — VantagePeers vs open-artifacts: artifacts and agent messaging

- **Products:** VantagePeers **Cloud** (multi-tenant) is the target of every recommendation below. VantagePeers **Self-host** inherits the same backend code but its runbook (`docs/getting-started/`) is out of scope here.
- **Task:** k17dj3vva141smerqfnebr4k6s8j4k0x (operator order 2026-11-13). Audit only: no build task is dispatched from this document before Pi reads it.
- **Revisions read:** open-artifacts `f576bc6b35d3dda8b016b1d5f83c1365cf1c7504` (2026-11-13, MIT, `LICENSE` line 1-3); VantagePeers `origin/main` @ `35286a33`.
- **Notation:** `OA:` = path in open-artifacts, `VP:` = path in this repo.

## Summary

1. open-artifacts is a **Cloudflare-Workers-native** product (one Worker, D1, R2, KV, four Durable Objects; `OA: apps/server/wrangler.template.jsonc:2-37`). Its server cannot be ported line for line onto Convex; its **client-side packages and its security design can**.
2. Running it **as-is beside VP** would create a second identity layer (Cloudflare Access / Google / email codes; `OA: apps/server/src/auth/sign-in.ts:17-20`). That is refused by the one-identity-layer rule.
3. **Recommendation: hybrid port.** Reimplement the artifact server on Convex, keyed on VP's existing organisations, agents and Clerk persons; reuse under MIT (attribution kept) the viewer shell, sandbox constants, runtime bridge and limits; serve content from a separate content host through a Convex HTTP action with HMAC-signed, short-lived URLs.
4. **Bus:** adopt the *push-into-a-live-session* adapter idea and the device-flow machine approval; adapt presence; ignore the per-member hub (VP is organisation-scoped). It is a separate, later delivery.

---

## D1 — Feature map (every open-artifacts MCP tool)

open-artifacts exposes **23** MCP tools (`grep -oE 'name: "[a-z_]+"' apps/server/src/mcp/tool-defs.ts | sort -u | wc -l` -> 23), registered in `OA: apps/server/src/mcp/server.ts:139-142`. VP advertises 93 (`node -e 'console.log(require("./tool-exposure.json").core.length)'` in `mcp-server/` -> 93).

| open-artifacts feature / tool | OA source | VP today | VP source | Gap |
|---|---|---|---|---|
| `publish_artifact` (create / new version; `content`, `files`, or 1-64 `edits`; `expectedVersion`) | `OA: apps/server/src/mcp/tools/artifacts.ts:81`, `tool-defs.ts:40` | No artifact object. Closest: KB document upload, re-upload by `docId` marks old chunks `isLatest=false` | `VP: convex/kb.ts:256, 357-367` | **Lacks** — new table + mutation |
| `create_upload` (signed PUT, >128 KB, ≤25 MB, sha256) | `artifacts.ts:98`, `OA: apps/server/src/services/uploads.ts:34-42` | **Has the equivalent**: `generate_upload_url` with sha256 ticket (15 min, single use, hash stored) + `claim_upload` | `VP: convex/kbMutations.ts:488, 502-633`; `VP: mcp-server/src/tools/kbIngest.ts` | Reuse as-is; add a byte cap (none today) |
| `get_artifact` (inline ≤1 MB, else downloadUrl 10 min) | `artifacts.ts:111` | No | — | Lacks |
| `list_artifacts`, `search_artifacts` | `artifacts.ts:148, 161` | Pattern exists (paged lists, BM25 `search_content` index on messages) | `VP: convex/schema.ts:208-256` | Lacks — new index |
| `list_versions`, `restore_version` | `artifacts.ts:182, 207` | Version chain on memories (`relations` type updates, `isLatest`) | `VP: convex/memories.ts:214-224` | Lacks for artifacts; pattern exists |
| `delete_artifact`, `undelete_artifact` (trash 30 d) | `artifacts.ts:286, 299`; `OA: packages/shared/src/limits.ts:66` | Soft delete exists (`soft_delete_document`, `soft_delete_memory`); no undelete | `VP: convex/kb.ts:406` | Partial |
| `share_artifact` / `unshare_artifact` (viewer/editor by email, max 200 shares) | `artifacts.ts:227, 250`; `OA: apps/server/src/services/shares.ts:37` | **None.** Email invitations exist only for org membership or agent binding | `VP: scripts/invite-client-people.mjs`, `VP: convex/personalAgentBind.ts` | **Lacks** — per-object share table |
| `set_visibility` (private / team / public) | `artifacts.ts:263` | None (no public link, no per-object ACL) | — | Lacks |
| Runtime data: `artifact_data_get/list/query/set/update/delete` (doc 256 KB free / 1 MB paid, 50 MB per artifact) | `OA: apps/server/src/mcp/tools/data.ts:81-156`; `limits.ts:6-37` | None | — | Lacks — maps naturally onto a Convex table per artifact collection |
| Runtime capabilities `db` / `viewer` / `storage` (flags on publish, postMessage bridge) | `OA: apps/landing/src/content/docs/runtime-api.md:21-29` | None | — | Lacks — client code reusable |
| Comments: `list_comments`, `add_comment` (with `ask`, passkey confirm), `resolve_comment` | `OA: apps/server/src/mcp/tools/comments.ts:65-127`; caps `services/comment-rules.ts:8-19` | None (task `completionNote` is not a thread) | `VP: convex/schema.ts:460` | Lacks |
| Spaces: `list_spaces` | `artifacts.ts:275` | Organisations + namespaces play this role | `VP: convex/lib/auth.ts:287` (`withOrgScope`) | Map space -> VP org (+ optional sub-space later) |
| Audit log (REST only, 400 d retention) | `OA: apps/server/src/routes/audit.ts:47-60`; `limits.ts:82` | Narrow logs only: `credentialsAuditLog`, `oauth_audit_log` | `VP: convex/schema.ts:2203, 2232` | Lacks a per-object read/write log |
| `bus_role_propose` | `OA: apps/server/src/mcp/tools/bus.ts:19` | — | — | See D4 |

---

## D2 — Security model and storage decision

### What open-artifacts does (all read in code)

| Mechanism | OA source |
|---|---|
| Two hosts: app host (dashboard, `/mcp`, viewer `/a/{id}`) and content host (raw files, never sets cookies, strips `Set-Cookie`) | `apps/server/src/index.ts:131-132`; `apps/server/src/content/app.ts:521, 538` |
| Iframe sandbox **without** `allow-same-origin` or `allow-top-navigation*`: `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads` | `packages/shared/src/sandbox.ts:4-14` (the docs page `security.md:18` omits `allow-popups-to-escape-sandbox`) |
| CSP `sandbox …` on every content response, `frame-ancestors` appended; images get `default-src 'none'` and no scripts; `nosniff` | `apps/server/src/http/middleware.ts:72`; `content/app.ts:58-59, 539-555` |
| Signed content URLs: HMAC-SHA256, key HKDF-derived per purpose, MAC over id+version+exp+mode+viewer, TTL 600 s (callers may only shorten), 60 s skew, optional binding to the viewer's `session_epoch` | `apps/server/src/util/crypto.ts:37-55`; `apps/server/src/auth/keys.ts:26-73`; `apps/server/src/content/signing.ts:7-103, 150` |
| Unseen object -> 404, never 403 | `apps/server/src/auth/authz.ts:550-562, 737` — but 403 is returned for a *visible* object in 5 cases (`authz.ts:446-447, 464, 713`; `policy.ts:554`) |

### How it holds in VP

- **Sandbox + CSP + two hosts:** pure HTTP/browser properties, portable unchanged. The content host becomes a Convex HTTP action route on its own hostname; the app host stays the dashboard.
- **Signed URLs:** VP has **no** signed-URL mechanism today; every HMAC in the repo verifies an inbound webhook (`VP: convex/http.ts:39-60`). Convex's own `ctx.storage.getUrl()` is a bearer URL: "anyone with the URL can access the file", revocable only by deleting the file ([Convex docs, serve files](https://docs.convex.dev/file-storage/serve-files)). So artifact bytes must **not** be served through `getUrl()`; they are served by an HTTP action that verifies an OA-style HMAC token, as the Convex docs recommend for "files requiring access control on every request".
- **The HMAC primitive is credential validation.** Pi's ruling R1 on PR #1739 (task k170e3qtjfdnqbyaz4wwvgmk958hyh1q) places such helpers in `@vantageos/cloud-identity`; the content-URL signer/verifier goes there too, not into `convex/`.
- **404-not-403 vs `refusal-is-distinguishable-from-absence.md`:** these conflict. VP raises `RBAC_DENIED` so a reader can tell a refusal from an absence; OA hides existence with 404. **Ruling needed (Pi):** proposed split — the *browser-facing* content host and viewer route answer 404 to anyone without access (existence is the secret there); the *MCP / Convex* doors keep `RBAC_DENIED` for a resolved caller, per the rule. The rule text must then be amended in the same delivery.

### Storage decision, with its numbers

| Limit | open-artifacts | Convex |
|---|---|---|
| Max file | 25 MB (`OA: packages/shared/src/limits.ts:10`) | No stated upload cap; HTTP action **response** ≤ 100 MiB, request uncapped ([limits](https://docs.convex.dev/production/state/limits)) |
| Max publish | 100 MB (`limits.ts:11`) | Files per mutation: 10 stored / 10 read, 16 MiB total — upload via upload URL, not mutation args |
| Inline content | 128 KB (`limits.ts:5`) | Document ≤ 1 MiB; action args/returns ≤ 16 MiB (Node 5 MiB) |
| Runtime data doc | 256 KB free / 1 MB paid (`limits.ts:6-7`) | Document ≤ 1 MiB — fits |
| Storage / egress | R2 (no egress fee) | Professional: 100 GB storage incl., 50 GB/month egress incl., then $0.03/GB-month and $0.12/GB |

**Decision: Convex file storage for v1.** Every OA file limit (25 MB file, 1 MB data doc) fits under Convex's 100 MiB HTTP response and 1 MiB document; the share/ACL check and the bytes live in one transactional store under one identity layer. **Exit criterion:** if artifact egress exceeds the 50 GB/month included, move blobs to the Convex R2 component (expiring URLs) without changing the ACL model. Reuse the existing ticketed upload (`VP: convex/kbMutations.ts:502-633`) and add the missing byte cap (25 MB, OA's value).

---

## D3 — A client of a VP organisation opens a shared artifact (no Claude account)

On VP's existing layer only (Clerk persons, `client_org_mapping`, `orgMembership`); no Cloudflare Access, no second login.

1. An agent of org A calls `share_artifact(artifactId, email, role=viewer|editor)`. The mutation resolves the caller with `withOrgScope` (`VP: convex/lib/auth.ts:287`), checks it owns the artifact, and writes a `artifactShares` row `{artifactId, orgId, email (lower-cased), role, createdBy}`.
2. If the email is not a Clerk user of org A, VP sends a Clerk organisation invitation landing on the account portal sign-up page — the existing path (`VP: scripts/invite-client-people.mjs`, which since a534d64a sets `redirect_url` to the account portal). A new **guest** grant is required: `orgMembership` knows only admin/member (`VP: convex/schema.ts:2146`); a guest sees only rows shared to its verified email.
3. The recipient signs in through Clerk (email code or Google, as Clerk is configured) and opens `https://<app host>/a/<artifactId>` on the dashboard, which sits behind `clerkMiddleware`.
4. The viewer route calls a Convex query: identity from `ctx.auth.getUserIdentity()` (verified email claim, never an argument), join `artifactShares` by `(artifactId, email)`. No row -> 404 at this browser door (see D2 ruling).
5. The query returns an HMAC content URL (TTL ≤ 600 s, bound to the person's session epoch, signer from `@vantageos/cloud-identity`). The page frames it in the OA sandbox iframe.
6. The content host (Convex HTTP action) verifies the MAC and expiry, and streams the file with the OA CSP.
7. **Revoke:** `unshare_artifact` deletes the row — new URLs refused at once; issued ones die within 600 s. Removing the person from the org bumps their epoch and kills issued URLs immediately. Public visibility skips steps 2-5 (no token, as OA).

This respects `authority-attached-to-anonymous-object.md`: the grant is keyed on the verified principal's email, never on a client-supplied field.

---

## D4 — The agent bus

What it does (`OA: packages/bus-protocol/CONTRACT.md`, `OA: packages/bus-daemon/README.md`): one hub Durable Object per member (`idFromName("bus:"+userId)`, no org id — `OA: apps/server/src/services/bus.ts:243-250`); a per-machine Node daemon holding one WebSocket to the hub; adapters that inject a message into a **live** Claude Code session through that session's local socket (`OA: packages/bus-adapter-claude-code/src/inject.ts:37-51`, session discovery from `~/.claude/sessions`, `session.ts:30-113`).

VP messaging today is **pull-only**: the MCP uses `ConvexHttpClient`, no subscription (`VP: mcp-server/src/authenticatedConvexClient.ts:84, 207`); stations poll `check_messages` on a cron; presence is self-reported `profiles.dynamic.lastSeen` (`VP: convex/schema.ts:196-197`).

| Mechanism | Verdict | Reason |
|---|---|---|
| Push into a live Claude Code session (daemon -> session socket, `<cross-session-message>` frame, body neutralised) | **Adapt** | Removes the polling cron the operator cut to */15 on 2026-11-12. VP version: a local daemon subscribes to the station's unread receipts with the reactive `ConvexClient` and injects. Depends on Claude Code's session messaging socket, an interface VP does not own. |
| Device-flow machine approval (RFC 8628, 8-char code, 600 s, token stored as sha256) | **Adopt** | Matches VP's station onboarding gap (task k177034bdx6cqb82grpc862pw58hckgk, credential minting); the token maps to an agent credential in `agent_credentials`. |
| Presence (live / queued / away, 7-day away retention) | **Adapt** | Daemon heartbeat replaces self-reported `lastSeen`. |
| Per-member hub, no org id | **Ignore** | VP isolation is the organisation (`client_org_mapping`); a per-user hub would be a second tenancy model. |
| Inline ≤ 32 KB / fetch ≤ 1 MB, inbox cap 50, mail TTL | **Ignore** | VP already caps content at 900 000 bytes (`VP: mcp-server/src/tools.ts:259`) and keeps messages durably. |
| `bus_role_propose` (role addresses confirmed by a human link) | **Ignore for now** | VP addresses agents by `agentId` (`VP: convex/messages.ts:271`). |

**Security limit, stated by OA itself:** "The threat model is same-uid" (`OA: packages/bus-daemon/README.md:19-21`); `hello.pid` is not verified (no `SO_PEERCRED`), and any same-uid process can read `machine.json` and the Claude session keys. On a host where several VP stations run under one Unix user, a daemon would let any station impersonate another. **Condition for adoption:** one Unix user per station, or one daemon per station whose credential the other stations cannot read.

---

## D5 — Build plan and recommendation

| Option | Verdict |
|---|---|
| Self-host open-artifacts as-is | **Rejected.** Second identity layer (Access/Google/email codes, its own users and PATs, `OA: apps/server/src/auth/pat.ts`), Cloudflare-only runtime, a second tenancy model. Clients would hold two logins. |
| Full port | **Not possible line for line.** The server is Hono on Workers with D1/DO/R2 bindings; on Convex it is a rewrite. |
| **Hybrid (recommended)** | Server reimplemented on Convex against VP identity; client and design reused under MIT with attribution: `OA: packages/shared/src/sandbox.ts`, `packages/shared/src/limits.ts` (values), `apps/dashboard/src/viewer/` (Shell, frame, Diff), `packages/runtime`, `packages/render`, `packages/doc-schema`; the signing scheme of `apps/server/src/content/signing.ts` re-expressed in `@vantageos/cloud-identity`. |

**Delivery order** (each step its own task, TDD, Eta review; MCP ships last per `railway-mcp-redeploy.md`):

1. **Rulings first (Pi):** 404-at-browser-door vs `RBAC_DENIED` split (D2); guest grant on `orgMembership` (D3).
2. **`@vantageos/cloud-identity`:** content-URL signer/verifier (HMAC-SHA256, HKDF per purpose, epoch-bound), alongside R1's edge-header helper.
3. **VP backend (Convex):** tables `artifacts`, `artifactVersions`, `artifactFiles`, `artifactShares`, `artifactComments`, `artifactData`, `artifactAudit`; mutations/queries with three-pole refusal tests; content-host HTTP action with OA CSP; byte caps from OA's limits; contract version bump.
4. **VP MCP tools:** the 22 non-bus tools mirrored (93 -> ~115 advertised), output schemas from day one (Manufact score), added to `MCP_CALLED_FUNCTIONS`.
5. **Dashboard app:** viewer route `/a/{id}`, sandboxed shell ported, share UI, comments.
6. **Doc Forge:** publishes through `publish_artifact` instead of claude.ai artifacts.
7. **Bus adapter (separate mission):** daemon + Claude Code injection + device-flow approval, gated on the same-uid condition.

**Risks:**
- Convex egress beyond 50 GB/month (exit to R2 component, D2).
- Custom hostname for Convex HTTP actions as the content host — not measured on our plan.
- Claude Code's session socket is an interface we do not own; it can change without notice.
- Tool count growth weighs on the Manufact quality score already in progress (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
- OA docs drift from its code in 5 places (sandbox flag list, "never 403", login providers, unbound `DocRoom`, `create_upload` missing from the tool page): port from the code, never from the docs.

## not_measured

- Custom domains for Convex HTTP actions on the VP deployment's plan.
- Whether Claude Code's cross-session socket exists and accepts injection in the Claude Code version the fleet runs.
- Real artifact egress volume (no artifacts exist in VP yet).
- `apps/demo-ops` and `packages/broker-core` in open-artifacts were not read beyond file names.
- No code from open-artifacts was executed; every OA claim is from reading files at `f576bc6b`.
