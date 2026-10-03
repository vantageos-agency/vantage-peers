---
section: Fixed
---
- **`diary:list` no longer answers an anonymous caller with an empty success, and no longer reads the table before the roster filter.** An anonymous caller is raised at (`RBAC_DENIED`, naming `diary:list`); a signed-in caller with no organisation gets `{ refused: true, items: [] }` (both dashboard consumers read it through `readList`); an organisation member is served its own roster's rows through `by_orchestrator_date`, bounded per orchestrator, so another tenant's volume can no longer starve its page. The fleet master is unchanged (bare array). The `list_diaries` MCP tool reports a refusal instead of coalescing it to an empty list.
