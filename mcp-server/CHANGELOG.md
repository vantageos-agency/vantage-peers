# Changelog

## v2.3.4 — 2026-05-28

**Security fix** — DCR (Dynamic Client Registration) self-registration now defaults to tenant-scope only. Master scope requires explicit admin authorization (`ADMIN_DCR_TOKEN` / `BEARER_SECRET_MASTER` env var). Closes beta blocker for Marie/Iris RH onboarding identified in VP Cloud audit Day 84.

Changes:
- `convex/oauth.ts`: `registerPublicClient` now explicitly rejects `scopeProfile="master"` with a `ScopeViolation` error. Previously only the HTTP server enforced this; the Convex-layer was bypassable via direct internal call.
- `mcp-server/src/auth.ts`: bearer layer 3 (DCR token path) no longer maps `mcp:full` scope string to `scopeProfile="master"`. DCR tokens now always resolve to `client-generic` (deny-by-default). The `mcp:full` label in the legacy `oauthTokens` table was a scope label, not an authorization grant.
- `convex/oauthDcr.ts`: added security documentation clarifying the legacy table is no longer an escalation path; the auth middleware fix is the primary gate.

Tests: 5 new Convex security tests (`convex/oauth-dcr-security.test.ts`) + 5 new MCP scope enforcement tests (`mcp-server/src/__tests__/dcr-scope-enforcement.test.ts`), 0 regression on existing suites.

VP task: k17218rvqyncs1v6rwj3qdzfsn87jj4n. Beta unblock chain: DCR fix → 5 quick wins onboarding (seed-profiles + marie-iris-rh client + README VP Cloud + runbook + email).

## v2.3.2 — 2026-05-28

**Hotfix** — Expose `fields="lite"` + `status` array/aliases in MCP tool schemas (Day 82 sprint gap).

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
