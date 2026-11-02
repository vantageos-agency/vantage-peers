---
section: Added
---
- **Read-only count of stored task-to-mission links that cross tenants.** New internal query `migrations/taskMissionTenantLinks:count` returns counts only (per org slug of the task: links to a mission of another tenant and links to a nonexistent mission; totals examined, own, foreign, dangling; `truncated` and an opaque `nextCursor`), never an id or row content, in pages of at most 2000 task rows. It uses the same `sameTenantStamp` rule as the write doors and migrates nothing. Also pins the 500-row cap of the mission all-done scan: a mission with more rows than the cap is left open (the test goes red if the fail-closed `blocked = true` is removed). No public argument or return changes: no contract bump. Task k175x770r9f6h01xt0wg0hdd798hf8m4.
