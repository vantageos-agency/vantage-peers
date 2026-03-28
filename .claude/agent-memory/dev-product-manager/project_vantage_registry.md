---
name: VantageRegistry project context
description: Internal AI component registry — architecture, data state, roadmap status, and key open questions as of 2026-03-26
type: project
---

VantageRegistry is a Convex-backed internal component registry for ElPi Corp's AI agent system.

**Current state (2026-03-26):** 144 agents, 314 skills, 18 teams, 15 plugins, 11 hooks. All descriptions and team assignments are clean after a data repair cycle. Prompts and templates tables are empty (0 records each).

**MCP server:** 24 tools covering full CRUD across all tables. Already in use by Claude Code agents.

**Why:** Central source of truth for all agent/skill definitions. Enables agent self-lookup, skill discovery, and eventual dependency tracking.

**How to apply:** When scoping registry features, the primary audience is internal developers and AI agents — not end users. Demo features (UI, search) are for prospect demos. The backend is already sound; the gap is human-facing discoverability.

**Roadmap phases:**
- Phase 1 (by 2026-04-02): Read-only web dashboard, client-side search, schema bug fixes
- Phase 2 (by 2026-04-26): Version history, VantagePeers integration (agent self-registration at session start), computed team counts, full-text search
- Phase 3 (by 2026-06-26): Usage telemetry, public plugin marketplace, semantic search, CLI

**Open questions not yet resolved:**
1. Registry ownership — self-service vs. review workflow?
2. Demo audience — technical or non-technical buyers?
3. Are prompts/templates actually in use?
4. Web UI — public or authenticated?
5. Versioning model — auto-increment, developer-assigned semver, or content hash?

**Key schema bugs still open (not yet fixed):**
- Prompts and templates upsert by name only (silent cross-team overwrite)
- Hooks missing content-size guard (C2)
- Sync script has hardcoded absolute path for one user (C3)
- `get_stats` uses 5 full table scans (W6)
