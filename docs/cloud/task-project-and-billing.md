# VantagePeers Cloud — Tasks carry a project; billing splits "no project" from "no duration"

**Scope:** VantagePeers Cloud (multi-tenant). Self-host operations are documented separately under `docs/getting-started/`. Do not cross-apply.

## `create_task` requires `project`

A task is created with a project, or not at all. `project` is the billing line the task belongs to: `billing_summary_by_project` groups done tasks by it, and a task without one falls outside every invoice line.

- `create_task` (MCP) rejects a missing, empty or whitespace-only `project` at the tool schema. The value is trimmed, so `"p"` and `"p "` never become two billing lines.
- The Convex door `tasks:create` refuses the same input with `TASK_PROJECT_REQUIRED` (a `ConvexError` whose payload names `"field":"project"`). The check runs after identity, roster and assignee checks and before the write: a caller refused for who they are is told that, not about the project rule. No row is written.
- `update_task` / `tasks:update`: an update that omits `project` leaves it untouched, so rows created before this rule (no project) keep working. An update that sets `project` to an empty or whitespace string is refused with `TASK_PROJECT_REQUIRED`.
- System spawns (recurring schedules, mission-template steps, GitHub webhook tasks, OKF import) are not client doors; they inherit the parent's project when it has one and are not refused here.

## `billing_summary_by_project`: the unattributed count is split

`unattributedTaskCount` (done tasks in the range with no project or no measured duration) is kept, with the same value as before, and now comes with its two causes:

| Field | Counts |
|---|---|
| `noProjectCount` | done tasks in range with no project, whatever their duration |
| `noDurationCount` | done tasks in range with a project but no `actualMinutes` |

A task with neither a project nor a duration counts in `noProjectCount` only, so `unattributedTaskCount = noProjectCount + noDurationCount` always holds.

Pass `listNoDuration: true` to also get `noDurationTasks: [{ taskId, assignedTo, project, completedAt }]`: the tasks closed without a measured duration, so they can be fixed by hand. The list holds at most 200 rows; `noDurationTasksTruncated: true` says when it was cut, and `noDurationCount` always carries the full count. A duration is never estimated or filled in. The scan itself stays bounded as before (`truncated: true` when the period produced more rows than the scan cap). A member of an organisation sees only its own organisation's tasks.
