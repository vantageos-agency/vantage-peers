# Changelog

## [2.2.0] - 2026-05-07

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

## [v2.1.1] - 2026-05-04

### Bug Fixes
- Defense-in-depth memoryIdSchema for briefingNotes linkedMemoryIds (closes #386, #387)
- Adds Zod regex validation at MCP boundary so wrong-table IDs get a clear error before reaching Convex validator
- Applies to both create_briefing_note and update_briefing_note tools
- 5 regression tests added in briefing-note-memory-id-validation.test.ts

### Refs
- Closes #386 (canonical), #387 (duplicate)
- Pattern reuse: PR #328 mark_as_read fix (m97ewrrqczew67kc6at3a59e7985ea7h)

## [v2.1.0] - 2026-04-25

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

## v10 — Public Launch Cleanup (2026-04-07)

- PR #100: Deep repo cleanup for public launch
- Removed internal orchestrator instructions and person names from CLAUDE.md
- Fixed plugin license mismatch (MIT → FSL-1.1-Apache-2.0)
- Replaced `mcp__vantage-memory__*` with `mcp__vantage-peers__*` across all plugin files
- Fixed wildcard permissions in plugin/templates/settings.json
- Updated CONTRIBUTING.md and README.md with current tool and test counts
- Removed absolute internal server paths from docs

## v9 — README Rewrite + 3 New Tools (2026-04-07)

- PR #96: README rewritten for public consumption
- Added `get_memory` tool (fetch single memory by ID)
- Added `text_search` tool (BM25 full-text search)
- Added `hybrid_search` tool (RRF fusion of vector + BM25)
- Total tool count: 75

## v8 — MCP Smoke Tests Expanded to 75 (2026-04-07)

- PR #95: Expanded MCP smoke test suite from 29 to 75 tests (all 75 tools covered, 75/75 pass)
- PR #94: string-based API calls for all 75 tools
- PR #90: enforce-signature hook (portable across machines)
- PR #89: RAG integration tests (6/6 pass)
- PR #87: standalone MCP server, schema validators, soft_delete_memory

## v7 — Open Source Release (2026-03-25)

- README rewritten for public consumption (27 MCP tools documented)
- MCP integration tests: 29/29 covering all tools
- Convex unit tests: 34/34 with vitest + convex-test
- Added LICENSE (MIT), CONTRIBUTING.md, CHANGELOG.md
- Added .github templates (bug report, feature request, PR template)
- Added .env.example
- Package.json metadata (keywords, repository, engines, scripts)

## v6 — Schema Migration + Hardening (2026-03-25)

- Removed deprecated `to` field from messages table
- Made `channel` field required on messages
- Fixed `listMessages` return validator (missing `_creationTime`, `fromInstanceId`)
- Added `review` status to task lifecycle
- Task dependencies (`dependsOn`) with priority sorting
- Mandatory `completionNote` on task completion
- Global string-to-array tolerance for all MCP array fields (tags, participants, highlights, etc.)
- Cleaned up test data residue from MCP integration tests

## v5 — Multi-Instance Support (2026-03-24)

- Added `instanceId` to profiles, messages, and task claiming
- `set_summary` supports instance-level registration
- `check_messages` routes to role-level and instance-level recipients
- `fromInstanceId` on messages for sender identification
- `recipientInstanceId` on message receipts for instance routing

## v4 — Messaging with Receipts (2026-03-23)

- Replaced claude-peers with native messaging
- `send_message`, `check_messages`, `mark_as_read`, `list_messages` tools
- Channel-based routing: broadcast, role DM, instance DM, multi-target
- Per-recipient read receipts via `messageReceipts` table

## v3 — Tasks, Missions, Diary (2026-03-22)

- Task management: create, update, start, complete with `completionNote`
- Task dependencies (`dependsOn`) and priority sorting
- Review status in task lifecycle
- Missions: project grouping with lifecycle (brainstorm → complete)
- Daily diary entries with highlights and blockers
- Briefing notes for structured topic discussions
- RAG threshold fix for semantic search

## v2 — Profiles and Episodes (2026-03-21)

- Orchestrator profiles with static identity and dynamic session state
- Episodic memory (context → goal → action → outcome → insight)
- Severity levels for episodes (critical, major, minor)
- Memory graph relations (updates, extends, derives)

## v1 — Initial Release (2026-03-20)

- Core memory storage with 5 types (user, feedback, project, reference, episode)
- Semantic vector search via `@convex-dev/rag` and OpenAI embeddings
- Scoped namespaces (global, orchestrator/*, project/*)
- MCP server for Claude Code integration
- 8 database tables on Convex
