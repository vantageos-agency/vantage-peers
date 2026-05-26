# Changelog

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
