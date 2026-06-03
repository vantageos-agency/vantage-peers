# Changelog

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
