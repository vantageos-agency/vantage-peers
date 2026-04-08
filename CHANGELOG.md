# Changelog

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
