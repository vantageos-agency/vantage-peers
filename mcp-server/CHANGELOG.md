# Changelog

## [2.4.13] — 2026-06-02 — Post-public republish: attribution + CHANGELOG day-numbers + RULE #7 narrative scrub

Repository visibility flip to PUBLIC on 2026-06-02 (mission D62 `k57e4t21sr55rhz8ng554eseb987wvh3`). This patch republishes the npm package so the published README + CHANGELOG + attribution match the now-public source.

No runtime / API / schema changes. Documentation + metadata only.

What changed since v2.4.12:
- `mcp-server/package.json`: author restructured to "VantageOS AI Orchestrator Team" with contributors block (Pi, Laurent Perello, ElPi Corp). Dependency `@vantageos/mosaic@^0.1.2` added for Phase 1 Mosaic groundwork (PR #605, server-side createMosaicResource API ready for Phase 2 primitive swap).
- `mcp-server/CHANGELOG.md`: version headers simplified to `X.Y.Z — YYYY-MM-DD` (Day N anchors dropped per Laurent verdict 2026-06-02 — dates are self-explanatory, day numbers added noise). Narrative client-name mentions (Marie/Iris RH/Cédric Delport) genericized to "early-access RH cohort" / "self-host incident" per RULE #7 pre-public scrub.
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
