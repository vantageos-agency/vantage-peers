# Changelog

## [Unreleased]

### Changed
- **Day 108 OKF Phase 2 B3 — `export_okf_bundle` generalized (drop `project/elpi-corp` hard lock)** — `assertCanExportNamespace` in `convex/okfBundleNode.ts` no longer rejects non-Phase-1 namespaces; any non-empty prefix is accepted as long as identity-attached callers match the namespace tail (cross-tenant deny preserved). Path-traversal segments (`..`) are rejected for defence-in-depth. Multi-tenant `team/<orgId>/*` and other `org/<slug>` namespaces can now export their own bundles, unblocking VP Cloud Dashboard tenant Settings UI (F8). MCP tool `export_okf_bundle` description + Zod arg schema updated. Mission `k5779qbxhwrfjmj02t31yvehns8911jp`, task `k17f3407sg7cn6gswn5qs9j5b5891581`. Tests: `convex/__tests__/okfBundleExportGeneralize.test.ts` 8/8 PASS (including `project/elpi-corp` regression case).

### Added
- **Day 98 F4 — webhook `issue_comment` Bridge-only path** — `convex/http.ts` webhook handler for `issue_comment` events now routes exclusively through the Bridge tenant path. Prevents double-processing on multi-tenant deployments. PR #796, commit `f0c133c`.
- **Day 98 F3 — stub-aware guard on webhook cron hook** — `convex/hooks.ts` cron now includes a stub-presence guard so stubs registered during tests do not fire production webhook paths. PR #796, commit `f0c133c`.
- **DOCS-CONTEXT-LOOP (RULE #25)** — Docs-lockstep discipline now live on this repo. Any PR touching tools, API, or install paths must update `README.md` + `CHANGELOG.md` in the same PR. Exemptions require explicit `docs-skip: <reason>` in PR body.
- **Tool count reaches 114** — 17 tools added since v2.5.0 including episodes API (`get_episode`, `list_episodes`, `search_episodes_by_keyword`, `search_episodes_by_semantic`), single-entity getters (`get_task`, `get_message`, `get_fix_pattern`, `get_mandate`, `get_recurring_task`, `get_repo_mapping`, `get_briefing_note`), search tools (`search_tasks_by_keyword`, `search_messages_by_keyword`, `search_briefing_notes_by_keyword`), template tool (`instantiate_template_into_mission`), identity tool (`whoami`), and validator tool (`validate_task_payload`). Aliases: `recall`, `text_search`, `update_summary`, `create_diary`, `create_task_dependency`, `create_fix_attempt`, `check_fix`, `check_mandate_spending`, `register_deployment`, `delete_deployment`, `register_repo_mapping`, `delete_repo_mapping`, `search_components`, `search_fix_patterns`.

### Changed
- **README HTTP/Railway transport** — Quick Start now documents both Option A (stdio) and Option B (HTTP/SSE via Railway) transports. HTTP transport is required for Claude.ai, ChatGPT, and any non-local MCP client.
- **README tool count** — All occurrences updated from 97 to 114.

## [v2.5.0] — 2026-06-06 — Day 92 VP MCP quality overhaul (mission k57a36y8w5t085bqr23dsmvb2d882506)

Day 92 delivered a comprehensive quality overhaul of the VP MCP server across fourteen deliverables (C0–C4, A1–A4, B1–B3, F1–F2). C0 closed all 14 P0 zero-auth write tools identified in the A1 audit matrix (commit `d03d2d7`) by wiring master-only gates (`guardMasterOnly`) or identity ownership checks (`checkFromAllowed`) into every affected handler. C1 shipped 87 Zod `outputSchema` exports following the per-family envelope standard (`whoamiOutputSchema` at `tools.ts:576` commit `5231811` as the canonical precedent). C2 enforced Unicode NFC normalization at all write paths and case-insensitive orchestrator-ID matching at all filter comparisons, closing the NFD/NFC mismatch class that caused the Hélios/helios production regression (PR #654, commit `00b95f0`). C3 standardized 97 tool descriptions (1-line summary + WHEN clause + concrete EXAMPLE, 80–500 chars each) and aligned 10 tool names to the `verb_noun_snake` whitelist. C4 removed all `claude-peers` legacy references from source and added a grep-gate CI check. A3 shipped the `whoami` LECTURE tool (PR #661, commit `5231811`) for automatic skill identity resolution. F1 shipped the `validate_task_payload` MCP validator tool (commit `cf6c961`). B1–B3 delivered the tools-quality-standard doc, scope-filter framework documentation, and onboarding-customer guide respectively.

Authorized under `PI_AUTHORIZED_TASK_ID=k1751nfs27t9f9mpvg3ppd6xad884r59`, mission `k57a36y8w5t085bqr23dsmvb2d882506`. Release branch: PR #678. For the full per-PR list see `mcp-server/CHANGELOG.md`.

### Security
- **S2.3 D8 — VP MCP master-gate constant-time hardening via `@vantageos/cloud-identity@0.1.0`** — `mcp-server/src/auth.ts` `masterOnlyMiddleware` now consumes `validateMasterBearer` from the shared npm brick `@vantageos/cloud-identity@0.1.0` (replaces the prior non-constant-time `token !== masterToken` direct string compare). Brick sha256-hashes both the presented Bearer token and the configured `BEARER_SECRET_MASTER`, then constant-time-compares the digests via the brick's `timingSafeEqual` — closing both the byte-oracle and length-oracle leaks on every `/admin/*` route (including the S2.2 D5 `PATCH /admin/scope-profiles/:id` emergency endpoint and all OAuth admin routes). Local `mcp-server/src/crypto.ts` and `mcp-server/src/scope-filter.ts` deleted; 7 importers rewired to the brick (3 source + 4 test files). Algorithm unchanged (XOR-accumulate + dummy HMAC on length mismatch). Tests: 254/254 PASS (zero regression vs S3.3 follow-up batch 1 baseline). Test report: `docs/test-reports/s2.3-d8-vp-mcp-migration-cloud-identity-0.1.0-2026-06-04.md`. RED `fbe73e0` · GREEN `ce9f7ba`.

### Added
- **S2.2 D5 — `PATCH /admin/scope-profiles/:id` master-gated HTTP wrapper** — new admin endpoint in `mcp-server/server-http.ts` exposing the existing `oauth:patchScopeProfileEmergency` Convex mutation (S1.2-mutation + S2.1) over REST. Mounted under the already-master-gated `/admin/*` Hono sub-app (`masterOnlyMiddleware` → 401 missing / 403 wrong bearer); Convex layer re-asserts master via constant-time `timingSafeEqual` in `requireMasterAuth`. Body schema: `cascadeRevokeTokens: boolean` and `reason: string` required; `rename` / `fromAllowList` / `namespaceReadPrefixes` / `namespaceWritePrefixes` optional `string[]`. Response on 200: `{ patchedProfileId, cascadeRevokedCount, clientsRetargeted, auditLogId }`. Convex throws mapped to HTTP: `profile not found` → 404, `D4 violation` → 400, `reason must be at least 40 characters` → 400, others → 500. Token re-issue stays on the standard `/authorize` + `/token` path — emergency surface is revoke-and-audit only. No new master-token utility introduced; the underlying Convex mutation is unchanged. Tests: 13 new (13/13 PASS), full mcp-server suite 205→218 PASS, zero regression. Test report: `docs/test-reports/s2.2-d5-admin-scope-profiles-patch-2026-06-04.md`. RED `f86fe75` · GREEN `ca2d2dd`.
- **S3.3 B8 — `list_*` cursor paging + envelope cap protection** — new shared `mcp-server/src/paging.ts` utility (`DEFAULT_LIMIT=50`, `MAX_LIMIT=200`, `ENVELOPE_TARGET_BYTES=50_000`, `clampLimit`, `encodeCursor`/`decodeCursor`, `enforceEnvelopeCap`, `buildPageResult`). MCP `list_tasks`, `list_memories`, `list_briefing_notes` now accept an opaque `cursor` argument and emit `nextCursor` on full pages so callers can drain past the 200-row newest-first page-cap. Convex `tasks.list()` + `briefingNotes.list()` accept optional `createdBefore` for forward pagination; `memories.listMemories` forwards `paginationOpts.cursor` end-to-end. Backward-compatible: callers without `cursor` / `limit` keep the legacy `?? 20` envelope-safe default. Friction origin: Sigma stale-task cleanup 2026-06-04 required 6 identical 132-task batches because no cursor existed. Tests: 28 new (28/28 PASS), full mcp-server suite 177→205 PASS, zero regression. Test report: `docs/test-reports/s3.3-b8-list-tools-cursor-paging-2026-06-04.md`.
- **S3.3 B8 follow-up batch 1 — cursor paging rollout to 6 more `list_*` tools** — additive rollout of the shared `mcp-server/src/paging.ts` utility (PR #635) to `list_missions`, `list_diaries`, `list_components`, `list_recurring_tasks`, `list_mandates`, `list_bus`. Each MCP tool gains an opaque `cursor` arg + emits `nextCursor` on full pages; each Convex query (`missions:list`, `diary:list`, `components:list`, `recurringTasks:list`, `mandates:list`, `businessUnits:list`) gains a `createdBefore: v.optional(v.number())` arg + post-take filter mirroring the briefingNotes pattern. Backward-compatible: pre-batch callers (no `cursor` / no `limit`) keep the legacy `?? 20` envelope-safe default. Tests: 36 new (36/36 PASS), full mcp-server suite 218→254 PASS, zero regression. Test report: `docs/test-reports/s3.3-followup-batch-1-cursor-paging-2026-06-04.md`.

### Changed
- **S3.3 B8 follow-up batch 3 FINAL — cursor paging rollout complete (19 / 19 coverage)** — closes the S3.3 B8 rollout by migrating `list_peers` to cursor paging (MCP wrapper + `convex/profiles.ts: listProfiles` gains `limit` + `createdBefore` args, refactored from unbounded `.collect()` to `.order("desc").take(limit)` + post-take filter) and pinning explicit `@cursorPagingException` JSDoc markers on the three remaining tools whose shape is incompatible with `createdBefore` cursors: `list_broadcast_status` (single-object shape), `search_components` (relevance-ranked semantic search), `search_fix_patterns` (semantic-action ranker). Cumulative coverage post-merge: **16 migrated + 3 documented exceptions = 19 / 19 covered** — every list/search tool in the MCP surface has either cursor paging or a documented exception. Backward-compatible: pre-batch `list_peers` callers keep the legacy `?? 20` envelope-safe default; `listProfiles` server-side default `take=50` replaces the unbounded `.collect()` (doctrine-aligned ceiling matching the `githubRepoMapping:list` fix from batch 2). Tests: 12 new (12/12 PASS, RED→GREEN delta of 3 on list_peers cursor-decode + full-page nextCursor + invalid cursor); full mcp-server suite 290→302 PASS, zero regression. Test report: `docs/test-reports/s3.3-followup-batch-3-final-cursor-paging-2026-06-04.md`.
- **S3.3 B8 follow-up batch 2 — cursor paging rollout to 6 more `list_*` tools** — additive rollout of the shared `mcp-server/src/paging.ts` utility (PRs #635 + #637) to `list_messages`, `list_tasks_by_mission`, `list_repo_mappings`, `list_issues`, `list_fix_patterns`, `list_errors`. Each MCP tool gains an opaque `cursor` arg + emits `nextCursor` on full pages; eight Convex queries gain a `createdBefore: v.optional(v.number())` arg + post-take filter (`messages:listMessages`, `tasks:listByMission`, `githubRepoMapping:list`, `issues:listByProject` + `issues:listByOrchestrator` + `issues:listByStatus`, `fixPatterns:listAll` + `fixPatterns:listByProject`, `errorMonitor:listErrors`). `githubRepoMapping:list` additionally gains a `limit: v.optional(v.number())` arg (was previously unbounded `.collect()`), with a server-side default of 50 preserving prior behavior. Backward-compatible: pre-batch callers (no `cursor` / no `limit`) keep the legacy `?? 20` envelope-safe default. Cumulative coverage post-merge: **15 / 21** known `list_*` tools. Tests: 36 new (36/36 PASS), full mcp-server suite 254→290 PASS, zero regression. Test report: `docs/test-reports/s3.3-followup-batch-2-cursor-paging-2026-06-04.md`.

### Fixed
- **D90 kill-switch hardening** — `AUTO_IRP_PAUSED` env-var guard now applied at all three auto-IRP pipeline entries (`pollAllDeployments` cron, `createGitHubIssue` action, `http.ts` webhook `issues.opened` for `[Auto]`-prefixed titles), not only the cron entry shipped in PR #609. Adds `convex/errorMonitorKillSwitch.ts` (`KILL_SWITCH_VARS`, `isKillSwitchActive()`, `assertKillSwitchHealth()` startup warning), a transient retry-class filter rule (`Server Error\nRequest ID:` envelope, severity `skip`) in `DEFAULT_FILTER_RULES`, an `isTransientErrorMessage()` pure classifier, and wildcard `functionName: "*"` support in `evaluateFilter()`. Closes issue #632 false-positive root cause. Tests: 10 new (10/10 PASS) in `convex/error-monitor-kill-switch-harden.test.ts`; errorMonitor suite 92→102; full suite 1358→1368 PASS, zero regression. Test report: `docs/test-reports/d90-kill-switch-harden-2026-06-04.md`.
- `seedDefaultProfiles` (`convex/oauth.ts`) now UPSERTS (patch-on-diff) instead of skip-on-exists, with `oauth_audit_log` entries (eventType `seed_upsert`) per actual update. Operator-created profiles outside the catalog are preserved (no destructive sync). Return shape changed to `{ inserted, updated, skipped }` for caller visibility. Obsoletes the bespoke catalog-drift migration pattern shown in `convex/migrations/patch_marie_iris_rh_scope.ts` for future catalog edits (S3.4 B4). Test report: `docs/test-reports/s3.4-b4-seed-default-profiles-upsert-2026-06-03.md`.

## [2.4.14] — 2026-06-03

### Security — D6 + D7 + patchScopeProfileEmergency + oauth_audit_log + S3.1 Waves A+B

**Scope:** v2.4.14 closes the S2.4b security cascade: OAuth 2.1 hardening, master-gated emergency tenant maintenance, append-only audit ledger, and the first two waves of the scope-aware filter framework.

**Changes:**
- **D6 — confidential `client_secret` at `/token`** — `mcp-server/server-http.ts` L382-585. Constant-time `crypto.timingSafeEqual` comparison. PKCE-only path preserved for public clients. PR #621, commit `5fd6354`.
- **D7 — `redirect_uri` exact-match at `/authorize`** — `mcp-server/server-http.ts` L298-376. Byte-identical match against the client's registered URIs; no prefix / host-only / scheme-normalized acceptance. PR #621, commit `5fd6354`.
- **`patchScopeProfileEmergency`** — `convex/oauth.ts`. Master-token-gated mutation enforcing D4 (no `*` in `cloud-*` profiles), D9 cascade rename, cascade-update on `oauth_clients`, cascade-revoke on `oauth_tokens`, and append-only audit write. PR #622, commit `9a1b8cf`.
- **D9 cascade-update `oauth_clients`** — full enforcement parity. PR #623, commit `2f5c974`.
- **S3.1 — scope-aware filter framework (D3) Waves A+B** — `mcp-server/src/scope-filter.ts` applied to `list_memories`, `get_memory`, `list_briefing_notes`, `list_messages`, `list_peers`. Wave A merged at main `251d183` (PR #624). Wave B in PR #625.
- **`oauth_audit_log`** — append-only emergency-action ledger in `convex/schema.ts`. No update / delete path.

**Doctrine reminder:** Cloud (multi-tenant) and Self-host are distinct products. Runbooks: `docs/cloud/` (Cloud) and `docs/getting-started/` (Self-host) — never mixed.

**References:** PRs #621, #622, #623, #624, #625. Test reports: `docs/test-reports/s1.5-oauth-d6-d7-2026-06-03.md`, `docs/test-reports/s1.2-mutation-2026-06-03.md`, `docs/test-reports/s2.1-d9-cascade-clients-2026-06-03.md`, `docs/test-reports/s3.1.a-scope-aware-filter-wave-a-2026-06-03.md`, `docs/test-reports/s3.1.b-scope-aware-filter-wave-b-2026-06-03.md`.

---

## [2.3.3] — 2026-05-28

### Feature — `createdBy` + `updatedSince` filters + auto-clamp on list queries

**Root cause / Motivation :** 2026-05-27 Pi runtime overflow on `list_tasks limit=50` (~79k chars / 838 lines). Pi pull-cycle HUMAN MODE could not filter to its own dispatched tasks. Need `createdBy` (Pi-dispatched pattern) + `updatedSince` (recent-window pattern) on list queries + auto-clamp safeguard against accidental `fields=full` mega-scans.

**Fix :**
- `convex/tasks.ts` `list` + `listByMission` : new args `createdBy: v.optional(creatorValidator)` + `updatedSince: v.optional(v.number())`. Auto-clamp `effectiveLimit = 30` when `fields="full"` AND no explicit `limit` (with `console.warn`).
- `convex/missions.ts` `list` : new arg `updatedSince` + auto-clamp 30.
- `convex/briefingNotes.ts` `list` : new arg `updatedSince` + auto-clamp 15 (default 20 for this collection).
- `mcp-server/src/tools.ts` : 4 list tools forward new params. New export `updatedSinceSchema` (positive integer ms timestamp). Removed `.default(50)`/`.default(20)` on `limit` so absent value reaches backend (required for auto-clamp).

**Backward compatibility :** all new args optional. Existing callers (no new args) get unchanged behavior. `taskStatusSchema` + `missionStatusSchema` still exported and used by create/update/start operations.

**Tests :**
- `mcp-server/src/__tests__/list-queries-v2.3.3-createdby-updatedsince.test.ts` (NEW) : 15 cases (positive int ms accepted, negative/zero/float/string/null rejected, edge cases NaN/Infinity rejected).
- `convex/tests.test.ts` : 6 new round-trip cases (createdBy filter accuracy, combinatorics, updatedSince window, auto-clamp triggered/bypassed branches).
- Suites : 175/175 MCP + 73/73 Convex full PASS, 0 regression.

**References :**
- PR : https://github.com/vantageos-agency/vantage-peers/pull/539
- Merge commit : `567c6a59` (squash from `6ec70ff96ab53c2b20204489ac96ba09f7fb5923`)
- npm : `vantage-peers-mcp@2.3.3` shasum `26517e5fcf876f5f9c68722e5c66ec963925b489`
- Pi pull-cycle quickstart : `list_tasks createdBy="pi" status="review" fields="lite" limit=30`

---

## [2.3.2] — 2026-05-28

### Hotfix — MCP wrapper exposes `fields=lite` + `status` aliases/arrays

**Root cause :** 2026-05-26 sprint `vp-list-queries-fields-lite-status-multi-v1` (v2.3.1) shipped Convex backend support for `fields="lite"` projection + status aliases (`open`/`active`/`all`) + multi-status arrays on the 4 list queries. The MCP wrapper Zod schemas in `mcp-server/src/tools.ts` were NOT updated, so MCP clients (Claude Code, claude.ai web, orchestrators) could not pass those params — the MCP validator rejected them before reaching backend. 2026-05-27 Pi runtime overflow on `list_tasks limit=50` made the gap painful.

**Fix :**
- `mcp-server/src/tools.ts` : new exports `taskStatusFilterSchema`, `missionStatusFilterSchema`, `fieldsSchema`. Wired into 4 list tools (`list_tasks`, `list_tasks_by_mission`, `list_missions`, `list_briefing_notes`). Aliases NOT permitted inside arrays (matches backend rejection contract).

**Backward compatibility :** zero behavioral change for existing callers. The single-value `taskStatusSchema` + `missionStatusSchema` are still used by all non-filter operations.

**Tests :**
- `mcp-server/src/__tests__/list-queries-schema-v2.3.2.test.ts` (NEW) : 17 cases (single/alias/array variants accepted, array-with-alias rejected, empty array rejected, invalid enum rejected).
- Suite : 160/160 full PASS, 0 regression.

**References :**
- PR : https://github.com/vantageos-agency/vantage-peers/pull/537
- Merge commit : `9772091` (squash from `7373e54b0cfd9858153492d7c88e49a6feda4960`)
- npm : `vantage-peers-mcp@2.3.2` shasum `7fcfa38b2cc3f478bd65607c3e06f420de096c11`

**Fix-pattern fleet-wide :** When backend query supports a new param, ALWAYS update the MCP wrapper tool schema in the SAME PR.

---

## [2.3.1] — 2026-05-26

### Feature — `fields="lite"` projection + status array/aliases on list queries (backend)

**Root cause / Motivation :** MCP list queries (tasks, missions, briefingNotes) returned full Convex documents by default. Large workspaces hit token-budget ceiling on `list_tasks limit=50` (78k+ char payloads). Need compact projection + multi-status filtering.

**Fix :**
- `convex/tasks.ts` `list` + `listByMission` : new args `fields: v.optional(v.union(v.literal("lite"), v.literal("full")))` + `status: v.optional(v.union(v.string(), v.array(v.string())))`. New helper `expandTaskStatuses()` handles aliases: `"open"` → `["todo","in_progress","review","blocked"]`, `"active"` → `["todo","in_progress"]`, `"all"` → `undefined`. Aliases NOT permitted inside arrays.
- `convex/missions.ts` `list` : same shape. `"open"` → `["brainstorm","plan","execute","validate"]`, `"active"` → `["plan","execute"]`, `"all"` → `undefined`.
- `convex/briefingNotes.ts` `list` : `fields` only (no status param).
- `fields="lite"` projects compact fields : tasks `{_id,_creationTime,title,status,priority,assignedTo,missionId}`, missions `{_id,_creationTime,name,status,pilot,priority,project}`, briefingNotes `{_id,_creationTime,topic,title,participants,createdBy}` — typical 5-10x smaller payload.

**Backward compatibility :** `fields` defaults to `"full"`. `status` accepts single string (existing behavior) OR array OR alias. Old callers untouched.

**Tests :** Convex round-trip tests pin contract (alias expansion, array variant, lite projection field set). Full suite green.

**References :**
- PR : https://github.com/vantageos-agency/vantage-peers/pull/530
- Sprint : `vp-list-queries-fields-lite-status-multi-v1`
- 2026-05-26 Pi flag : "On a fait un sprint pour fixer!" (gap closed in v2.3.2 hotfix above).

---

## [2.3.0] — 2026-05-21

### Bug Fix — recall()/hybrid_search() returning [] for self-host with direct OpenAI key

**Root cause (self-host incident, 2026-05-18):** When a self-host operator placed
a direct OpenAI key (`sk-*`) into the `AI_GATEWAY_API_KEY` environment variable, the
embedding provider was routed to `https://ai-gateway.vercel.sh/v1` (the Vercel gateway
base URL). The gateway rejected the direct key with 401 → embeddings silently returned
empty vectors → `recall()` and `hybrid_search()` returned `[]` even after reindexing.
`text_search` (BM25) was unaffected because it does not call the embedding endpoint.

**Fix (`convex/lib/aiClient.ts`):**
- New `isDirectOpenAIKey(key: string): boolean` — detects `sk-*` prefix.
- New `resolveEmbeddingPath()` — explicit routing function with three outcomes:
  `openai-direct` (OPENAI_API_KEY or sk-* in AI_GATEWAY_API_KEY),
  `gateway` (non-sk-* AI_GATEWAY_API_KEY),
  `missing` (neither set).
- `getAITextEmbeddingProvider()` and `getEmbeddingModelName()` now delegate to
  `resolveEmbeddingPath()` — sk-* key in AI_GATEWAY_API_KEY routes to `api.openai.com/v1`
  with the bare model name `text-embedding-3-small` (not the `openai/` prefixed name).

**Backward compatibility:** existing Vercel AI Gateway keys (non-sk-* tokens) and
`OPENAI_API_KEY` behavior are fully preserved.

**Tests:** 19 unit tests in `convex/lib/aiClient.test.ts` covering all routing branches
including the sk-*-in-AI_GATEWAY_API_KEY regression case (direct path).

**Remediation for affected self-host clients:** see
`docs/self-host/recall-empty-troubleshooting.md` — set `OPENAI_API_KEY`, redeploy,
run reindex mutation.

**References:** self-host support ticket 2026-05-18 , 2026-05-20 reindex PR #483,
Sigma task k17defa52nzyp7z03198ne9ay186ygss.

## [2.2.0] — 2026-05-07

### Added
- 4 fix-pattern MCP tools wrapping existing Convex backend functions:
  - `create_fix_pattern` — create a new validated fix pattern in the KB
  - `add_fix_attempt` — log a fix attempt against an existing pattern
  - `validate_fix` — promote a candidate fix to validated status
  - `link_issue_to_pattern` — link a GitHub issue to a fix pattern
- Schema exports for testing: `creatorSchema`, `severitySchema`, `flexArray` are now exported from `tools.ts`
- 41 new Zod input-validation unit tests (`mcp-server/src/__tests__/fix-pattern-tools-validation.test.ts`)

### Why
Enables the agent improvement cycle: orchestrators (Pi, Sigma, Eta, Chi, Iota, Psi, Victor, Phi) can now capitalize learnings via MCP rather than shelling out to `npx convex run fixPatterns:*`. Powers the `/capitalize-fix` skill and the `inject-fix-patterns` hook.

## [v2.1.1] — 2026-05-04

### Bug Fixes
- Defense-in-depth memoryIdSchema for briefingNotes linkedMemoryIds (closes #386, #387)
- Adds Zod regex validation at MCP boundary so wrong-table IDs get a clear error before reaching Convex validator
- Applies to both create_briefing_note and update_briefing_note tools
- 5 regression tests added in briefing-note-memory-id-validation.test.ts

### Refs
- Closes #386 (canonical), #387 (duplicate)
- Pattern reuse: PR #328 mark_as_read fix (m97ewrrqczew67kc6at3a59e7985ea7h)

## [v2.1.0] — 2026-04-25

### Added
- update_briefing_note MCP tool — partial update for briefing notes with RBAC (createdBy or system only)
- briefingNotes.updatedAt + briefingNotes.updatedBy schema columns (both v.optional, backward compatible)

### Refs
- Closes issue #333
- Mission k5708d9xxwj81v92e0x3hwv36985g4d7

## v11 — 2026-04-08

### New Features
- **Dynamic broadcast** — broadcast channel now queries profiles table instead of hardcoded list (#219)
- **7 new MCP tools** — block_task, add_task_dependency, get_mission, update_component, delete_component, search_components, update_recurring_task (#121-#127)
- **PR review webhook** — pull_request_review events auto-notify pilot via VantagePeers (#191)
- **82 MCP tools total** (up from 75)

### Bug Fixes
- Inline orchestrator enums replaced with z.string() (#149)
- McpServer version synced to 1.0.1 (#150)
- completionNote made required in complete_task (#153)
- update_profile fields made optional for partial updates (#154)
- Deduplicated missionPrioritySchema and componentTypeSchema (#172, #173)
- Schema comment corrected: errorLogs → issueStats (#217)

### Documentation
- README tool counts updated to 82, table count to 20
- Orchestrator roles documented including system RBAC bypass (#174)
- CONTRIBUTING.md org URL corrected (#160)
- Settings path corrected to ~/.claude.json (#175)
- Added convex/_generated/ to .gitignore (#179)

### Testing
- MCP smoke tests expanded from 75 to 82 tools
- Broadcast unit test updated for dynamic profiles
- Test reports committed to tests/

## v10 — Public Launch Cleanup — 2026-04-07

- PR #100: Deep repo cleanup for public launch
- Removed internal orchestrator instructions and person names from CLAUDE.md
- Fixed plugin license mismatch (MIT → FSL-1.1-Apache-2.0)
- Replaced `mcp__vantage-memory__*` with `mcp__vantage-peers__*` across all plugin files
- Fixed wildcard permissions in plugin/templates/settings.json
- Updated CONTRIBUTING.md and README.md with current tool and test counts
- Removed absolute internal server paths from docs

## v9 — README Rewrite + 3 New Tools — 2026-04-07

- PR #96: README rewritten for public consumption
- Added `get_memory` tool (fetch single memory by ID)
- Added `text_search` tool (BM25 full-text search)
- Added `hybrid_search` tool (RRF fusion of vector + BM25)
- Total tool count: 75

## v8 — MCP Smoke Tests Expanded to 75 — 2026-04-07

- PR #95: Expanded MCP smoke test suite from 29 to 75 tests (all 75 tools covered, 75/75 pass)
- PR #94: string-based API calls for all 75 tools
- PR #90: enforce-signature hook (portable across machines)
- PR #89: RAG integration tests (6/6 pass)
- PR #87: standalone MCP server, schema validators, soft_delete_memory

## v7 — Open Source Release — 2026-03-25

- README rewritten for public consumption (27 MCP tools documented)
- MCP integration tests: 29/29 covering all tools
- Convex unit tests: 34/34 with vitest + convex-test
- Added LICENSE (MIT), CONTRIBUTING.md, CHANGELOG.md
- Added .github templates (bug report, feature request, PR template)
- Added .env.example
- Package.json metadata (keywords, repository, engines, scripts)

## v6 — Schema Migration + Hardening — 2026-03-25

- Removed deprecated `to` field from messages table
- Made `channel` field required on messages
- Fixed `listMessages` return validator (missing `_creationTime`, `fromInstanceId`)
- Added `review` status to task lifecycle
- Task dependencies (`dependsOn`) with priority sorting
- Mandatory `completionNote` on task completion
- Global string-to-array tolerance for all MCP array fields (tags, participants, highlights, etc.)
- Cleaned up test data residue from MCP integration tests

## v5 — Multi-Instance Support — 2026-03-24

- Added `instanceId` to profiles, messages, and task claiming
- `set_summary` supports instance-level registration
- `check_messages` routes to role-level and instance-level recipients
- `fromInstanceId` on messages for sender identification
- `recipientInstanceId` on message receipts for instance routing

## v4 — Messaging with Receipts — 2026-03-23

- Replaced claude-peers with native messaging
- `send_message`, `check_messages`, `mark_as_read`, `list_messages` tools
- Channel-based routing: broadcast, role DM, instance DM, multi-target
- Per-recipient read receipts via `messageReceipts` table

## v3 — Tasks, Missions, Diary — 2026-03-22

- Task management: create, update, start, complete with `completionNote`
- Task dependencies (`dependsOn`) and priority sorting
- Review status in task lifecycle
- Missions: project grouping with lifecycle (brainstorm → complete)
- Daily diary entries with highlights and blockers
- Briefing notes for structured topic discussions
- RAG threshold fix for semantic search

## v2 — Profiles and Episodes — 2026-03-21

- Orchestrator profiles with static identity and dynamic session state
- Episodic memory (context → goal → action → outcome → insight)
- Severity levels for episodes (critical, major, minor)
- Memory graph relations (updates, extends, derives)

## v1 — Initial Release — 2026-03-20

- Core memory storage with 5 types (user, feedback, project, reference, episode)
- Semantic vector search via `@convex-dev/rag` and OpenAI embeddings
- Scoped namespaces (global, orchestrator/*, project/*)
- MCP server for Claude Code integration
- 8 database tables on Convex
