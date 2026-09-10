# VantagePeers Cloud — Task Time Segments (pause_task / resume_task)

**Scope:** VantagePeers Cloud (multi-tenant). Self-host operations are documented separately under `docs/getting-started/`. This page documents two task verbs — `pause_task` and `resume_task` — and the billing rule they carry. Do not cross-apply to the Self-host runbooks.

## Summary

A task's billable duration is the sum of the work segments actually worked, not the raw difference between when it was first started and when it was completed. Previously, a task left `in_progress` across a break billed the break, because duration was computed as `completedAt - startedAt`. Duration is now computed by summing closed work segments, each opened by `start_task`/`resume_task` and closed by `pause_task` or by task completion.

## The two verbs

### `pause_task`

Closes the task's currently open work segment and stops the duration clock, **without ending the task**. The task returns to `todo`, and its owner picks it back up with `resume_task`. `checkout_task` refuses a paused task rather than letting someone else claim it — that guard exists so a reclaim cannot overwrite the original start.

- **`blocked`** means the task is waiting on someone or something else.
- **Paused** means nobody is actively working on the task right now, but nothing external is stopping the work — it can be picked back up at any time with `resume_task`.

Refuses if the task has no open work segment (nothing to pause).

### `resume_task`

Opens a new work segment on a paused task and sets it back to `in_progress`. Refuses if the task is not currently paused.

`start_task`, called on a task that already carries worked time, behaves the same way as `resume_task`: it resumes rather than restarts, keeping the task's original first-start timestamp and simply opening a new segment. `start_task` refuses outright if the task already has an open work segment — the refusal names the verb the caller probably meant (typically `resume_task`) instead of leaving the caller to guess. This refusal is deliberate: a task with a segment already open means somebody is actively working on it, and silently overwriting that state would strand the open segment's start time.

## Closure and the segment cap

When a task closes, each closed segment's duration is checked against a configured maximum. A segment longer than the maximum is refused — the closure fails and the error names the specific offending segment (its start and end timestamps and its computed duration) rather than silently recording a span that likely crosses an unrecorded break.

- **Configuration key:** `maxSegmentMinutes` (in the `taskClosureConfig` table)
- **Default:** 480 minutes (8 hours) — a working session's length

If a segment is refused for being too long, the fix is to have used `pause_task`/`resume_task` around the break instead of leaving the segment open. Raising `maxSegmentMinutes` is only appropriate when a segment that long genuinely reflects one continuous working session.

## Tasks closed before this change

A task closed before segment-based tracking existed keeps its original duration — the old `completedAt - startedAt` difference — but that duration is flagged as **inferred** rather than **measured**. Downstream reporting (invoicing, billing summaries) can use this flag to tell a segment-measured total apart from an inferred one, since the two are not computed the same way and should not be silently mixed.

## Related

- Task lifecycle overview and the full status model: see the public docs site, Capabilities → Tasks.
- Tool reference for `start_task`, `pause_task`, `resume_task`: see the public docs site, Tools reference and Tools catalogue.
