# Changelog

## [Unreleased] — grant-aware mission/mandate visibility + bind JWT audience

### Added

- **`fail_task` tool — the third task terminal state (`failed`), distinct from `done`/`cancelled` (mission `k576mw0smxeqsg9wp7957njfsn8crey4`, commit `8c70e18`).** New tool, mandatory `failureNote`, output schema `{taskId, status: "failed"}`. `update_task`'s `updateTaskStatusSchema` now excludes both `"blocked"` and `"failed"` (client refused at the tool-input layer, mirroring the server-side `FAILED_VIA_UPDATE_REFUSED` gate). `taskStatusValues`/`taskStatusFilterSchema` gained `"failed"`. `createTaskOutputSchema.status` now reuses the canonical `taskStatusValues` array (was hand-typed and missing `"cancelled"`/`"failed"`). A blocker task reaching `failed` does NOT auto-release its waiters — see `convex`-side CHANGELOG for the reciprocal-unblock fix.
- **`block_task` gained an optional `blockedCause` arg** (`"peer_task" | "human" | "authorisation" | "other"`) naming WHAT the task is waiting on. Backward-compatible: optional, defaults server-side to `"other"`. `block_task`'s output JSON now always carries `blockedCause`.

### Security

- **Consult per-row grants on missions, mandates, and tasks (task `k174y9ra7pp8zed3bcczk6xaed8cpynp`, `@vantageos/cloud-identity` 0.5.0).** The shared scope filter was structurally blind to every per-row grant: a scoped identity named on a mission (`pilot`/`agents`), a mandate (`requestedBy`/`fulfilledBy`), or a task (`assignedTo`) could not read the row it was named on — the multi-org separation failing at exactly what it is sold for. Upgraded the dependency `^0.3.0` → `^0.5.0` (the old caret stopped at the 0.3 minor and never admitted 0.4.0) and passed `grantFields` at the read sites: `get_mission` → `["pilot","agents"]`; `list_mandates`/`get_mandate` → `["requestedBy","fulfilledBy"]`; `get_task`/`list_tasks_by_mission`/`search_tasks_by_keyword` → `["assignedTo"]` (mirrors `convex/tasks.ts` L88-89's `createdBy===caller || assignedTo===caller` OR), replacing the two-sided `createdBy`-remap workaround (the local-variant pattern the shared filter now subsumes). Fail-closed unchanged: a table declaring no grant fields behaves byte-identically to before. Eta REVISE on the first pass of PR #1204 (the original test suite called the package predicate directly instead of the real handlers — litmus test false); rewritten to drive `registerTools()` end-to-end via the same duck-typed McpServer/Convex harness `test/scope-aware-filter-wave-c1.test.ts` uses, RED→GREEN reproduced against the real `get_task`/`search_tasks_by_keyword` call sites. `briefingNotes.participants` stays deferred (task `k175ga65p654z200ydj7s8qv5s8cnxfc`); `recurringTasks.assignedTo`, `missionTemplates.steps[].assignedTo`, `businessUnits.coreTeam.agents`, and `diaries.orchestrator` remain unwired (out of this PR's scope — see PR #1204 `CLASS:` block). TDD strict — GREEN 13/13 under scoped non-creator identity `alice`; full mcp-server suite 1087 passed / 12 skipped, build clean + boot-check 4/4.



- **Bind the `audience` claim where the Clerk session JWT is verified (MCP server standard Critical Rule 14, element 5).** `tryVerifyClerkJwt` (`src/auth.ts`) verified the token with `issuer` bound but not `audience`, so a token minted for one audience/client was accepted on another — cross-tenant / cross-resource replay (the single exploitable finding of the mcp-doctor conformance audit, `projects/vantage-peers/audits/mcp-server-conformance-audit.md`). Fix binds `audience: CLERK_JWT_AUDIENCE` (env, default `"convex"`) at the single `jwtVerify` site — the value mirrors `convex/auth.config.ts` `applicationID: "convex"` and the `CLERK_JWT_TEMPLATE` default, and the verified token is forwarded verbatim to Convex which already requires `aud === "convex"`, so no correctly-minted production token is rejected. Minimal by design: only the one verification site; the auth-layer/DCR/PRM flow and the three other (non-exploitable) audit findings are untouched. TDD strict — RED both poles (wrong-audience refused / correct-audience accepted / no-`aud` refused) reproduced firsthand, GREEN 3/3; full suite 1074 passed / 0 failed, `tsc --noEmit` exit 0.

### Fixed

- **Regenerate `mcp-server/bun.lock` so the grant-aware read actually reaches the customer-facing server (task `k170n5az8xt95gg0b6thrzgej98crnw3`).** PR #1204 (`f51bd709`) bumped `mcp-server/package.json` `@vantageos/cloud-identity` `^0.3.0` → `^0.5.0` and the root `bun.lock`, but never regenerated `mcp-server/bun.lock` — which stayed pinned at `@vantageos/cloud-identity@0.3.0`. The Railway build runs `bun install --frozen-lockfile`, which refuses a lockfile that would have to change (`error: lockfile had changes, but lockfile is frozen`), so the deploy failed **silently**: the previous container kept serving and nothing disagreed. Result: the grant-aware filter was ACTIVE on Convex but INACTIVE on the MCP server — the path a customer actually uses. Repair regenerates the lockfile **in an isolated tree** (never in the workspace, which would resolve against the workspace and reproduce the locally-passing / Railway-failing file), touching `mcp-server/bun.lock` only; the manifest is untouched (dependency scope did not move). The drift named: `@vantageos/cloud-identity` `0.3.0` → `0.5.0`. Proven pair, both poles firsthand: RED = stale lockfile + `^0.5.0` manifest under `--frozen-lockfile` → exit 1 (the exact Railway message); GREEN = repaired lockfile under `--frozen-lockfile` → exit 0. Activation (separate from merge) is a successful Railway deploy read back from the platform, then a scoped-identity probe of the grant filter — never the master credential, which bypasses the very check.

## [2.18.0] — 2026-08-11

### Changed
- **Expose only the CORE tool surface (mission `vp-mcp-alias-cleanup-v1`, S8).** A data-driven allowlist (`mcp-server/tool-exposure.json`, `{"core":[...]}`) masks every tool whose `T2_verdict` is not `CORE` in `analysis/vantagepeers/vp-restructuring/vp-by-tool-day158.csv`. Masking ≠ deletion: non-CORE tools stay registered + handler-wired and are `disable()`d so `tools/list` does not advertise them; reverting = removing a line from the data file. Exposed = CORE ∩ registered = **66** tools; masked = **43** (registered 109). The exposure list is derived from the CSV, never typed; a name in the file matching no registered tool makes the server refuse to start, naming it. Applied at the single shared `registerTools` surface, so both stdio and HTTP transports (online clients) inherit the reduced surface. 5 CORE names from the day158 CSV are #1169-removed aliases whose CORE survivors stay exposed (zero capability lost). Tests: `test/tool-exposure.test.ts` 2/2, full suite 1071 passed / 0 failed, tsc 0.

## [2.17.0] — 2026-08-11

### Removed
- 14 duplicate alias tools removed (mission `vp-mcp-alias-cleanup-v1`, S2, merged in #1169), keeping the fleet-used survivor of each pair — decided by call-site usage, never the code's `DEPRECATED ALIAS` label. Registered tool count 123→109. Context-token saving 1347 (11.1%) of the tool-list surface. Full list + arbitration in the root `CHANGELOG.md` and `elpi-corp/.../S1-arbitrated-pairs-day159.md`.

## [Unreleased] — final refus-total sweep (8 tools) → remaining: 0

### Security

- **Close the last 8 same-class refus-total instances on the client MCP surface.** `get_profile`, `list_peers`, `list_repo_mappings`, `get_repo_mapping`, `get_message` fed `scopeFilterList`/`scopeFilterGet` rows lacking `createdBy`/`namespace` → named remap of the real ownership field (`profiles.orchestratorId`, `githubRepoMapping.orchestrator`, `messages.from`) → `createdBy` before the filter, synthetic field stripped (the `list_broadcast_status` precedent). `list_issues`, `get_issue`, `issue_stats` have no client-owner field (fleet routing/aggregate data; sibling mutations already master-only) → `defineTool` scope `{ kind: "master" }`, structural removal from the client surface. Per tool RED→GREEN with four independent poles; 37 new tests (4 files) + updated `scope-aware-filter-wave-c2`/`c3` (stale fixtures that asserted the old leak as acceptable, aligned to the merged `list_errors` template). RED without fix: 18 owner-pole failures; full CI-scoped suite 2679/2679 green; tsc + scope-typecheck exit 0. **Final class sweep: `remaining: 0`** — every remaining `scopeFilterList`/`scopeFilterGet` site operates on a table with native `createdBy`/`namespace` or already remaps its non-native owner; `check_messages`/`mark_as_read`/`list_tasks`/`list_missions`/`list_diaries` use dedicated non-`scopeFilterList` gates (out of this defect class). Closes VP `k1759mg282aqy6t7c91gnk10598bn4sv`; completes mission `vp-multitenant-zero-hole-v1`.

## [Unreleased] — list_bus / list_mandates / list_errors refus-total close

### Security

- **Scope `list_bus`/`get_bu`, `list_mandates`/`get_mandate` to their owner; move `list_errors`/`get_error` to master-only.** These six handlers fed `scopeFilterList`/`scopeFilterGet` rows whose shape carried neither `createdBy` nor `namespace`, so the guard refused **every** non-master caller including the owner (the refus-total form measured in the S0 campaign). Per-table remedy, decided by measurement: `businessUnits` is owned by `orchestratorId` → named remap to `createdBy` before the filter (the `list_broadcast_status` precedent); `mandates` has two owners `requestedBy`/`fulfilledBy` → dual remap unioned by `_id` (a single remap would hide one party's own mandates); `errorLogs` has no client owner (fleet-ops monitoring) → its `defineTool` scope becomes `{ kind: "master" }`, a structural removal from the client surface (non-master now gets an explicit Forbidden instead of a silent empty list). Per tool: RED (owner refused) → GREEN with owner/deny/master poles moving independently; 28 new tests + updated `scope-aware-filter-wave-c3`; full CI-scoped suite green, tsc + scope-typecheck exit 0. Class sweep found 8 further same-class instances (`get_profile`, `list_peers`, `list_issues`, `get_issue`, `issue_stats`, `list_repo_mappings`, `get_repo_mapping`, `get_message`) — tracked as a follow-up, out of this PR's named scope. Closes VP `k177617dqg6z5c099p1rdp5rqn8b2rp0`.

## [Unreleased] — content-search multi-tenant scope (refus-total close)

### Security

- **Scope three content-rendering MCP tools to their caller.** `list_messages`, `search_messages_by_keyword`, and `search_tasks_by_keyword` fed `scopeFilterList` rows whose rendered shape carried neither `createdBy` nor `namespace`, so the naive guard wrap would have refused **every** caller including the owner (the refus-total defect PR #1122 deliberately avoided for the two search tools; `list_messages` already exhibited it). Fix: message-shaped tools (`from` field) get a named `from`→`createdBy` remap before `scopeFilterList` with the synthetic field stripped on output (the `list_broadcast_status` precedent); `search_tasks_by_keyword` requests `fields=full` internally, filters against the real `createdBy`, then reprojects to the public `lite` shape (avoids changing the public tool shape). Per-tool RED→GREEN with four independent poles (cross-tenant reproduction, owner-only, deny-only, master-all): RED 8-fail without fix → GREEN 17/17. tsc exit 0. Unremapped-shape audit: all 22 `scopeFilterList` sites checked, only the two message sites needed the remap. Closes VP `k175j2jems5deccegp4p0fy4x98b4ypn` + `k1780azk7n8fdb7bpnx5n91sx18b5vjf`.

## 2.14.2 — 2026-06-30

- fix(oauth): DCR `/register` rejects empty/missing/malformed `redirect_uris` (RFC 7591 §3.2.2 `invalid_redirect_uri`). Closes zombie-client class — clients with empty `redirectUris` arrays can no longer be created. Defense-in-depth: same guard at Convex `registerPublicClient`. TDD-strict RED-then-GREEN.

## [Unreleased]

### Added

- **B5 KB ingest MCP tools** — `store_document_chunked` and `soft_delete_document` registered via `mcp-server/src/tools/kbIngest.ts`. `store_document_chunked` accepts `storageId` + `mimeType` + `filename` (+ optional `docId`) and proxies to `kb:storeDocumentChunked`; returns `{ docId, chunkCount, storageId }`. `soft_delete_document` accepts `docId` and proxies to `kb:softDeleteDocument`; returns `{ docId, markedCount }`. Both tools require Clerk JWT with `org_id` — no anonymous access. Exported: `STORE_DOCUMENT_CHUNKED_TOOL_DESCRIPTION`, `storeDocumentChunkedArgsSchema`, `SOFT_DELETE_DOCUMENT_TOOL_DESCRIPTION`, `softDeleteDocumentArgsSchema`. Mission `k5779qbxhwrfjmj02t31yvehns8911jp`, task `k17bdmhr2hffhz2t96p65j70nh891wcp`.

## [Unreleased] — B4 RAG namespace team/<orgId> tenant enforcement

### Added

- **`team-member` scope profile** in `bearerAuthMiddleware` (layer 2.5): Clerk JWTs carrying an `org_id` claim are now verified against the Clerk JWKS (`CLERK_DOMAIN/.well-known/jwks.json`, cached 10 min) and resolve to `scopeProfile="team-member"` with `namespaceReadPrefixes=["team/<orgId>"]` and `namespaceWritePrefixes=["team/<orgId>"]`. Cross-tenant reads/writes are rejected by the existing `checkNamespaceRead` / `checkNamespaceWrite` predicates before any Convex call.
- **`convex/memoriesScoped.ts`**: new `listMemoriesScoped` (query) and `storeMemoryScoped` (mutation) Convex functions that enforce `team/<orgId>` namespace isolation at the Convex layer using `ctx.auth.getUserIdentity()`. Clerk callers with `org_A` cannot read or write `team/org_B/*`.
- **`jose`** (transitive, already present via `@modelcontextprotocol/sdk`) used for JWKS fetch and JWT verification. No new npm dep.
- **`CLERK_DOMAIN` env var**: override the Clerk instance domain (default `https://sharp-sponge-67.clerk.accounts.dev`).

### Security

- Architectural choice: **Option A** (direct Clerk JWT verification in bearer middleware) over Option B (DCR→Clerk join via Convex query). Rationale: Clerk JWTs are self-contained — no extra Convex round-trip needed. Option B would be required only if DCR clients were the sole entry point.
- Cross-tenant deny preserved for DCR `client-generic` (empty prefixes, unchanged) and unregistered orgs (fail-closed: `AUTH_NAMESPACE_DENIED`).

### Tests

- `mcp-server/test/team-namespace-cross-tenant.test.ts` — 16 predicate tests on `checkNamespaceRead/Write/isMasterScope` with team-member, master, and DCR-generic fixtures.
- `convex/__tests__/auth-namespace-deny.test.ts` — 9 convex-test tests verifying `AUTH_NAMESPACE_DENIED` for cross-tenant access at the Convex layer.

## [2.12.0] — 2026-06-14

### Changed
- `check_messages` now calls `messages:checkNewMessagesEnvelope` (Convex PR #759 mergeCommit `c03023fc85463fe16fc53948d3002420bc1c4547`) for bounded tool-response size. New optional `limit` arg (1-50, default 20). When the call is truncated, the text payload appends `— truncated. Resume with check_messages since=<nextSince>` so the orchestrator can page the backlog cleanly without busting Claude Code's tool-response cap.
- `since` arg description amended with a "pair with `nextSince` from a previous truncated reply" hint.

### Notes
- Closes Pi BLOCKER VP task `k1702xaahb` (Day 102 — sigma-vps cron crash on a 36-message / 53 KB backlog).
- Legacy `messages:checkNewMessages` Convex query left intact for vp-mcp <2.12.0 callers (no break).

## [2.11.0] — 2026-06-14 — Day 102 CRUD baseline PR-C-bis option B: 3-entity Convex searchIndex (mission k575kc1ryps0n8br95jw3q7d0x88m2v9)

Mission `mcp-crud-baseline-standard` PR-C-bis under T2. Pi-sequenced follow-up after PR-C (rename-only safe subset) — implements **option B SCOPED** per Pi arbitrage msg `jn7abynmghy5qdr9ga0b914wmh88n99w` ("GO option B SCOPED — démarre PR-C avec 3 entités prioritaires"): tasks + messages + briefingNotes get native Convex BM25 search via `.searchIndex()` schema additions + per-entity Convex queries + MCP tool wrappers.

Backend choice (B over A): Convex native `.searchIndex()` is BM25-only, no embeddings, no RAG per-entity pipeline. Sub-linear scan stays in the same backend without spinning up an embedding pipeline per table. Hybrid/semantic per entity remains a future RFC.

### Added — Convex schema searchIndex (3 tables)

- `tasks` → `searchIndex("search_title", { searchField: "title", filterFields: ["assignedTo", "status", "project", "missionId", "orgId"] })`
- `messages` → `searchIndex("search_content", { searchField: "content", filterFields: ["from", "channel", "sessionDay", "tenantId"] })`
- `briefingNotes` → `searchIndex("search_content", { searchField: "content", filterFields: ["topic", "createdBy", "orgId"] })`

### Added — Convex query functions

- `tasks:searchTasksByKeyword` — BM25 over title with assignedTo/status/project/missionId filters + scope gate via `withOrgScope` + `filterByOrgScope` + `requireScope("view-own-tasks")`. Lite/full projection.
- `messages:searchMessagesByKeyword` — BM25 over content with from/channel/sessionDay/tenantId filters.
- `briefingNotes:searchBriefingNotesByKeyword` — BM25 over content with topic/createdBy filters.

All three: 20-item default limit, 200 cap, lite projection on demand.

### Added — MCP tool wrappers (3 canonical)

- **`search_tasks_by_keyword`** — wires to `tasks:searchTasksByKeyword`. `readOnlyHint=true`.
- **`search_messages_by_keyword`** — wires to `messages:searchMessagesByKeyword`. `readOnlyHint=true`.
- **`search_briefing_notes_by_keyword`** — wires to `briefingNotes:searchBriefingNotesByKeyword`. `readOnlyHint=true`.

### Why option B (and why scoped to 3)

`grep searchIndex convex/schema.ts` previously returned zero hits; only `memories` had search infrastructure (via `@convex-dev/rag`). The original "13-entity cluster" full scope was deferred via PR-C (rename-only) after arbitrage timeout. Pi's arbitrage landed shortly after: **option B SCOPED to 3 priority entities** is the right blend of doctrine progress + bounded scope:
- `tasks` — largest fleet audience (Eta T13 close-issue scan, dispatch-task-find, etc.).
- `messages` — post-incident audit + messages-history skill demand.
- `briefingNotes` — daily snapshot recall narrative.

The remaining 10 entities (mission/mandate/fix_pattern/component/repo_mapping/bu/profile/deployment/diary/error/issue/recurring_task/summary) go to a per-entity RFC (mission walk-through scheduled Wed 17 June 15h with Laurent) — each entity decides B (searchIndex), A (RAG if semantic justified, e.g. episodes/diary), or N/A semantic documented (deployment/repo_mapping).

### Version sync

- `mcp-server/server.ts:115` SERVER_VERSION 2.10.0 → 2.11.0
- `mcp-server/package.json` → 2.11.0
- README + 4 cloud docs bumped to 2.11.0 markers (`enforce-release-sync` v1.0.1 gate).

### Test fixture catch-up

- `READ_ONLY_TOOLS` set in `mcp-server/src/__tests__/chatgpt-tool-annotations.test.ts` extended with the 3 new canonical tool names.

### Refs

- Mission `k575kc1ryps0n8br95jw3q7d0x88m2v9`.
- Pi sequencing dispatch: msg `jn76360ckrrkwpqbfwa6tst7k588mpsh` ("(1) T2 PR-C-bis option B SCOPED 3 entities").
- Pi arbitrage that selected option B: msg `jn7abynmghy5qdr9ga0b914wmh88n99w`.
- Audit T1: `analysis/mcp-crud-baseline-vp-audit-2026-06-14.md` rows 1 (task), 3 (message), 4 (briefing_note).
- Doctrine memory: `j57dhrmkzjerjtssnr0z9ba57n88n7q7` (5 ops per entity).
- Predecessors: PR-A 2.8.0 (memories canonical), PR-B 2.9.0 (episode 5-op), PR-C 2.10.0 (rename-only safe subset).

## [2.10.0] — 2026-06-14 — Day 102 CRUD baseline PR-C: rename-only safe subset (mission k575kc1ryps0n8br95jw3q7d0x88m2v9)

Mission `mcp-crud-baseline-standard` PR-C under T2. Third of 4 sub-PRs aligning the MCP surface with the Day 101 doctrine `j57dhrmkzjerjtssnr0z9ba57n88n7q7`. Sigma autonomous default after arbitrage timeout on the original "13-entity search_by_keyword cluster" scope — that fuller scope requires a backend search-infrastructure decision (RAG-index per entity vs Convex `.searchIndex()` per table) that is NOT a thin-wrapper PR. PR-C ships the rename-only safe subset now to keep doctrine velocity; the full cluster is deferred to a backend-RFC mission.

### Added (2 canonical search tools)

- **`search_components_by_keyword`** — BM25 / substring search over components by name or team. Wire-identical to `search_components` (same Convex query `components:search` 1:1, same scope filter, same defaults). `readOnlyHint=true`.
- **`search_fix_patterns_by_semantic`** — semantic embedding-similarity search over fix patterns. Wire-identical to `search_fix_patterns` (same Convex action `search:searchFixPatterns` 1:1, same scope filter, same defaults). `readOnlyHint=true`. Note: the canonical suffix is `_by_semantic` (NOT `_by_keyword`) because the underlying ranker is embedding-cosine, not BM25 — naming follows behavior, not entity convention.

### Deprecated (alias-only, removal target 2.11.0)

- **`search_components`** — alias of `search_components_by_keyword`. Description leads with `DEPRECATED ALIAS …`.
- **`search_fix_patterns`** — alias of `search_fix_patterns_by_semantic`. Description leads with `DEPRECATED ALIAS …`.

### Re-targeted deprecations (FOLLOW-UP from Eta PR #750 review)

- **`text_search`** — 2.8.0 originally targeted removal at 2.9.0; episode-only PR-B did not include the removal. Source comments + this entry re-target removal to **2.11.0**.
- **`recall`** — same re-target rationale, removal now **2.11.0**.

Both `text_search` and `recall` remain wire-identical to their canonical successors (`search_memories_by_keyword` / `search_memories_by_semantic`). Closes FOLLOW-UP task `k1754apqtcjpre2vd5ghbkcmzn88mhwf`.

### Scope NOT in this PR (deferred)

The original PR-C "13-entity search_by_keyword cluster" required adding BM25 / search infrastructure to 10+ entities that currently have NO backend search index (`grep searchIndex convex/schema.ts` → zero hits; only `memories` is indexed, via `@convex-dev/rag`). Two backend paths exist:

- **Path A** — extend RAG indexing to each entity (heavy: per-table embedding pipeline, RAG namespace per entity, vector cost; gets hybrid search for free).
- **Path B** — Convex native `.searchIndex()` per table (lightweight: schema migration + one query per entity, BM25-only, no embeddings).

Either path is a multi-day backend RFC, NOT a thin-wrapper PR. Sigma sent the arbitrage to Pi (msg `jn75zy4g7bhj95bhyz2zvv6n8d88na6s`) and defaulted to PR-C path C (rename-only) after 2 cron ticks of no reply. A follow-up mission to scope the backend search infrastructure is the next mission proposal.

### Version sync

- `mcp-server/server.ts:115` SERVER_VERSION 2.9.0 → 2.10.0
- `mcp-server/package.json` → 2.10.0
- README + 4 cloud docs bumped to 2.10.0 markers (`enforce-release-sync` v1.0.1 gate).

### Test fixture catch-up

- `READ_ONLY_TOOLS` set in `mcp-server/src/__tests__/chatgpt-tool-annotations.test.ts` extended with the 2 new canonical names.

### Refs

- Mission `k575kc1ryps0n8br95jw3q7d0x88m2v9` (MCP CRUD Baseline Standard).
- Pi authorization msg `jn74q7twhr3s1s8dvqxbzvky9588msdd` ("next: T2-PR-C 13-entity search_by_keyword cluster post #750 merge").
- Sigma arbitrage msg to Pi: `jn75zy4g7bhj95bhyz2zvv6n8d88na6s` (3 paths A/B/C).
- FOLLOW-UP task: `k1754apqtcjpre2vd5ghbkcmzn88mhwf` (text_search/recall deprecation slipped).
- Audit T1: `analysis/mcp-crud-baseline-vp-audit-2026-06-14.md` § 4.

## [2.9.0] — 2026-06-14 — Day 102 CRUD baseline PR-B: episode entity 5-op surface (mission k575kc1ryps0n8br95jw3q7d0x88m2v9)

Mission `mcp-crud-baseline-standard` PR-B under T2. Second of 4 sub-PRs aligning the MCP surface with the Day 101 doctrine `j57dhrmkzjerjtssnr0z9ba57n88n7q7` ("5 ops per entity"). PR-B adds the missing read/list/search facades for the `episode` entity, completing the 5-op surface (the write side `store_episode` already existed since the 8-Sins doctrine).

Architectural note: episodes are NOT a separate Convex table — per hotfix `7f958d0`, episodes are stored as memories with `type='episode'` (context/goal/action/outcome/insight + severity). The 4 new tools are thin wrappers that force `type='episode'` on the existing `memories:*` / `search:*` actions, so callers get an ergonomic episode-scoped surface without introducing a new backend table or duplicating index logic.

### Added (4 canonical episode tools)

- **`get_episode`** — fetch a single episode by memory ID. Calls `memories:getMemory` then asserts the returned row has `type='episode'`; otherwise returns a non-leaky "Episode not found" so wrong-type IDs do not leak existence of non-episode memories. Scope-aware via `scopeFilterGet`. Annotations: `readOnlyHint=true`, `openWorldHint=false`, `destructiveHint=false`.
- **`list_episodes`** — list episodes ordered newest first. Calls `memories:listMemories` with `type='episode'` forced. Accepts `namespace?`, `createdBy?`, `limit?`, `fields?`, `cursor?` — same paging semantics as `list_memories`. Scope-aware via `scopeFilterList`. Envelope-capped via `capListResponseBytes("list_episodes")`.
- **`search_episodes_by_keyword`** — BM25 search restricted to episodes. Calls `search:textSearch` with `type='episode'` forced. Same `guardRead` namespace gate, same 20-default / 200-cap limits.
- **`search_episodes_by_semantic`** — semantic vector cosine search restricted to episodes. Calls `search:recall` with `type='episode'` forced. Same gate, same limits.

All four are pure MCP-layer additions: no Convex schema change, no new index, no new action. tsc clean.

### Why

Episode = the 8-Sins / orchestrator-introspection memory type (severity + context/goal/action/outcome/insight). Until 2.9.0, recalling past episodes required `recall query='...' type='episode'` — discoverable only to callers who already knew the memory-side filter trick. Surfacing dedicated wrappers makes the episode lifecycle (write via `store_episode`, read via `get_episode`, browse via `list_episodes`, recall via the two search ops) consistent with the doctrine and self-documenting in any MCP client's tool list.

`hybrid_search` remains entity-agnostic and is NOT mirrored for episodes (cross-cutting RRF tool per audit § 4).

### Test fixture catch-up

- `READ_ONLY_TOOLS` set in `mcp-server/src/__tests__/chatgpt-tool-annotations.test.ts` extended with the 4 new tool names.

### Refs

- Mission `k575kc1ryps0n8br95jw3q7d0x88m2v9` (MCP CRUD Baseline Standard, pilot Sigma + agents Sigma + Eta).
- Pi authorization msg `jn74v2pkfz08agex4nfm2yfvfd88nzdw` — "chain T2 PR-B episode entity en autonomie scope mission".
- Audit T1 deliverable: `analysis/mcp-crud-baseline-vp-audit-2026-06-14.md` row 7 (episode entity recommendation: add façade wrappers).
- Architecture: hotfix `7f958d0` — episodes are memories with metadata, not a separate table.

## [2.8.0] — 2026-06-14 — Day 101 CRUD baseline PR-A: search_memories_by_keyword + search_memories_by_semantic (mission k575kc1ryps0n8br95jw3q7d0x88m2v9, task k1735qk9kx6agjjyt3e38rdvvh88mk0p)

Mission `mcp-crud-baseline-standard` PR-A under T2 `[CRUD-T2] Implémentation gaps VP MCP`. First of 4 sub-PRs aligning the MCP surface with the Day 101 doctrine `j57dhrmkzjerjtssnr0z9ba57n88n7q7` ("5 ops per entity: get / list / search_by_keyword / search_by_semantic / create-or-upsert"). PR-A handles the convention drift on the `memories` entity — the only entity that already had both keyword + semantic search wired, but under non-canonical names.

### Added (canonical names)

- **`search_memories_by_keyword`** — BM25 full-text search over memories, identical wire to `text_search`. Calls `search:textSearch` Convex action 1:1, same params (`query`, `namespace?`, `type?`, `limit?`, `fields?`), same `guardRead` namespace gate, same 20-item default limit + 200 cap, same `mcpConvexError` error surface (2.7.1 sweep). Annotations: `readOnlyHint=true`, `openWorldHint=false`, `destructiveHint=false`, title `"Search memories by keyword (BM25)"`.
- **`search_memories_by_semantic`** — semantic vector cosine search over memories, identical wire to `recall`. Calls `search:recall` Convex action 1:1, same params, same gate, same defaults. Annotations: `readOnlyHint=true`, `openWorldHint=false`, `destructiveHint=false`, title `"Search memories by semantic (vector cosine)"`.

### Deprecated (alias-only, one minor window)

- **`text_search`** — alias of `search_memories_by_keyword`. Description now leads with `DEPRECATED ALIAS`, source comment marks it for removal in `2.9.0`. Wire unchanged — existing callers continue to work for one minor.
- **`recall`** — alias of `search_memories_by_semantic`. Description now leads with `DEPRECATED ALIAS`, source comment marks it for removal in `2.9.0`. Wire unchanged.

### Why

Per mission `k575kc1r` brief + Pi arbitrage `jn77rpx2msfy2v174sdqyjzp6n88m9bw` Q4 (RENAME CLEAN, optional one-minor dual-emit buffer if Sigma judges useful): the legacy `text_search` / `recall` pair predates the Day 101 CRUD baseline naming convention. Other entities will gain `search_<entity>s_by_keyword` / `search_<entity>s_by_semantic` in PR-C (cluster of 13) and PR-D (vectorIndex add for briefing_notes + diary). Aligning the `memories` entity FIRST means PR-C/D ship into a fleet that already understands the new naming, and skill / plugin / docs propagation (T-SKILLS, T-PLUGIN, T-DOC) has a single canonical truth to follow.

`hybrid_search` is intentionally NOT renamed — it remains a cross-cutting RRF-fusion tool, not entity-scoped, per the audit `analysis/mcp-crud-baseline-vp-audit-2026-06-14.md` § 4.

### Refs

- Mission `k575kc1ryps0n8br95jw3q7d0x88m2v9` (MCP CRUD Baseline Standard, pilot Sigma + agents Sigma + Eta).
- Task T2 `k1735qk9kx6agjjyt3e38rdvvh88mk0p`.
- Audit T1 deliverable: `analysis/mcp-crud-baseline-vp-audit-2026-06-14.md` (140 lines, 53 table rows).
- Doctrine memory: `j57dhrmkzjerjtssnr0z9ba57n88n7q7` (5 ops per entity).
- Pi Q4 arbitrage: msg `jn77rpx2msfy2v174sdqyjzp6n88m9bw`.

## [2.7.1] — 2026-06-14 — Day 101 FIX-B mcpError() → mcpConvexError() sweep (task k1744wk2gfgqt2gdqh41d4r91h88n410)

Patch-level fix to make every tool wrapper surface structured ConvexError
diagnostics instead of opaque `"Server Error [Request ID: ...]"` strings.

**Problem (Day 101):** when a Convex mutation/query threw a `ConvexError`
(e.g. `TASK_START_BLOCKED`, `COMPLETION_NOTE_REQUIRED`) or an
`ArgumentValidationError`, the tool wrapper called
`mcpError(error.message ?? String(error))` which returned a plain
`Error: <message>` text payload. The MCP client (Claude Code) then often
re-displayed this as a generic `Server Error [Request ID:...]`, masking the
actual root cause and triggering misdiagnosis sprees (Pi msg
`jn7c5tfj0347vaenyqgrezehk188mr11` mistakenly attributed the symptoms to
a backend regression that did not exist — see Sigma report msg
`jn773p8qnfp6ycb1f7gajhs8vn88m11a`).

**Fix:** sweep all 99 occurrences of
`return mcpError(error.message ?? String(error))` →
`return mcpConvexError(error)`. The `mcpConvexError` helper (already
present at `src/tools.ts:535`, shipped 2.4.x) parses ConvexError messages
into a structured JSON `{ code, message, path, hint }` payload that
surfaces the actual error code (`ArgumentValidationError`,
`ConvexError`, `AuthorizationError`, `SchemaValidationError`, etc.)
along with a path and a concise hint for ID-table mismatches.

Total counts post-sweep: `grep mcpConvexError(` → 102 ; `grep
mcpError(error.message` → 0.

Type check: `npx tsc --noEmit` exits 0.

Mission/refs: `k575kc1ryps0n8br95jw3q7d0x88m2v9` MCP CRUD Baseline Standard,
task FIX-B `k1744wk2gfgqt2gdqh41d4r91h88n410`. Co-shipped with hook
`enforce-friction-field.py` v1.1.0 STDERR clarification (Day 101 task
FIX-A `k17ads7kh7qk7yxgfe0dh73ggx88ny9f`).

## [2.7.0] — 2026-06-13 — Day 100 get_by_id surface Phase 2b (task k172735brsw6bc3j2dkkkfxqrx88kkjq)

Phase 2b wires 2 MCP wrappers calling the Phase 2a Convex queries deployed
in commit 2ebdaba (PR #735 + hotfix 7f958d0):

- **get_message** — `messages:getById` plumbing. Fetch full message row by
  Convex doc ID (channel, sender, sessionDay, tenant scope) for read-receipt
  audit, delete confirmation, or fix-pattern referencing.
- **get_recurring_task** — `recurringTasks:getById` plumbing. Fetch
  recurring task definition (cron schedule, prompt, assignee, last-fire
  metadata) before pause/update/delete.

Both follow the existing `get_memory` / `get_briefing_note` pattern:
`scopeFilterGet(oauthCtx, row)` for scope-aware cross-tenant collapse,
read-only annotations.

**get_episode** was DROPPED from Phase 2b scope: episodes are stored as
memories with episode metadata (no separate `episodes` table in
`convex/schema.ts`). Use existing `get_memory` to fetch episode rows by
their memory document ID. Hotfix 7f958d0 removed the invalid
`episodes:getById` query that broke `convex deploy` typecheck.

Phase 2a CHANGELOG entry deferred — Convex changes shipped in main repo
CHANGELOG, not mcp-server.

Total MCP `get_*` tools after Phase 2b: 16 (was 14 after Phase 1, 10 before
Day 100 task).

## [2.6.0] — 2026-06-13 — Day 100 get_by_id surface Phase 1 (task k172735brsw6bc3j2dkkkfxqrx88kkjq)

Pi reported get_<entity>_by_id MCP surface gaps observed during Day 100 fleet ops.
Phase 1 adds 4 plumbing-only read tools mapping to pre-existing Convex queries:

- **get_task** — `tasks:getById` plumbing. Fetch full task record (description, dependsOn,
  missionId, completionNote, claimedByInstance, startedAt) by Convex doc ID.
- **get_fix_pattern** — `fixPatterns:get` plumbing. Fetch fix pattern with full linked
  fix attempts history.
- **get_mandate** — `mandates:get` plumbing. Fetch spending mandate with limits, current
  spend, approver chain for validateSpending/settleMandate pre-checks.
- **get_repo_mapping** — `githubRepoMapping:getByRepo` plumbing. Fetch GitHub repo→VP project
  mapping by repo slug.

All 4 tools apply `scopeFilterGet(oauthCtx, row)` for scope-aware cross-tenant collapse,
mirroring the existing `get_memory` / `get_briefing_note` pattern (Day 92 S3.1 wave).

Annotations test (chatgpt-tool-annotations.test.ts) READ_ONLY_TOOLS set extended with
the 4 new tools. Pre-existing 84/97 count mismatch in same test is unrelated (separate
F-list track).

Phase 2 (follow-on PR) will add get_message / get_episode / get_recurring_task
(Convex query additions required).
Phase 3 (separate mission) will audit deployment entity (table+queries+tool) and the
cross-backend cloud proxy redeploy cadence.

## [2.5.0] — 2026-06-06 — Day 92 VP MCP quality overhaul (mission k57a36y8)

Day 92 mission `k57a36y8w5t085bqr23dsmvb2d882506` ships a fleet-wide VP MCP quality bump
across audit, docs, hooks, security, and consistency dimensions. 15 PRs merged to main.

### Phase A — Audit + new tools
- **A1** Day 92 VP MCP tools audit matrix (85 tools, 14 P0 zero-auth gaps) — `docs/test-reports/day92-vp-mcp-audit-matrix.md`.
- **A2** Consistency analysis report — `docs/test-reports/day92-vp-mcp-consistency-analysis.md`.
- **A3** New `whoami` LECTURE tool — first per-tool `outputSchema` export precedent.
- **A4** Consolidated gap matrix — `docs/test-reports/day92-vp-mcp-gap-matrix-consolidated.md`.

### Phase B — Documentation
- **B1** `docs/cloud/security-multi-tenant.md` §4 scope-aware filter framework rewrite.
- **B2** `docs/cloud/tools-quality-standard.md` (NEW) — 12-section bilingual quality standard.
- **B3** `docs/cloud/onboarding-customer.md` (NEW) — customer onboarding guide (bilingual FR+EN).

### Phase C — Consistency
- **C0** 14 P0 zero-auth write tools secured with `guardMasterOnly` (C0.1 → C0.6, 6 PRs).
- **C1** 87 Zod `outputSchema` exports per per-family envelope standard (B2 §3).
- **C2** Orchestrator-id NFC normalization + case-insensitive matching; idempotent prod migration `convex/migrations/c2-normalize-orchestrator-ids.ts` (7 tables).
- **C3** 97 tool descriptions standardized + 10 canonical aliases gated through `guardMasterOnly` (security regression fixed in iter 2) + alias-c0-gate-coverage test (15/15 PASS).
- **C4** Legacy `claude-peers` references removed repo-wide + `grep-gate` CI workflow.

### Phase F — Hooks + plugin
- **F1** New consolidated `validate_task_payload` MCP tool + TypeScript validator library (replaces 5 single-axis hooks).
- **F2** Plugin propagation runbook + `plugin-vs-workspace-hooks.md` doctrine.

### Scope-aware filtering
- `list_tasks` `fromAllowList[]` + case-insensitive matching (PR #654, #661).
- 3 admin endpoints reinstated for Nadia cohort (prior session).

### Tenant trio
- Persistent test tenant trio (alpha/beta/gamma) seeded on prod with bearers, scope_profiles, and seed data for cross-orchestrator E2E.

### Deploy authorization
- `PI_AUTHORIZED_TASK_ID=k1751nfs27t9f9mpvg3ppd6xad884r59` (Day 82 doctrine).
- Mission: `k57a36y8w5t085bqr23dsmvb2d882506`.
- Branch: `release/v2.5.0` opened against `main` at HEAD `18a5530`.

## [2.4.13] — 2026-06-02 — Post-public republish: attribution + CHANGELOG day-numbers + RULE #7 narrative scrub

Repository visibility flip to PUBLIC on 2026-06-02 (mission D62 `k57e4t21sr55rhz8ng554eseb987wvh3`). This patch republishes the npm package so the published README + CHANGELOG + attribution match the now-public source.

No runtime / API / schema changes. Documentation + metadata only.

What changed since v2.4.12:
- `mcp-server/package.json`: author restructured to "VantageOS AI Orchestrator Team" with contributors block (Pi, Laurent Perello, ElPi Corp). Dependency `@vantageos/mosaic@^0.1.2` added for Phase 1 Mosaic groundwork (PR #605, server-side createMosaicResource API ready for Phase 2 primitive swap).
- `mcp-server/CHANGELOG.md`: version headers simplified to `X.Y.Z — YYYY-MM-DD` (Day N anchors dropped per Laurent verdict 2026-06-02 — dates are self-explanatory, day numbers added noise). Narrative client-name mentions (Nadia/<client-org>/Cédric Delport) genericized to "early-access RH cohort" / "self-host incident" per RULE #7 pre-public scrub.
- Root README rework (PR #611 + PR #610 + PR #616 chain): TL;DR + Mermaid architecture diagram + 5 hero features + 22-features collapsed details + 84-tools 8-groups + Backend: Convex 3-paths + attribution Credits section. README /team 404 hotfix landed in PR #616.

Merged PRs in this republish window:
- PR #611 (`9464f9a`) — T5ter README rework + CHANGELOG day-numbers + attribution
- PR #615 (`c189a1d`) — Phase 1 RULE #7 pre-public scrub
- PR #616 (`99eeae5`) — README /team 404 hotfix

Mission: D62 pre-public cleanup `k57e4t21sr55rhz8ng554eseb987wvh3`.
Friction capitalize: `post-public-flip-must-trigger-npm-republish-for-consistency-not-just-repo-visibility-flip` + `day-79-hook-should-validate-tree-not-commit-sha`.

## [2.4.0] — 2026-05-29 — M3 iframeEmbedSessions + __VP_TOOL_RESULT__ stream marker + ack-checklist

**Mission instance** : `sigma-vantage-peers-mcp-gui-iframe-embed-v1` (k5730xct6rvrwkvxhy5t5js12d87jwfw).
**Pi sign-off** : PI_AUTHORIZED_TASK_ID=`k1793m1qgn0zaay6r87dhvsh7187kwya` (PROD-DEPLOY-AUTHORIZED).
**Eta sign-off** : ETA_APPROVED_TASK_ID=`k171ep964sxabbrgmb21fk9axd87ka1n` at commit `338a7b9e6130ce69dc5fe7f3e2e9ecc4648b4f6a` (SHA-pinned).
**Merge** : PR #545 squash `f509c8d92f0b142bc063a0e9dd070e1993cc729b`.

M3 delivers the session registry and stream-marker protocol that connects the VP MCP server
to the Gen UI iframe bridge. All marker emission is gated behind `VP_EMIT_UI_MARKERS=1`
so production behaviour is unchanged until the bridge is deployed.

### Convex schema — `iframeEmbedSessions` table

NEW table `iframeEmbedSessions` in `convex/schema.ts` :
- Fields : `sessionId` (string), `tenantId` (optional string), `origin` (string),
  `userId` (optional string), `createdAt` (number), `lastSeenAt` (number),
  `expiresAt` (number), `revoked` (boolean).
- Indexes : `by_session_id` on `["sessionId"]`, `by_origin_expires` on `["origin", "expiresAt"]`.

NEW `convex/iframeEmbedSessions.ts` — 4 operations :
- `createSession` mutation — inserts a new session row.
- `getSession` query — returns session or null (null for expired / revoked).
- `touchSession` mutation — bumps `lastSeenAt` to now; returns bool.
- `revokeSession` mutation — sets `revoked=true`; returns bool.

### Stream marker — `mcp-server/src/ui-resources/stream-marker.ts`

NEW `MARKER_START = "__VP_TOOL_RESULT__"`, `MARKER_END = "__END__"`.

NEW `wrapToolResult(payload: VpToolResult): string` :
- Validates via `VpToolResultSchema`, throws `TypeError` on schema failure.
- Returns `__VP_TOOL_RESULT__<json>__END__`.

NEW `parseToolResult(text: string): VpToolResult | null` :
- Extracts marker substring (handles bare, embedded, surrounding text).
- Returns validated `VpToolResult` or null on any failure (no-throw contract).

### MCP tools — marker emission gated by `VP_EMIT_UI_MARKERS=1`

`mcp-server/src/tools.ts` — 6 tools now append `wrapToolResult(...)` after the JSON payload
when `VP_EMIT_UI_MARKERS=1` (default OFF) :

| Tool                  | kind               |
|-----------------------|--------------------|
| `list_tasks`          | `tasks-table`      |
| `list_messages`       | `messages-feed`    |
| `get_diary`           | `diary-entry`      |
| `list_missions`       | `mission-timeline` |
| `list_briefing_notes` | `briefing-note`    |
| `list_memories`       | `memory-quote`     |

Change is surgical — existing return shape is preserved; marker is appended as a new line.

### Ack checklist

NEW `docs/M3-ACK-CHECKLIST.md` — bilingual FR/EN post-deploy verification checklist
for the beta verifier cohort. Covers: package install, primitive reads, Shadow DOM scoping,
stream marker emit + parse, bilingual spot check, WCAG AA (contrast + role attrs),
default-OFF guard.

### Tests

15+ new vitest cases (≥264 total after M3, baseline 253 after M2) :
- `mcp-server/src/__tests__/m3-stream-marker.test.ts` — 14 cases:
  `wrapToolResult` ×6 valid kinds, ×2 throws on invalid, `parseToolResult` roundtrip,
  non-marker text ×2, embedded text, malformed JSON ×2, schema rejects unknown kind ×2.
- `convex/iframeEmbedSessions.test.ts` — 7 cases:
  create+get, optional fields, getSession unknown, expired session null,
  touchSession updates lastSeenAt, touchSession unknown false,
  revokeSession marks revoked (getSession null), revokeSession unknown false.

0 regression on M1+M2 suites (253/253 baseline).

---

## [Unreleased] — M1 SEP-1865 ui:// resources backend + M2 primitives + Zod schemas

**Mission instance** : `sigma-vantage-peers-mcp-gui-iframe-embed-v1` (k5730xct6rvrwkvxhy5t5js12d87jwfw).
**Template VR consumed** : `gui-iframe-embed-v1` v1.0.0 (jx7bzk0x1086tgwgj2zrssk2pn87k1ga).

M1 Foundation (adapted MCP-pure paradigm per Pi arbitrage 2026-05-28) :
- NEW `mcp-server/src/ui-resources/index.ts` : URI parser `ui://vp/v1/<primitive>?<query>` + primitive registry + handler factory.
- NEW `mcp-server/src/ui-resources/primitives/tasks-table.ts` : M1 MVP primitive returning HTML inline (Shadow DOM scoped CSS) — WCAG AA + bilingual FR+EN.
- `mcp-server/server-http.ts` : wired `ListResourcesRequestSchema` + `ReadResourceRequestSchema` MCP handlers on the existing McpServer instance.

Tests : 14 new vitest cases (`src/__tests__/ui-resources-sep-1865.test.ts`) — URI parsing, primitive registry, render variants (empty, populated, FR), backend arg forwarding, XSS escape, error fallback, limit clamping, unknown primitive rejection. 0 regression on existing suites.

### M2 — Resolve 5 Gaps + Bearer sha256 hardening (adapted MCP-pure paradigm)

5 new ui:// primitives :
- `messages-feed` (`messages:listMessages` backend — channel filter applied client-side)
- `diary-entry` (`diary:get` single-entry + `diary:list` multi-entry backend)
- `mission-timeline` (`missions:list` backend with fields=lite)
- `briefing-note` (`briefingNotes:get` by noteId OR `briefingNotes:list` by topic backend)
- `memory-quote` (`memories:listMemories` backend — supports both plain-array and paginated result shapes)

Zod discriminated union schemas : `mcp-server/src/ui-resources/schemas.ts` exports `VpTaskPayloadSchema` + `VpMessagePayloadSchema` + `VpDiaryEntryPayloadSchema` + `VpMissionPayloadSchema` + `VpBriefingNotePayloadSchema` + `VpMemoryPayloadSchema` + `VpToolResultSchema` (discriminated union by `kind`). Cross-fleet ready for Mu vantage-bridge sidepanel S3 consumer.

Bearer sha256 validation : Already in place since v2.3.4 DCR security fix. `mcp-server/src/auth.ts` line 275 calls `sha256Hex(token)` before every Convex lookup (layers 2 and 4). Raw token never reaches Convex. No further hardening needed in M2.

Tests : 42 new vitest cases in `src/__tests__/ui-resources-m2-primitives.test.ts` (target was ≥22). Covers : PRIMITIVES registry (6 entries), each of 5 new primitives (empty + populated + FR labels + XSS escape + error fallback = 5 cases each), Zod schema roundtrip (VpToolResultSchema all 6 variants accepted, malformed rejected, individual payload schema validations). 0 regression on M1 17 cases + 194 other MCP tests (253/253 total).

M3 next : Registry json-render + `__VP_TOOL_RESULT__<json>` stream marker + smoke E2E + ack-checklist + PI-SIGNED Convex prod deploy + visual ack from beta cohort verifiers.

---

## v2.3.5 — 2026-05-28

**Critical hotfix** — v2.3.3 (PR #539) shipped the backend filters `createdBy` + `updatedSince` and the Zod schema exports but did NOT wire those params into the 4 list MCP tool args blocks. Pi pull-cycle quickstart `list_tasks createdBy="pi" status="review" fields="lite"` was silently dropping `createdBy` at the MCP boundary and returning all visible tasks. Auto-clamp safeguard (2026-05-27) also could not trigger because Zod `.default(50)` / `.default(20)` on `limit` overrode the absent-value signal before it reached the backend.

Fixes:
- `mcp-server/src/tools.ts` : 4 list tools now expose `createdBy` (`list_tasks` + `list_tasks_by_mission` only — `list_missions` + `list_briefing_notes` do not accept it backend-side) and `updatedSince` (all 4).
- Removed `.default(50)` (3 tools) and `.default(20)` (1 tool) on `limit` so absent value reaches the backend, enabling the v2.3.3 auto-clamp safeguard.

Tests : 8 new boundary-forwarding cases (`src/__tests__/list-queries-v2.3.5-wire-createdby-updatedsince.test.ts`) — verify MCP layer actually forwards new params to `convex.query` instead of dropping them. 0 regression on existing suites.

Detection : Vantage-Bridge architecture review Sigma scope 2026-05-28 — direct `grep`/`sed` inspection of `tools.ts` confirmed the gap. Backend already correct since v2.3.3 (`convex/tasks.ts:354-357`).

Fix-pattern (2026-05-28 capitalize) : when adding a new param across backend + MCP wrapper, the test suite MUST cover not only schema validation but also the tool-handler→convex.query forwarding boundary. Schema-only tests passed cleanly in v2.3.3 while the actual feature was broken in prod.

VP task : `k177tsvdxzase5sjy2qm9fdvp187kbwr`. Predecessor v2.3.3 PR #539 (`k1796s5j6jfkvkx0tn5n926ftd87jx9p`).

## v2.3.4 — 2026-05-28

**Security fix** — DCR (Dynamic Client Registration) self-registration now defaults to tenant-scope only. Master scope requires explicit admin authorization (`ADMIN_DCR_TOKEN` / `BEARER_SECRET_MASTER` env var). Closes beta blocker for early-access RH cohort onboarding identified in VP Cloud audit 2026-05-28.

Changes:
- `convex/oauth.ts`: `registerPublicClient` now explicitly rejects `scopeProfile="master"` with a `ScopeViolation` error. Previously only the HTTP server enforced this; the Convex-layer was bypassable via direct internal call.
- `mcp-server/src/auth.ts`: bearer layer 3 (DCR token path) no longer maps `mcp:full` scope string to `scopeProfile="master"`. DCR tokens now always resolve to `client-generic` (deny-by-default). The `mcp:full` label in the legacy `oauthTokens` table was a scope label, not an authorization grant.
- `convex/oauthDcr.ts`: added security documentation clarifying the legacy table is no longer an escalation path; the auth middleware fix is the primary gate.

Tests: 5 new Convex security tests (`convex/oauth-dcr-security.test.ts`) + 5 new MCP scope enforcement tests (`mcp-server/src/__tests__/dcr-scope-enforcement.test.ts`), 0 regression on existing suites.

VP task: k17218rvqyncs1v6rwj3qdzfsn87jj4n. Beta unblock chain: DCR fix → 5 quick wins onboarding (seed-profiles + early-access RH cohort client + README VP Cloud + runbook + email).

## v2.3.3 — 2026-05-28

**Follow-up to v2.3.2 (2026-05-28 scope élargi)** — Extend list queries with `createdBy` + `updatedSince` filters + auto-clamp safeguard.

Backend (Convex) :
- `tasks.list` + `tasks.listByMission` : + `createdBy` (filter by task creator) + `updatedSince` (Unix ms window) + auto-clamp limit=30 when `fields="full"` and no explicit limit
- `missions.list` : + `updatedSince` + auto-clamp (30)
- `briefingNotes.list` : + `updatedSince` + auto-clamp (15 when fields=full)

MCP wrapper :
- 4 list tools forward the new params
- New export `updatedSinceSchema` (positive integer ms)
- `limit` `.default()` removed on the 4 list tools so absent limit flows to backend → enables auto-clamp

Tests : 15 new MCP schema cases (`src/__tests__/list-queries-v2.3.3-createdby-updatedsince.test.ts`) + 6 new Convex round-trip cases.

Pi pull cycle unblocked : `list_tasks createdBy="pi" status="review" fields="lite"` returns only Pi-dispatched tasks recently moved to review, payload 5-10× smaller.

Cap fleet : 0 overflow tolérance future (auto-clamp).

VP task: `k1796s5j6jfkvkx0tn5n926ftd87jx9p`. Successor of `k17e09ng1tf217n93z9m4tr0mx87hfe0` (v2.3.2 PR #537).

## v2.3.2 — 2026-05-28

**Hotfix** — Expose `fields="lite"` + `status` array/aliases in MCP tool schemas (2026-05-26 sprint gap).

Backend support for these params shipped in v2.3.1 but the MCP wrapper Zod schemas never exposed them, so MCP clients couldn't pass them. Fixed for 4 list tools:

- `list_tasks`: + `fields`, status now accepts aliases (`"open"`, `"active"`, `"all"`) and arrays
- `list_tasks_by_mission`: same
- `list_missions`: + `fields`, status accepts aliases and arrays
- `list_briefing_notes`: + `fields`

Aliases NOT permitted inside arrays (matches backend rejection contract).

Tests: 14 new cases (`src/__tests__/list-queries-schema-v2.3.2.test.ts`), 0 regression on 295+ existing.

Fix-pattern (fleet-wide): When backend query supports a new param, ALWAYS update the MCP wrapper tool schema in the SAME PR.

VP task: `k17e09ng1tf217n93z9m4tr0mx87hfe0`.

## 2.3.1 — 2026-05-26

### Fixed (Eta PR #530 delta-review)
- `status="all"` now actually returns every row (no filter applied). Previously advertised in 2.3.0 docs but the Convex `expandTaskStatuses` / `expandMissionStatuses` helpers rejected it as invalid.
- `status=["all"]` (alias inside an array) now correctly throws `ConvexError` — same conservative-rejection rule as `"open"` / `"active"`.
- `setPendingAliasReleases` on the Convex backend converted from `mutation` to `internalMutation`. It was a public DoS surface against the auto-IRP pipeline; it is a lifecycle operation only and must not be reachable via MCP.

## 2.3.0 — 2026-05-26

### Added
- `list_tasks`, `list_missions`, `list_tasks_by_mission`, `list_briefing_notes` now accept `fields=lite` for compact payloads.
- Status filters on `list_tasks`, `list_tasks_by_mission`, and `list_missions` now accept arrays and aliases:
  - `status=["todo","in_progress"]` — multi-value array
  - `status="open"` — expands to non-terminal statuses (tasks: todo+in_progress+review+blocked; missions: brainstorm+plan+execute+validate)
  - `status="active"` — in_progress only on tasks; plan+execute on missions
  - `status="all"` — no filter applied

### Backward compat
- Single-string status still accepted unchanged.
- Omitting `fields` defaults to `"full"` — existing callers unaffected.

---

## 2.2.0 — 2026-05-07

- 4 new fix-pattern tools: `create_fix_pattern`, `add_fix_attempt`, `validate_fix`, `link_issue_to_pattern`
- Detailed per-tool docs with arg tables and example calls in README
- New "Fix patterns cycle" section documenting the KB learning loop
- 41 new Zod input-validation unit tests for fix-pattern tools

## 2.1.1 — 2026-05-04

- Defense-in-depth `memoryIdSchema` validation for `create_briefing_note` and `update_briefing_note`

## 2.1.0 — 2026-04-25

- `update_briefing_note` MCP tool with RBAC

## 2.0.2 — 2026-04-14

- Added badges (npm version, downloads, license, tool count) to the published README
- Added Orchestrator Roles reference table including alpha, lambda, victor
- Added note that any custom lowercase role name is accepted
- Added `bugs` URL and additional keywords to `package.json`

## 2.0.1 — 2026-04-14

- Docstring fix in server.ts (minor)

## 2.0.0

- Type-safe `api.ts` export for cross-deployment calls (`vantage-peers-mcp/api`)
- Deploy key authentication guide
- Mission Templates category (1 tool: `update_mission_template`)
- Programmatic API section in README

## 1.x

- Initial public release with 82 MCP tools
