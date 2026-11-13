# Audit — integrating artifacts into VantagePeers, measured against open-artifacts

- **Products:** VantagePeers **Cloud** (multi-tenant) is the target of every recommendation below. VantagePeers **Self-host** inherits the same backend code but its runbook (`docs/getting-started/`) is out of scope here.
- **Task:** k17dj3vva141smerqfnebr4k6s8j4k0x (operator order 2026-11-13). Goal: integrate the artifact feature into VantagePeers. This audit is the first step; D5 names the build PRs Pi dispatches from it. The agent bus (D4) is a short appendix.
- **Revisions read:** open-artifacts `f576bc6b35d3dda8b016b1d5f83c1365cf1c7504` (2026-11-13, MIT, `LICENSE` line 1-3); VantagePeers `origin/main` @ `35286a33`.
- **Notation:** `OA:` = path in open-artifacts, `VP:` = path in this repo.

## Summary

1. open-artifacts is a **Cloudflare-Workers-native** product (one Worker, D1, R2, KV, four Durable Objects; `OA: apps/server/wrangler.template.jsonc:2-37`). Its server cannot be ported line for line onto Convex; its **client-side packages and its security design can**.
2. Running it **as-is beside VP** would create a second identity layer (Cloudflare Access / Google / email codes; `OA: apps/server/src/auth/sign-in.ts:17-20`). That is refused by the one-identity-layer rule.
3. **Recommendation: hybrid port.** Artifact metadata, versions and rights in VP Convex tables, keyed on VP's existing organisations, agents and Clerk persons; artifact **bytes in Convex file storage first, behind a storage key that also fits Cloudflare R2 through the Convex R2 component** (`@convex-dev/r2`), adopted when measured egress needs it (Pi ruling, 2026-11-13); reuse under MIT (attribution kept) the viewer shell, sandbox constants, runtime bridge and limits; serve content from a separate content host with HMAC-signed, short-lived URLs.
4. **First build PR:** VP backend — `artifacts` + `artifactVersions` tables and the `publish_artifact` / `get_artifact` / `list_artifacts` / `list_versions` / `restore_version` MCP tools. Then sharing, then the viewer on the content host (D5).
5. **Pi rulings (2026-11-13), applied below:** (1) the browser-facing artifact door answers 404 to anyone without access; agent doors keep `RBAC_DENIED`. (2) A `guest` role on `orgMembership`, created by share-by-email through Clerk, reaching only the artifacts shared with that person.
6. **R2 prerequisite, when R2 is adopted:** a Cloudflare account, R2 buckets with CORS, and an R2 API token. None of the five R2 names is in the vault today (Pi's `VAULT:` read, 2026-11-13). PR 1 does not wait for it.

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
- **404-not-403 vs `refusal-is-distinguishable-from-absence.md`:** these conflict. VP raises `RBAC_DENIED` so a reader can tell a refusal from an absence; OA hides existence with 404. **Pi ruling 1 (2026-11-13):** the *browser-facing* artifact door (content host and viewer route `/a/{id}`) answers 404 to anyone without access, so a client's artifact ids are not enumerable; the *agent* doors (MCP tools, Convex functions) keep `RBAC_DENIED`, distinguishable as the rule requires. The rule text names this boundary (the rule governs agent-facing doors, the human viewer door is the named exception) in **PR 3**, the delivery that builds that door, per the rule's own "same delivery" clause; this audit PR changes no rule.

### Storage decision, with its numbers

| Limit | open-artifacts | Convex |
|---|---|---|
| Max file | 25 MB (`OA: packages/shared/src/limits.ts:10`) | No stated upload cap; HTTP action **response** ≤ 100 MiB, request uncapped ([limits](https://docs.convex.dev/production/state/limits)) |
| Max publish | 100 MB (`limits.ts:11`) | Files per mutation: 10 stored / 10 read, 16 MiB total — upload via upload URL, not mutation args |
| Inline content | 128 KB (`limits.ts:5`) | Document ≤ 1 MiB; action args/returns ≤ 16 MiB (Node 5 MiB) |
| Runtime data doc | 256 KB free / 1 MB paid (`limits.ts:6-7`) | Document ≤ 1 MiB — fits |
| Storage / egress | R2 (no egress fee) | Professional: 100 GB storage incl., 50 GB/month egress incl., then $0.03/GB-month and $0.12/GB |

**Decision (Pi ruling, 2026-11-13): Convex file storage first; R2 through the Convex R2 component when the measured egress needs it. Metadata, versions and rights are in VP Convex tables either way.**

To make the move a backend swap rather than a migration of the rights model, each artifact file row stores `{ backend: "convex" | "r2", key }`; PR 1 writes `convex` only. Adoption trigger: artifact egress measured above the 50 GB/month included on Convex Professional, or the operator providing the Cloudflare items below.

The R2 component, as read for that step:

The component, read from its published package (`npm pack @convex-dev/r2@0.10.4`, `package/README.md`):
- Setup: install in `convex.config.ts`; one bucket with a CORS policy; five deployment variables `R2_BUCKET`, `R2_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` (README lines 31-94).
- Upload: `r2.clientApi({ checkUpload, onSyncMetadata })` exposes `generateUploadUrl` + `syncMetadata`; `checkUpload` is where the caller's org and rights are verified before a URL is issued; a custom object key needs our own mutation calling `r2.generateUploadUrl(key)` (README 149-272).
- Read: `r2.getUrl(key, { expiresIn })` returns a **signed S3 URL, default 900 s** (README 355, 376). Delete: `r2.deleteObject(ctx, key)` (423-438).
- Limits: "no restrictions imposed by the component itself, only R2's standard limits" ([component page](https://www.convex.dev/components/cloudflare-r2)).

Why it holds with the security model:
- **The browser never receives an R2 URL.** An R2 presigned URL is served by R2's S3 endpoint, which cannot attach our `sandbox` CSP; the iframe would load unsandboxed content from a third origin. The content host (a Convex HTTP action on its own hostname) verifies the VP HMAC token, fetches the object server-side with a short `getUrl(key, { expiresIn: 60 })`, and streams it with the OA headers. HTTP action responses are capped at 100 MiB, above OA's 25 MB file limit.
- **One identity layer:** the R2 credentials are deployment secrets read only by Convex; rights are decided in VP tables before any URL is minted.
- **Egress:** R2 charges no egress, which removes the Convex 50 GB/month ceiling noted above. The content host still relays the bytes through Convex, so Convex HTTP-action bandwidth applies — **not measured** on our plan.
- **On Convex storage (PR 1),** the same relay holds: the browser never receives a `ctx.storage.getUrl()` bearer URL; the content host reads the blob with `ctx.storage.get` and streams it with the OA headers. Upload reuses the ticketed path (`VP: convex/kbMutations.ts:502-633`).
- **Caps to enforce at upload (either backend):** 25 MB per file, 100 MB per publish, 1000 files per version (OA `packages/shared/src/limits.ts:10-11, 63`).

**R2 prerequisites, when adopted (owned by the operator, none in the vault today):** a Cloudflare account; one R2 bucket for Cloud prod (and one for dev); its CORS policy allowing the dashboard origin; an R2 API token yielding the five values above, stored in Infisical `ma-fabrique` `/shared` `prod` and set on the Convex deployments from there.

---

## D3 — A client of a VP organisation opens a shared artifact (no Claude account)

On VP's existing layer only (Clerk persons, `client_org_mapping`, `orgMembership`); no Cloudflare Access, no second login.

1. An agent of org A calls `share_artifact(artifactId, email, role=viewer|editor)`. The mutation resolves the caller with `withOrgScope` (`VP: convex/lib/auth.ts:287`), checks it owns the artifact, and writes a `artifactShares` row `{artifactId, orgId, email (lower-cased), role, createdBy}`.
2. If the email is not a Clerk user of org A, VP sends a Clerk organisation invitation landing on the account portal sign-up page — the existing path (`VP: scripts/invite-client-people.mjs`, which since a534d64a sets `redirect_url` to the account portal). **Pi ruling 2:** a `guest` role is added to `orgMembership` (today admin/member only, `VP: convex/schema.ts:2146`). It is created by share-by-email through Clerk, reaches ONLY the artifacts explicitly shared with that person (no tasks, memory, messages or missions), is revocable, and each grant and revoke is logged.
3. The recipient signs in through Clerk (email code or Google, as Clerk is configured) and opens `https://<app host>/a/<artifactId>` on the dashboard, which sits behind `clerkMiddleware`.
4. The viewer route calls a Convex query: identity from `ctx.auth.getUserIdentity()` (verified email claim, never an argument), join `artifactShares` by `(artifactId, email)`. No row -> 404 at this browser door (see D2 ruling).
5. The query returns an HMAC content URL (TTL ≤ 600 s, bound to the person's session epoch, signer from `@vantageos/cloud-identity`). The page frames it in the OA sandbox iframe.
6. The content host (Convex HTTP action) verifies the MAC and expiry, and streams the file with the OA CSP.
7. **Revoke:** `unshare_artifact` deletes the row — new URLs refused at once; issued ones die within 600 s. Removing the person from the org bumps their epoch and kills issued URLs immediately. Public visibility skips steps 2-5 (no token, as OA).

This respects `authority-attached-to-anonymous-object.md`: the grant is keyed on the verified principal's email, never on a client-supplied field.

---

## D4 — Appendix: the agent bus (not a blocker for artifacts)

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

**Build PRs, in order** (each its own task, TDD, Eta review; Convex rollout first, MCP last, per `railway-mcp-redeploy.md`; each PR mirrors its Convex functions in the MCP tools and bumps the backend contract version):

1. **PR 1 — VP backend, publish and versions.** tables `artifacts` (org, owner agent/person, title, visibility=private only for now, latest version) and `artifactVersions` (artifact, number, file manifest of `{ backend, key }` with backend `convex`, sha256, size, author); upload through the ticketed path with the D2 caps; MCP tools `create_upload`, `publish_artifact` (content / files / edits, `expectedVersion`), `get_artifact`, `list_artifacts`, `list_versions`, `restore_version`, `delete_artifact`. Org isolation and three-pole refusal tests (`refusal-is-distinguishable-from-absence.md`). No sharing, no viewer: an artifact is readable by its own org through MCP only.
2. **PR 2 — sharing.** Implements Pi ruling 2: `guest` role on `orgMembership`, admitted to shared artifacts only (a test per other surface, tasks, memory, messages and missions, proves the guest is refused there). Table `artifactShares`; tools `share_artifact`, `unshare_artifact`, `set_visibility` (team, public); Clerk invitation path for an unknown email (D3); audit rows for share and unshare.
3. **PR 3 — viewer on a separate content host.** Content-URL signer/verifier in `@vantageos/cloud-identity` (HMAC-SHA256, HKDF per purpose, TTL ≤ 600 s, epoch-bound); content-host HTTP action streaming the blob with OA's CSP and answering 404 to anyone without access (Pi ruling 1), with the boundary written into `.claude/rules/refusal-is-distinguishable-from-absence.md` in the same PR; dashboard route `/a/{id}` with the OA sandboxed shell ported under MIT. Needs the content hostname (DNS) decided.
4. **PR 4 — comments and runtime data** (`list_comments`, `add_comment`, `resolve_comment`, `artifact_data_*`), then **Doc Forge** publishing through `publish_artifact`.
5. **Later, separate mission:** the bus adapter (D4), gated on the same-uid condition.

**Risks:**
- Convex egress above the 50 GB/month included, and Convex HTTP-action bandwidth for relayed bytes (not measured): the trigger for the R2 step.
- The guest role widens `orgMembership`: every existing read that admits any member of the org must refuse a guest. PR 2 enumerates those reads (a measured grep, not a memory) before the role exists.
- When R2 is adopted, its credentials are a new deployment secret class for the Convex deployments; setting them is an operator act (`railway-mcp-redeploy.md`: configuration never travels through a merge).
- Custom hostname for Convex HTTP actions as the content host — not measured on our plan.
- Claude Code's session socket is an interface we do not own; it can change without notice.
- Tool count growth weighs on the Manufact quality score already in progress (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
- OA docs drift from its code in 5 places (sandbox flag list, "never 403", login providers, unbound `DocRoom`, `create_upload` missing from the tool page): port from the code, never from the docs.

## not_measured

- Custom domains for Convex HTTP actions on the VP deployment's plan.
- Whether Claude Code's cross-session socket exists and accepts injection in the Claude Code version the fleet runs.
- Real artifact egress volume (no artifacts exist in VP yet), and Convex HTTP-action bandwidth pricing for relayed bytes.
- R2's own object and request limits (the component defers to them; not read).
- The R2 component was read from its README only; it was not installed or run.
- `apps/demo-ops` and `packages/broker-core` in open-artifacts were not read beyond file names.
- No code from open-artifacts was executed; every OA claim is from reading files at `f576bc6b`.
