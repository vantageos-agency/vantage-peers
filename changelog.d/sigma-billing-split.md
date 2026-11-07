---
section: Added
---
- **`billing_summary_by_project` splits the unattributed count (Cloud; task k17c7mz2n765wacn6qxcgy00vn8hsa58).** `unattributedTaskCount` keeps its value and gains `noProjectCount` (no project, whatever the duration) and `noDurationCount` (a project, no measured duration); a task with neither counts in `noProjectCount` only. New optional argument `listNoDuration` returns `noDurationTasks` (`taskId`, `assignedTo`, `project`, `completedAt`; at most 200, `noDurationTasksTruncated` says when cut); a duration is never estimated. Additive only. Tests: `convex/__tests__/billing-split.test.ts`, `mcp-server/src/__tests__/billing_summary_by_project.tool.test.ts`.
