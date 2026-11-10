---
section: Changed
---
- **Three identity fields name where their value comes from (Cloud MCP; task k17a9k0qneagqkp4wsp486xbh58hx7nj).** `list_tasks_by_mission.createdBy` and `list_diaries.createdBy` now say the value is an agent's name as `list_peers` lists it (your own is `whoami`'s `agent_name`), or `user:<subject>` for a person; `get_github_owner_bindings.unprovenCursor` names the `unprovenNextCursor` a previous `get_github_owner_bindings` call returned. Closes mcp-doctor C-40 inputs-sourced (3 red of 93 tools). Description text only; no argument, behaviour or contract change. Test: `mcp-server/test/field-description-schema-agreement.test.ts` (per-field pins and a class sweep mirroring the doctor's criterion).
