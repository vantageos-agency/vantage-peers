# Changelog

## [Unreleased]

### Added
- **B4 RAG namespace team/<orgId> tenant enforcement** — `bearerAuthMiddleware` gains a new layer 2.5: Clerk JWTs with an `org_id` claim are verified via JWKS (`CLERK_DOMAIN/.well-known/jwks.json`, 10-min in-process cache) and resolve to `scopeProfile="team-member"` with `namespaceRead/WritePrefixes=["team/<orgId>"]`. Cross-tenant namespace access is rejected before any Convex call. New `convex/memoriesScoped.ts` provides `listMemoriesScoped` / `storeMemoryScoped` Convex functions with identity-level `AUTH_NAMESPACE_DENIED` enforcement. Tests: `mcp-server/test/team-namespace-cross-tenant.test.ts` (16 predicate tests), `convex/__tests__/auth-namespace-deny.test.ts` (9 Convex-layer deny tests). Task `k17528bya5wnbxm0x3cebrf9vh8915n0`, mission `k5779qbxhwrfjmj02t31yvehns8911jp`. PR #915.
- **test(security): clerk org_id↔clerkOrgSlug parity + no-org→master guard** — `convex/__tests__/clerk-org-id-slug-parity.test.ts` (+422 LoC, 9/9 PASS, 933ms). PR #915 (B4 RAG namespace) Eta APPROVED follow-up split — 2 non-blocking MINOR items. TEST 1 asserts namespace tenant key derived by `auth.ts` (`team/${org_id}`) resolves through `memoriesScoped.resolveOrgId` to the SAME identifier on both enforcement layers (3 sub-assertions including MISMATCH DETECTION documenting fail-closed over-denial hazard). TEST 2 asserts no-org regular team member CANNOT bypass MCP boundary to gain cross-tenant master access — `AUTH_NAMESPACE_DENIED` at MCP layer for `team/<other-org>` writes (4 sub-assertions covering Convex-direct master fallback + MCP `checkNamespaceWrite/Read` denial + master-scope context positive case). No production code touched (`mcp-server/src/auth.ts`, `convex/memoriesScoped.ts`, `convex/schema.ts` untouched). Identity mocked via `t.withIdentity({...})` — no real Clerk hit. Source: PR #915 c547dc2 Eta APPROVED comment. Task `k17539hq2p3gxq5d0h9d02sd3d891800`.
- **PR-F — `bulk_complete_tasks` MCP tool** — bulk-close cron-spam tasks with dry-run-default safety and RBAC gate (PR-F).
- **PR-J — Tool descriptions sync canonical 114-tool snapshot + 15 list_* paging qualifiers** — new fleet-quality gate `mcp-server/src/__tests__/tools-descriptions-canonical.test.ts` (4 it() blocks): Section A inventory floor ≥100 tools, Section B description length floor ≥60 chars, Section C placeholder ban (`/\b(TODO|FIXME|XXX|TBD)\b/` case-sensitive + `/\b(placeholder|coming soon)\b/i` prose-only), Section D category contracts (list_* tools MUST mention `limit` + paging qualifier `cap` / `default 20` / `default 100`; recall-class tools MUST carry verbatim VP-Sources doctrine from PR-H). T-RED `259a8d4` surfaced 15 list_* tools missing the paging qualifier (`list_episodes`, `list_memories`, `list_peers`, `list_broadcast_status`, `list_tasks`, `list_tasks_by_mission`, `list_missions`, `list_diaries`, `list_briefing_notes`, `list_recurring_tasks`, `list_mandates`, `list_repo_mappings`, `list_issues`, `list_fix_patterns`, `list_errors`) — VP-Sources doctrine 0 violations (5/5 recall-class tools already carry PR-H doctrine, zero drift). T-GREEN `41944dc` appends canonical paging-qualifier sentence (`Default limit N. cap M.`) to all 15 descriptions, mirroring PR-A/B/C/E precedent — args schemas unchanged (`list_broadcast_status` already had `limit: max(200).optional()` line 3183; only description string lacked the qualifier). Tests: 4/4 PASS canonical + 5/5 PASS PR-H regression (`tools-descriptions.test.ts`) + 6/6 PASS chatgpt-annotations regression — total 15/15 zero regression. VP mission `k571gcctka8mq5jbkgpj0a0b2n892ctg` (VP-MCP top level Bloc A, 10th of 10 PRs), audit section 27. T-RED `259a8d4` · T-GREEN `41944dc`.
- **PR-I — `improvisation_digest` weekly digest query + MCP tool** — V1 Option C scanning VP tasks/messages/memories for durable-artifact fleet/state claims missing VP-Sources footer (ADVISORY-only). Convex query `improvisationDigest:scanWindow` + MCP tool `improvisation_digest` (`readOnlyHint=true`, `openWorldHint=false`, `destructiveHint=false`). Args: `windowDays` (default 7) + optional `orchestrators` array. Returns `{ countsByOrch, countsByCategory, samples[] }`. Detection heuristic: Eta A5 scope filter (excludes `system`/`cron-*`/webhook entries); flags records with a durable-artifact token (commit SHA, PR#, Convex ID, decisive verb) and no `VP-Sources:` footer. T-RED `cd6cda3`, T-GREEN `b9414dc`. Mission `k571gcctka8mq5jbkgpj0a0b2n892ctg` (VP-MCP top level Bloc A). Also fixes T-GREEN friction: annotation was temporarily set `readOnlyHint: false` to pass the hardcoded `READ_ONLY_TOOLS` allowlist in `chatgpt-tool-annotations.test.ts`; this PR-I doc commit adds `"improvisation_digest"` to that allowlist and flips the annotation to the semantically correct `readOnlyHint: true`. Tests: chatgpt-tool-annotations 6/6 PASS, improvisation_digest.tool.test 2/2 PASS, improvisationDigest.test 7/7 PASS.
- **PR-H — VP-Sources doctrine embedded in 5 tool descriptions** — `recall`, `hybrid_search`, `text_search`, `list_briefing_notes`, and `search_briefing_notes_by_keyword` now carry two verbatim advisory doctrine substrings appended as separate paragraphs after each tool's existing description. Substring 1: "VP-Sources doctrine: MUST be called before any factual claim about fleet state, audits, dette tooling, mission/task/client status, incident history, doctrine references." Substring 2: "Cite returned ids in the answer footer as 'VP-Sources: recall(\"<q>\")→[ids] | none-needed:<reason>'.". Doctrine is advisory-only — no hook blocks on absence; intentional design so client implementations can adopt it gradually. Client LLMs read the doctrine at tool-list time because it is embedded inline in the description field. New exported constants in `mcp-server/src/tools.ts`: `RECALL_TOOL_DESCRIPTION`, `HYBRID_SEARCH_TOOL_DESCRIPTION`, `TEXT_SEARCH_TOOL_DESCRIPTION`, `LIST_BRIEFING_NOTES_TOOL_DESCRIPTION`, `SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION`. Tests: 5 new snapshot tests in `mcp-server/src/__tests__/tools-descriptions.test.ts` asserting both doctrine substrings are present in each description constant; full suite 2010/2010 zero regression. Mission `k571gcctka8mq5jbkgpj0a0b2n892ctg` (VP-MCP top level Bloc A), audit sections 27+28.4, doctrine source Eta Q1 msg `k977bvf03qzas7v7g0zqca9c7n8937zh`. T-RED `0b4dc84`, T-GREEN `908fd67`.
- **PR-G — `block-delete-on-prod.py` hook pull from VR canonical + presence smoke** — vantage-memory workspace now ships the fleet-canonical `block-delete-on-prod` PreToolUse hook (RULE #30 Day 109 sha256 alignment). Hook blocks destructive MCP ops (`delete_task` / `delete_mission` / `delete_message`) before they hit Convex. New smoke `qa/smoke-block-delete-on-prod-presence.sh` verifies presence on disk AND sha256 match vs VR `contentHash` (orchestrator/CI passes `EXPECTED_SHA256` from `mcp__vantage-registry__get_hook_content`). Hook path force-added (`.claude/hooks/` is gitignored repo-wide); CI / cloned workspaces now ship with the RULE #30-pinned version. Local sha256 = VR contentHash = `c5b99cf7c76829f89cfe9eb6a1a76bcaa34c2498cf98466d572cf2abef72d4c9`. VP mission `k571gcctka8mq5jbkgpj0a0b2n892ctg` (VP-MCP top level Bloc A, PR-G). Audit ref `analysis/mcp-crud-baseline-vp-audit-2026-06-14.md` section 14. T-RED commit `d9feb64`, T-GREEN `b260dc5`.

### Fixed
- **CRITICAL — `list_memories` + `list_episodes` MCP tools were silently returning `items: []` on every call** — Day-114 audit (`projects/vantage-peers/mcp-pagination-audit-day114.md`) surfaced the bug: both handlers read `memories?.page` from the Convex `listMemories` return shape `{value, continueCursor, isDone}`. `page` is undefined → `items: []` was returned on EVERY call regardless of seeded data. `nextCursor` was never emitted. Functional breakage, not pagination drift. **Invalidates PR-J's "19/19 covered" claim** — the envelope-format check only verified wrapper shape, not the data extraction path (envelope-coverage tests must use seeded-data assertions going forward: insert N rows → assert `items.length === N`). Patch (`mcp-server/src/tools.ts`): `list_episodes` handler L2161-2188 + `list_memories` handler L2515-2547 now read `memories.value` (not `?.page`), read `continueCursor` + `isDone`, and emit `{items, nextCursor}` envelope via `encodeCursor({backendCursor})` — same shape the decode path at L2476 / L2129 was already expecting (the bug was encode/emit asymmetric to decode). Mirrors PR-A/B/C/E precedent (shared `mcp-server/src/paging.ts`). Test coverage: NEW `mcp-server/src/__tests__/list_memories_episodes_pagination.test.ts` (11/11 PASS, 5 list_memories + 6 list_episodes — seeded-data assertion across no-pagination / first-page-with-cursor / full-pagination-chain / empty-backend). RED-before evidence: 8 failed with `AssertionError: result must have an items array: expected false to be true` + `TypeError: Cannot read properties of undefined (reading 'length')`. GREEN-after: 11/11 PASS. Full mcp-server suite zero regression: 27 files / 380 tests PASS. Convex suite zero regression: 35 files / 328 tests PASS. tsc baseline delta = 0 vs 176. Zero `convex/` modification (backend was already correct; only MCP response assembly bug). Mission `k57bxpa2wcp7f8xdwne8g3dpfx89f27k` (vp-mcp-pagination-fix-day114-v1). Tasks T0 `k17cxmgxkfvakq3kse87c82stn89ecnn` + T1 `k170vgkh5ftj3bveea8wwc8yv189erwb`. Pi-dispatched audit task `k17a2vygmfbhwc8tkyxwft28c989egrc` + Laurent verbatim 2026-06-27 "crééé les taches pour fixer ça sans délai!!!".
- **Day-101 sweep — `briefingNotes.get` + `missions.get` full-doc returns-validators now include `orgId`** — Eta-flagged during PR #973 review (PR #973 fixed tasks-table only; identical #360 drift was latent in 2 other tables). `convex/briefingNotes.ts:51` (`get` handler) + `convex/missions.ts:159` (`get` handler) each now declare `orgId: v.optional(v.string())`. Counter-to-zero proof: `grep -n "orgId" convex/schema.ts` enumerates 3 orgId-bearing tables (missions L210, tasks L254, briefingNotes L306); all 3 now have orgId-clean full-doc returns validators (`tasks` fixed in #973, `briefingNotes` + `missions` fixed here, `list` handlers on all 3 deliberately omit returns validators so no 500 risk). `mandates` and `missionTemplates` have no orgId field — not at risk. Identical class to vantage-registry #226 and vantage-peers #973. Test coverage: `convex/__tests__/briefingNotes.fullDocReturnsValidator.test.ts` (5/5 PASS, T1-T5) + `convex/__tests__/missions.fullDocReturnsValidator.test.ts` (6/6 PASS, T1-T6 including updateStatus path). RED-before evidence: 5 failures with `Return value validation failed for query "briefingNotes:get"/"missions:get": Validator error: Expected one of object, null, got {..., "orgId":"iris-rh",...}`. GREEN-after: 11/11 PASS. Full convex/__tests__ suite zero regression (35 files / 328 tests PASS). tsc baseline delta = 0 (176 errors pre + post). Task `k17a8k7me042ddp3ks76h3y2fd89dswf` (Eta-dispatched ROOT-FIX Day-101).
- **fix(tasks): full-doc returns-validators now include `orgId` — fleet 500 blocker resolved** — `convex/tasks.ts` `taskFullValidator` (line 126) + `get` inline returns (line 215) + `getById` inline returns (line 255) each now declare `orgId: v.optional(v.string())`. PR #360 commit `44f0a93` (`feat(scope): client_org_mapping table + withOrgScope helper`) added `orgId: v.optional(v.string())` to the tasks-table schema but the three full-doc returns-validators were not updated — Convex returns-validator threw `Return value validation failed for query "tasks:getById": Validator error: Expected one of object, null, got {...,"orgId":"iris-rh",...}` so every `get_task` / `complete_task` / `update_task` against a multi-tenant doc returned 500. Impact: `complete_task` and `update_task` (which share `taskFullValidator`) AND `get` / `getById` (which had inline returns) blocked evidence-bound closure fleet-wide (Pi, Omega, Xi, Theta, Sigma). Identical class to vantage-registry #226. Repro evidence cited by Omega: `get_task k17ejy6w / k172g0kf / k176rerqn → 500`. Patch is `v.optional(v.string())` (forward + backward compatible — pre-#360 docs without the field still pass). New regression `convex/__tests__/tasks.fullDocReturnsValidator.test.ts` (9/9 PASS, 926ms) covers tasks with-and-without `orgId` on all 3 surfaces + list_tasks projection unchanged. Existing tasks-suite zero regression: `tasks.list_tasks_exclude_cron.test.ts` (13/13), `tasksMutationConvexErrors.test.ts` (11/11), `tasks.bulk_complete.test.ts` (11/11). Task `k173wtkytmc4f8me1rkv977v0589dnrj` (Pi-dispatched URGENT).
- **Day 108 — VP mutations no longer mask errors as generic "Server Error"** — `convex/tasks.ts` (14 throws) + `convex/lib/auth.ts` (2 throws) now emit `ConvexError("<CODE>: <message> :: <details-json>")` with string payload so the Convex cloud privacy guard no longer anonymizes to `errorMessage="Server Error"`. New codes: `TASK_NOT_FOUND`, `RBAC_DENIED`, `TASK_START_BLOCKED` (the Hephaistos `start_task` symptom — caller already has an in_progress task), `DEPENDENCY_NOT_DONE` (newly enforced — `start` previously allowed starting tasks whose `dependsOn` chain was unsatisfied), `COMPLETION_NOTE_REQUIRED`. Repro test in `convex/__tests__/tasksMutationConvexErrors.test.ts` (17/17 PASS) — asserts the original Hephaistos scenario surfaces `TASK_START_BLOCKED:` not "Server Error". Existing suite 541/541 PASS. Mission `k578wphazwhxamggbxnn2wr5r98911vr` (Sigma rattrapage Day 108). Follow-up queued: mcp-server `parseConvexError` / `mcpConvexError` cleanup so callers can move off string-prefix parsing.

### Added
- **PR-E — `list_tasks` `excludeAutoGenerated` filter (vantage-peers-mcp@2.13.0 target)** — new optional `excludeAutoGenerated: boolean` arg on the `list_tasks` Convex query and MCP tool. When `true`, filters out tasks where `createdBy` matches `/^cron-/i` (dash mandatory — `cron-bot` is filtered, `cronus` is not) **or** `title` matches `/^\/?check-messages$/i` (whole-string match, optional leading slash, case-insensitive). Default `false` — omitting the arg or passing `false` returns all tasks unchanged, preserving full backward-compatibility with all existing callers. Filter applied in-memory in the `list` query handler after existing filters (`createdBy`, `updatedSince`, `createdBefore`) and before `filterByOrgScope` and envelope assembly. **Trade-off**: post-filter pages may be smaller than `limit` because filtered rows do not count toward limit — acceptable given the cron-spam catalog is small and narrowly targeted. MCP tool exports `LIST_TASKS_TOOL_DESCRIPTION` (description string mentions `excludeAutoGenerated` with usage hint) and `listTasksArgsSchema` (zod). Use case: "Pi cron-spam queue cleaning" — closes audit §13 (152 cron-spawned tasks polluting Pi's queue). Tests: 7 new in `convex/__tests__/tasks.list_tasks_excludeAutoGenerated.test.ts` + 2 new in `mcp-server/src/__tests__/list_tasks.tool.test.ts` (9/9 GREEN); full suite 2014/2056 zero regression. VP mission `k571gcctka8mq5jbkgpj0a0b2n892ctg` (VP-MCP top level Bloc A), audit section 13, RED `eb78cfa`, GREEN `74dea44`.

### Changed
- **PR-C — `list_repo_mappings` envelope safety hardening (vantage-peers-mcp@2.13.0 target)** — extends the PR-A/PR-B paging helper reuse pattern (shared `mcp-server/src/paging.ts`) to `list_repo_mappings`. Convex `githubRepoMapping.list` now returns `{ items, nextCursor }` envelope (was flat array); default `limit` lowered to 20 (was 50), capped at 200 (was unbounded). `fields='lite'` projects to `{_id, _creationTime, repo, orchestrator, project}` (5 keys; excludes `active`, `lastDeployedSHA`, `lastDeployedAt`). Default `fields='full'` returns all schema fields. Opaque base64 `cursor` encodes `{time, id}` to survive same-millisecond inserts; hybrid cursor decode in MCP handler preserves S3.3 B8 old-format `{createdBefore}` cursors by decoding and forwarding as `createdBefore` (back-compat for S3.3 B8 batch 2 callers). `createdBefore` arg kept on the Convex query for the same reason. MCP tool exports `LIST_REPO_MAPPINGS_TOOL_DESCRIPTION` and `listRepoMappingsArgsSchema` (zod: `limit` 1–200, optional `cursor` string, optional `fields` enum `'lite'|'full'`, plus existing filters). Tests: 7 new in `convex/__tests__/githubRepoMapping.list_repo_mappings.test.ts` + 2 new in `mcp-server/src/__tests__/list_repo_mappings.tool.test.ts` (9/9 GREEN, full suite 2005/2047 zero regression). Eta non-blocking follow-up `k17fbpf4` + fix-pattern `m97c0z53`: over-fetch + walk-by-id strategy can dead-end deep paging past ~90 rows; catalogues are small, fix is queued. VP mission `k571gcctka8mq5jbkgpj0a0b2n892ctg` (VP-MCP top level Bloc A), audit section 9, RED `eed6ae5`, GREEN `4ddca2b`.
- **PR-B — `list_components` envelope safety hardening (vantage-peers-mcp@2.13.0 target)** — extends the PR-A paging helper reuse pattern (shared `mcp-server/src/paging.ts`) to `list_components`. Convex `components.list` now returns `{ items, nextCursor }` envelope (was flat array); default `limit` lowered to 20 (was 100), capped at 200 (was unbounded). `fields='lite'` projects to `{_id, _creationTime, name, type, team}` (was no-op — returned full row regardless). Opaque base64 `cursor` encodes `{creationTime, id}` to survive same-millisecond inserts; hybrid cursor decode in MCP handler preserves S3.3 B8 old-format `{createdBefore}` cursors by decoding and forwarding as `createdBefore` (back-compat for S3.3 B8 callers). `createdBefore` arg kept on the Convex query for the same reason. MCP tool exports `LIST_COMPONENTS_TOOL_DESCRIPTION` and `listComponentsArgsSchema` (zod: `limit` 1–200, optional `cursor` string, optional `fields` enum `'lite'|'full'`, plus existing `type`/`team` filters). Tests: 7 new in `convex/__tests__/components.list_components.test.ts` + 2 new in `mcp-server/src/__tests__/list_components.tool.test.ts` (9/9 GREEN, full suite 1996/2038 zero regression). VP mission `k571gcctka8mq5jbkgpj0a0b2n892ctg` (VP-MCP top level Bloc A), audit section 9, RED `cb8b8fa`, GREEN `39f8d08`.
- **PR-A — `list_bus` envelope safety hardening (vantage-peers-mcp@2.13.0 target)** — extends the S3.3 B8 follow-up batch 1 cursor rollout (which gave `list_bus` opaque cursor support) with strict defaults and actual `fields=lite` projection. Convex `businessUnits.list` now returns `{ items, nextCursor }` envelope (was flat array); default `limit` lowered to 20 (was 50), capped at 200 (was unbounded). `fields='lite'` projects to `{_id, _creationTime, name, status, orchestratorId}` (was no-op since v2.4.12 — accepted the arg without applying projection). Opaque `cursor` now encodes `{creationTime, id}` to survive same-millisecond inserts. MCP-server `list_bus` tool exports `LIST_BUS_TOOL_DESCRIPTION` and `listBusArgsSchema` for snapshot testing. New shared helper `mcp-server/src/paging.ts` (`applyPagingDefaults`, `pagingArgsSchema`, `DEFAULT_PAGING`) reusable for PR-B `list_components` and PR-C `list_repo_mappings`. Tests: 7 new in `convex/__tests__/businessUnits.list_bus.test.ts` + 2 new in `mcp-server/src/__tests__/list_bus.tool.test.ts` (9/9 GREEN, full suite 1987/2029 zero regression). VP mission `k571gcctka8mq5jbkgpj0a0b2n892ctg` (VP-MCP top level Bloc A). Audit ref `analysis/mcp-crud-baseline-vp-audit-2026-06-14.md` section 9.
- **Day 108 OKF Phase 2 B3 — `export_okf_bundle` generalized (drop `project/elpi-corp` hard lock)** — `assertCanExportNamespace` in `convex/okfBundleNode.ts` no longer rejects non-Phase-1 namespaces; any non-empty prefix is accepted as long as identity-attached callers match the namespace tail (cross-tenant deny preserved). Path-traversal segments (`..`) are rejected for defence-in-depth. Multi-tenant `team/<orgId>/*` and other `org/<slug>` namespaces can now export their own bundles, unblocking VP Cloud Dashboard tenant Settings UI (F8). MCP tool `export_okf_bundle` description + Zod arg schema updated. Mission `k5779qbxhwrfjmj02t31yvehns8911jp`, task `k17f3407sg7cn6gswn5qs9j5b5891581`. Tests: `convex/__tests__/okfBundleExportGeneralize.test.ts` 8/8 PASS (including `project/elpi-corp` regression case).

### Added
- **Day 108 OKF Phase 2 B2 — `import_okf_bundle` MCP tool + Convex action (mutation)** — New action `okfBundleNode:importOkfBundle` accepts `{bundleUrl|storageId, targetNamespace, mode:"dry-run"|"merge"|"replace", idempotencyKey?}` and returns `{ imported:{memories,briefings,tasks}, skipped, conflicts[] }`. Pipeline: `assertCanImport` (delegates to fail-closed `assertCanExportNamespace` from #888 iter-2, same null-identity / no-org → AUTH_NO_IDENTITY / AUTH_NO_ORG guard applied to writes) → source resolution (storageId XOR bundleUrl, SSRF-gated reused) → `unpackTarball` → `validateBundle` (must pass before any write) → per-entry `parseEntry` → content-equality dedup via 3 internal queries on V8 side (`_findMemoryByContent` / `_findBriefingByTitleAndContent` / `_findTaskByTitleAndDescription`) → insert via 3 internal mutations (`_insertImportedMemory` / `_insertImportedBriefing` / `_insertImportedTask`). `dry-run` short-circuits before any write; `merge` inserts new + skips dedup-hits; `replace` reserved for a follow-up PR. Wired as MCP tool `import_okf_bundle` (`readOnlyHint=false`) in `mcp-server/src/tools/importOkfBundle.ts`. Closes OKF Phase 2 spec end-to-end (export ↔ validate ↔ import). Mission `k5779qbxhwrfjmj02t31yvehns8911jp`, task `k17fja9v7pgnf25yvzkwrj5ch5891bb3`. Tests: `convex/__tests__/okfBundleImport.test.ts` 4/4 PASS (dry-run / merge dedup / idempotency / cross-tenant deny).
- **Day 108 OKF Phase 2 B1 — `validate_okf_bundle` MCP tool + Convex action (read-only)** — New action `okfBundleNode:validateOkfBundle` accepts `{bundleUrl|storageId}`, fetches and untar's the bundle, runs the pure `validateBundle()` validator from `convex/okfValidator.ts` (RFC §3.5), and returns `{ valid, schemaVersion, errors?, stats: {memoryCount, briefingCount, taskCount} }`. Read-only — never mutates the DB. Wired as MCP tool `validate_okf_bundle` (`readOnlyHint=true`) in `mcp-server/src/tools/validateOkfBundle.ts`. Unblocks import preview UX in the VP Cloud Dashboard (mission `k5779qbxhwrfjmj02t31yvehns8911jp`, task `k1796g7g7y03gn9rd6z7psenk98910vt`). Tests: `convex/__tests__/okfBundleValidate.test.ts` 5/5 PASS.
- **Day 98 F4 — webhook `issue_comment` Bridge-only path** — `convex/http.ts` webhook handler for `issue_comment` events now routes exclusively through the Bridge tenant path. Prevents double-processing on multi-tenant deployments. PR #796, commit `f0c133c`.
- **Day 98 F3 — stub-aware guard on webhook cron hook** — `convex/hooks.ts` cron now includes a stub-presence guard so stubs registered during tests do not fire production webhook paths. PR #796, commit `f0c133c`.
- **DOCS-CONTEXT-LOOP (RULE #25)** — Docs-lockstep discipline now live on this repo. Any PR touching tools, API, or install paths must update `README.md` + `CHANGELOG.md` in the same PR. Exemptions require explicit `docs-skip: <reason>` in PR body.
- **Tool count reaches 116** — `validate_okf_bundle` (B1) and `import_okf_bundle` (B2) added in Day 108 OKF Phase 2 push, lifting the surface from 114 to 116.
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
