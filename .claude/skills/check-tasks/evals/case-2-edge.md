# Case 2 — Edge (mission-scoped + show more)

## Input
User prompt: `tasks for mission k4z1m9bb00cc11dd22ee33ff44gg55hh, show more`.

## Expected behavior
- Detect MISSION-SCOPED intent (mission id present).
- Single call to `mcp__vantage-peers__list_tasks_by_mission` with `missionId="k4z1m9bb00cc11dd22ee33ff44gg55hh"`, `fields="lite"`, `limit=50` (raised from 20 because "show more").
- Render compact table with `TASKS (mission k4z1m9bb) —` header.

## Hooks pre-satisfied
- Envelope cap respected: limit=50 with `fields=lite` still stays under 60 KB for typical title lengths.
- No status="all" passed.

## PASS criteria
Single mission-scoped call, no fallback to `list_tasks`, output header references the mission id (first 8 chars), no envelope truncation.
