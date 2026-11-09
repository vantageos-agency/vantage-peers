/**
 * The outputSchema each structured tool ADVERTISES in tools/list (task
 * k1793xkjhzh1xm23gmmwjgwfyx8htbv0, PR C, finding 6).
 *
 * A tool declares one only when every success path of its handler returns
 * `structuredContent` that is the same object as its JSON text. The SDK then
 * validates that object against the schema on every call, so a schema here is a
 * contract the handler must honour, not documentation only.
 *
 * ── THE FORM every output schema follows ─────────────────────────────────────
 * (task k1766s9rdv2e98retx86ftpdjx8hvxrk; the tools that do not declare a
 * schema yet adopt this same form when they do.)
 *
 *   1. OPEN objects (z.looseObject), never `additionalProperties: false`: a
 *      client validates against the schema it read at connect time, so a field
 *      added later must still pass (task k17e9sx6e8wd951b47wvm0p5qn8hampb,
 *      output-schema-additive.test.ts).
 *   2. REQUIRED is what the Convex `returns:` validator (or the handler's own
 *      construction) guarantees on every success; anything else is
 *      `.optional()`. A value whose set may grow (a status, a priority) is a
 *      string, never a closed enum: its current values are named in the
 *      description.
 *   3. EVERY property, at every depth (objects inside arrays included), carries
 *      a `.describe()` that says what the value MEANS to an agent reading the
 *      result, and, for an optional or nullable field, WHEN it is absent or
 *      null. `.describe()` comes last, after `.optional()` / `.nullable()`, so
 *      the text sits on the property itself. Do not restate the type.
 *   4. Use the helpers below for the recurring shapes: `rowId(what)` for a
 *      document ID, `ms(what)` for a millisecond timestamp, `creationTime` for
 *      `_creationTime`. Reuse a shared row shape (`memoryRow`, `taskStatus`...)
 *      rather than re-describing the same field twice.
 *   5. The tool description's "Returns" clause names the schema's fields by
 *      their real names: `Returns { a, b, c[{ d }] }` lists the WHOLE envelope
 *      (every required field, nothing the schema lacks); `Returns ... ( a, b )`
 *      lists a selection of a stored row (each one a declared property). Never
 *      a label that is not a field ("author" for `createdBy`).
 *   6. An error result (isError) carries no structuredContent and is not
 *      validated (the SDK skips it).
 *
 * Enforced by test/output-schema-structured-content.test.ts: every schema here
 * validates a real success through /mcp, every property at every depth has a
 * description, and the "Returns" list agrees with the schema. Which tools
 * declare one, and why each other tool does not, is decided in
 * test/lib/toolMetadataDecisions.ts.
 */

import { z } from "zod";

/** A document ID; `what` says which record it identifies and where it is used. */
export const rowId = (what: string) => z.string().describe(what);
/** A millisecond Unix timestamp; `what` says which moment it records. */
export const ms = (what: string) =>
	z.number().describe(`${what} (milliseconds since the Unix epoch).`);
const creationTime = ms("When the row was created");
const orgSlug = (what: string) =>
	z
		.string()
		.optional()
		.describe(
			`The slug of the organisation that owns this ${what}; absent on a fleet-owned ${what}.`,
		);
const clerkOrgId = (what: string) =>
	z
		.string()
		.optional()
		.describe(
			`The permanent ID of the organisation that owns this ${what} (the slug can be renamed, this cannot); absent on a fleet-owned ${what} and on rows written before it was recorded.`,
		);
const actorId = (who: string) =>
	z
		.string()
		.optional()
		.describe(
			`The permanent ID of ${who}: an agent ID, or 'user:<subject>' for a signed-in person; absent on rows written before IDs were recorded.`,
		);
const contentHash = z
	.string()
	.optional()
	.describe(
		"The import key of a row brought in from an OKF bundle; absent on every row written directly.",
	);

// ── single-row reads ─────────────────────────────────────────────────────────

const episodeFields = z
	.looseObject({
		context: z.string().describe("The situation the episode happened in."),
		goal: z.string().describe("What was being attempted."),
		action: z.string().describe("What was done."),
		outcome: z.string().describe("What happened as a result."),
		insight: z.string().describe("The lesson to carry forward."),
		severity: z
			.string()
			.describe("How much the episode matters: critical, major or minor."),
	})
	.optional()
	.describe(
		"The episode's structured record; present on an episode (type 'episode'), absent on every other memory type.",
	);

const memoryRow = {
	_id: rowId(
		"The memory's ID: the memoryId get_memory and soft_delete_memory take.",
	),
	_creationTime: creationTime,
	namespace: z
		.string()
		.describe(
			"Where the memory is stored, e.g. 'team/<org>', 'orchestrator/<agent ID>' or 'project/<slug>'.",
		),
	type: z
		.string()
		.describe(
			"What the memory is about: user, feedback, project, reference or episode.",
		),
	content: z.string().describe("The memory itself."),
	createdBy: z
		.string()
		.describe("The agent or person recorded as the memory's author."),
	createdById: actorId("the author"),
	instanceId: z
		.string()
		.optional()
		.describe(
			"The author's instance that wrote it, e.g. 'sigma-vps'; absent when none was recorded.",
		),
	relations: z
		.array(
			z.looseObject({
				targetId: rowId("The earlier memory this one points to."),
				type: z
					.string()
					.describe(
						"How this memory relates to it: updates (supersedes it), extends (adds detail to it) or derives (is inferred from it).",
					),
			}),
		)
		.describe(
			"Links from this memory to earlier ones; empty when it has none.",
		),
	isLatest: z
		.boolean()
		.describe(
			"False once the memory was superseded (a later memory 'updates' it), soft-deleted or expired; true otherwise.",
		),
	ttl: z
		.string()
		.optional()
		.describe(
			"When the memory expires, as an ISO 8601 timestamp; absent when it never expires.",
		),
	createdAt: ms("When the memory was written"),
	updatedAt: ms("When the memory last changed"),
	contentHash,
	clerkOrgId: clerkOrgId("memory"),
	episode: episodeFields,
};

/** get_memory: the memory row (memories:getMemory `returns:`). */
export const getMemoryServedOutputSchema = z.looseObject(memoryRow);

/**
 * get_episode: a memory row of type episode (memories:getMemory `returns:`);
 * its structured fields are under `episode`, its author is `createdBy`.
 */
export const getEpisodeServedOutputSchema = z.looseObject(memoryRow);

const taskStatusValue = z
	.string()
	.describe(
		"Where the task is: todo, in_progress, review, blocked, done, failed or cancelled.",
	);

/** get_task: the task row (tasks:getById `returns:`). */
export const getTaskServedOutputSchema = z.looseObject({
	_id: rowId("The task's ID: the taskId the task tools take."),
	_creationTime: creationTime,
	title: z.string().describe("The task's one-line title."),
	description: z
		.string()
		.optional()
		.describe("The brief: what the task asks for; absent when none was given."),
	assignedTo: z
		.string()
		.describe("The agent or person the task is assigned to, by name."),
	assignedToId: actorId("the assignee"),
	priority: z
		.string()
		.describe("How urgent the task is: urgent, high, medium or low."),
	status: taskStatusValue,
	project: z
		.string()
		.optional()
		.describe(
			"The project the task is billed and grouped under; absent when it has none.",
		),
	tags: z
		.array(z.string())
		.optional()
		.describe("Free labels on the task; absent when it has none."),
	dependsOn: z
		.array(z.string())
		.optional()
		.describe(
			"IDs of the tasks this one waits on; absent when it depends on none.",
		),
	missionId: z
		.string()
		.optional()
		.describe(
			"The mission the task belongs to; absent when it belongs to none.",
		),
	completionNote: z
		.string()
		.optional()
		.describe(
			"What was delivered, with its evidence, as written when the task closed; absent until it closes.",
		),
	completionOutcome: z
		.string()
		.optional()
		.describe(
			"How the task closed: succeeded (complete_task) or failed (fail_task); absent while it is open.",
		),
	workSegments: z
		.array(
			z.looseObject({
				start: ms("When this stretch of work started"),
				end: z
					.number()
					.optional()
					.describe(
						"When this stretch of work ended (milliseconds since the Unix epoch); absent while it is still open.",
					),
				correction: z
					.looseObject({
						originalStart: ms("The start before the correction"),
						originalEnd: z
							.number()
							.optional()
							.describe(
								"The end before the correction (milliseconds since the Unix epoch); absent when the segment was open.",
							),
						reason: z.string().describe("Why the segment was corrected."),
						by: z.string().describe("Who corrected it."),
						at: ms("When it was corrected"),
					})
					.optional()
					.describe(
						"The correct_task_segment record of a changed segment; absent when it was never corrected.",
					),
			}),
		)
		.optional()
		.describe(
			"The measured stretches of work (start_task to pause_task or a close), from which actualMinutes is summed; absent before work started.",
		),
	estimatedMinutes: z
		.number()
		.optional()
		.describe("The estimate given at creation, in minutes; absent when none."),
	actualMinutes: z
		.number()
		.optional()
		.describe(
			"The measured working time, in minutes; absent until the task closes with a measured duration.",
		),
	startedAt: z
		.number()
		.optional()
		.describe(
			"When work first started (milliseconds since the Unix epoch); absent before start_task.",
		),
	completedAt: z
		.number()
		.optional()
		.describe(
			"When the task closed (milliseconds since the Unix epoch); absent while it is open.",
		),
	dueDate: z
		.number()
		.optional()
		.describe(
			"When the task is due (milliseconds since the Unix epoch); absent when it has no due date.",
		),
	blockedOnTaskId: z
		.string()
		.optional()
		.describe(
			"The task this one is blocked on, when block_task named one; absent otherwise.",
		),
	blockedCause: z
		.string()
		.optional()
		.describe(
			"Why the task is blocked: peer_task, human, authorisation or other; absent when it was never blocked.",
		),
	deliverableState: z
		.looseObject({
			state: z
				.string()
				.describe(
					"What the last check found: delivered (the published export exists), not_found or unresolved (the check could not decide).",
				),
			version: z
				.string()
				.optional()
				.describe(
					"The published version the check found; absent when nothing was found.",
				),
			checkedAt: ms("When the deliverable was last checked"),
			reason: z
				.string()
				.optional()
				.describe(
					"Why the check could not decide or found nothing; absent when it was delivered.",
				),
		})
		.optional()
		.describe(
			"The last machine check of the package export the task promised; absent when the task declares no deliverable or it was never checked.",
		),
	deliverableDivergence: z
		.string()
		.optional()
		.describe(
			"'delivered-but-open' when the promised deliverable is published while the task is still open; absent when no divergence is known.",
		),
	createdBy: z.string().optional().describe("Who created the task."),
	createdAt: z
		.number()
		.optional()
		.describe("When the task was created (milliseconds since the Unix epoch)."),
	updatedAt: z
		.number()
		.optional()
		.describe(
			"When the task last changed (milliseconds since the Unix epoch).",
		),
	orgId: orgSlug("task"),
});

const fixAttempt = z.looseObject({
	_id: rowId("The attempt's ID."),
	description: z.string().describe("What was tried."),
	worked: z.boolean().describe("Whether the attempt fixed the symptom."),
	why: z.string().describe("Why it worked, or why it did not."),
	createdBy: z.string().describe("Who recorded the attempt."),
	createdAt: ms("When the attempt was recorded"),
});

/** get_fix_pattern: the pattern with its attempts (fixPatterns:get `returns:`). */
export const getFixPatternServedOutputSchema = z.looseObject({
	_id: rowId("The pattern's ID: the patternId the fix-pattern tools take."),
	_creationTime: creationTime,
	symptom: z.string().describe("What was observed going wrong."),
	rootCause: z.string().describe("What actually caused it."),
	tags: z
		.array(z.string())
		.describe("Free labels for finding the pattern; empty when none."),
	stack: z
		.array(z.string())
		.describe(
			"The technologies the pattern applies to, e.g. 'convex', 'nextjs'; empty when none.",
		),
	sourceProject: z.string().describe("The project where it was first seen."),
	createdBy: z.string().describe("Who recorded the pattern."),
	severity: z
		.string()
		.describe("How much the problem matters: critical, major or minor."),
	createdAt: ms("When the pattern was recorded"),
	updatedAt: ms("When the pattern last changed"),
	attempts: z
		.array(fixAttempt)
		.describe(
			"The fix attempts recorded against the pattern, at most 100; empty when none was recorded.",
		),
});

/** get_message: the message row (messages:getById). */
export const getMessageServedOutputSchema = z.looseObject({
	_id: rowId("The message's ID: the messageId the message tools take."),
	_creationTime: creationTime,
	from: z.string().describe("The sender: the agent or person who wrote it."),
	fromId: actorId("the sender"),
	fromInstanceId: z
		.string()
		.optional()
		.describe(
			"The sender's instance, e.g. 'pi-vps'; absent when none was recorded.",
		),
	channel: z
		.string()
		.describe(
			"Where it was sent: an agent's name, a comma-separated list of names, or 'broadcast'.",
		),
	content: z.string().describe("The full message body."),
	sessionDay: z
		.number()
		.optional()
		.describe(
			"The sender's working-day number when it was sent; absent when none was recorded.",
		),
	tenantId: z
		.string()
		.optional()
		.describe(
			"The slug of the organisation the message was sent in; absent on a fleet message.",
		),
	tenantOrgId: z
		.string()
		.optional()
		.describe(
			"The permanent ID of that organisation; absent on a fleet message and on messages written before it was recorded.",
		),
	createdAt: z
		.number()
		.optional()
		.describe("When the message was sent (milliseconds since the Unix epoch)."),
});

/** get_recurring_task: the recurring template row (recurringTasks:getById). */
export const getRecurringTaskServedOutputSchema = z.looseObject({
	_id: rowId(
		"The template's ID: the recurringTaskId (or taskId) the recurring tools take.",
	),
	_creationTime: creationTime,
	title: z.string().describe("The title every created task gets."),
	description: z
		.string()
		.optional()
		.describe("The brief every created task gets; absent when none was given."),
	assignedTo: z
		.string()
		.describe("Who every created task is assigned to, by name."),
	assignedToId: actorId("that assignee"),
	priority: z
		.string()
		.describe(
			"The priority every created task gets: urgent, high, medium or low.",
		),
	project: z
		.string()
		.optional()
		.describe(
			"The project every created task is filed under; absent when none.",
		),
	tags: z
		.array(z.string())
		.optional()
		.describe("The labels every created task gets; absent when none."),
	cronExpression: z
		.string()
		.optional()
		.describe(
			"The schedule, as a cron expression, e.g. '0 9 * * 1' (Mondays at 09:00).",
		),
	nextRunAt: ms("When the schedule next creates a task"),
	lastCreatedAt: z
		.number()
		.optional()
		.describe(
			"When the schedule last created a task (milliseconds since the Unix epoch); absent before its first run.",
		),
	lastTaskId: z
		.string()
		.optional()
		.describe(
			"The last task the schedule created; absent before its first run.",
		),
	skippedRuns: z
		.number()
		.optional()
		.describe(
			"How many consecutive runs created nothing because the last task was still open; resets to 0 when a task is created; absent before any run was skipped.",
		),
	lastSkippedAt: z
		.number()
		.optional()
		.describe(
			"When the latest run was skipped (milliseconds since the Unix epoch); absent when none was.",
		),
	lastSkipReason: z
		.string()
		.optional()
		.describe(
			"Why the latest run was skipped, naming the open task; absent when none was.",
		),
	active: z
		.boolean()
		.describe(
			"Whether the schedule runs: false after pause_recurring_task, true after resume_recurring_task.",
		),
	createdBy: z.string().describe("Who created the schedule."),
	orgId: orgSlug("schedule"),
});

/** get_briefing_note: the note row (briefingNotes:get, briefingNoteFullValidator). */
export const getBriefingNoteServedOutputSchema = z.looseObject({
	_id: rowId("The note's ID: the noteId the briefing-note tools take."),
	_creationTime: creationTime,
	title: z.string().describe("The note's title."),
	topic: z.string().describe("What the note is about, used to group notes."),
	participants: z
		.array(z.string())
		.describe("Who took part, by name; each of them may read the note."),
	content: z
		.string()
		.describe(
			"The body of the note: the whole body, or a preview when contentTruncated is true.",
		),
	contentTruncated: z
		.boolean()
		.optional()
		.describe(
			"True when content is only a preview of a body stored apart; absent when content is the whole body.",
		),
	decisions: z
		.array(z.string())
		.optional()
		.describe("The decisions the note records; absent when none were given."),
	linkedMemoryIds: z
		.array(z.string())
		.optional()
		.describe(
			"IDs of the memories the note refers to (get_memory reads each); absent when none.",
		),
	createdBy: z.string().describe("Who wrote the note."),
	createdAt: ms("When the note was written"),
	updatedAt: z
		.number()
		.optional()
		.describe(
			"When the note last changed (milliseconds since the Unix epoch); absent when it was never updated.",
		),
	updatedBy: z
		.string()
		.optional()
		.describe("Who last changed it; absent when it was never updated."),
	orgId: orgSlug("note"),
});

/** get_bulk_complete_run: the run row (tasks:getBulkCompleteRun `returns:`). */
export const getBulkCompleteRunServedOutputSchema = z.looseObject({
	bulkRunId: z
		.string()
		.describe(
			"The run's ID, as the first bulk_complete_tasks call returned it.",
		),
	orgId: z
		.string()
		.optional()
		.describe(
			"The slug of the organisation whose tasks the run closes; absent on a fleet run.",
		),
	createdBy: z.string().describe("Who started the run."),
	status: z
		.string()
		.describe(
			"running (batches still draining), complete (every matching task is closed) or failed (a later batch was refused; see failureReason).",
		),
	closed: z
		.number()
		.describe(
			"How many tasks the run has closed so far; the total once status is complete.",
		),
	remaining: z
		.boolean()
		.describe("True while matching tasks are still left to close."),
	failureReason: z
		.string()
		.optional()
		.describe(
			"Why a batch was refused (RBAC or the closure gate); present only when status is failed.",
		),
	startedAt: ms("When the run started"),
	updatedAt: ms("When the run last progressed"),
});

// ── fixed envelopes ──────────────────────────────────────────────────────────

/** list_blocked_on_me: built in the handler from tasks:listBlockedOnMe `returns:`. */
export const listBlockedOnMeServedOutputSchema = z.looseObject({
	entries: z
		.array(
			z.looseObject({
				blockedTaskId: rowId("The waiting task, blocked on one of yours."),
				blockedTitle: z.string().describe("The waiting task's title."),
				blockedAssignee: z
					.string()
					.describe("Who the waiting task belongs to, by name."),
				onTaskId: rowId("Your task it waits on."),
				onTaskTitle: z.string().describe("Your task's title."),
				age: z
					.number()
					.describe(
						"How long it has been waiting, in milliseconds since it was blocked.",
					),
			}),
		)
		.describe(
			"The waiters, oldest wait first, cut to `limit`; empty when nobody waits on you.",
		),
	total: z
		.number()
		.describe(
			"How many waiters were found, including those beyond `limit`; a lower bound when truncated is true.",
		),
	truncated: z
		.boolean()
		.describe(
			"True when the bounded scan stopped early, so more waiters may exist.",
		),
	oldestAge: z
		.number()
		.describe(
			"The longest wait among the waiters found, in milliseconds; 0 when nobody waits.",
		),
});

/** list_broadcast_status: messages:listBroadcastStatus, receipts scope-filtered. */
export const listBroadcastStatusServedOutputSchema = z.looseObject({
	messageId: rowId("The message whose receipts these are."),
	from: z.string().describe("Who sent the message."),
	channel: z
		.string()
		.optional()
		.describe(
			"Where it was sent (an agent's name, a list of names, or 'broadcast'); absent when not recorded.",
		),
	createdAt: ms("When the message was sent"),
	receipts: z
		.array(
			z.looseObject({
				recipient: z.string().describe("Who the receipt is for, by name."),
				recipientInstanceId: z
					.string()
					.optional()
					.describe(
						"The recipient's instance, e.g. 'pi-vps'; absent when the receipt is for the agent as a whole.",
					),
				read: z
					.boolean()
					.describe("Whether that recipient has marked the message read."),
				readAt: z
					.number()
					.optional()
					.describe(
						"When it was marked read (milliseconds since the Unix epoch); absent while unread.",
					),
			}),
		)
		.describe(
			"One read receipt per recipient you may see, cut to `limit`; empty when none is visible to you.",
		),
	truncated: z
		.boolean()
		.describe(
			"True when more receipts exist than are listed (beyond `limit` or the fetch cap).",
		),
	scopeFiltered: z
		.number()
		.optional()
		.describe(
			"How many receipts were withheld because your session may not see those recipients; absent when none was.",
		),
});

/** get_github_owner_bindings: two cursor-paged lists; the second is the fleet master's only. */
export const getGithubOwnerBindingsServedOutputSchema = z.looseObject({
	bindings: z
		.array(z.looseObject({}))
		.describe(
			"The GitHub owners bound to your organisation (master: every organisation), one row per binding; empty when none.",
		),
	nextCursor: z
		.string()
		.nullable()
		.describe(
			"Pass it back as `cursor` for the next page of bindings; null when the list is exhausted.",
		),
	unprovenMappings: z
		.array(z.looseObject({}))
		.optional()
		.describe(
			"Organisation-owned repo mappings created without GitHub proof; present for the fleet master only.",
		),
	unprovenNextCursor: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Pass it back as `unprovenCursor` for the next page of unproven mappings; null when exhausted; absent for everyone but the fleet master.",
		),
});

/** billing_summary_by_project: tasks:billingSummaryByProject `returns:`. */
export const billingSummaryByProjectServedOutputSchema = z.looseObject({
	byProject: z
		.array(
			z.looseObject({
				project: z.string().describe("The project these totals are for."),
				totalMinutes: z
					.number()
					.describe(
						"The measured working minutes of its done tasks in the period.",
					),
				taskCount: z
					.number()
					.describe("How many of its done tasks carry a measured duration."),
				legacyTaskCount: z
					.number()
					.describe(
						"How many of those tasks were timed the legacy way (start to close, not work segments).",
					),
				legacyMinutes: z
					.number()
					.describe("The part of totalMinutes timed the legacy way."),
			}),
		)
		.describe(
			"One row per project with billable time in the period; empty when none.",
		),
	unattributedTaskCount: z
		.number()
		.describe(
			"Done tasks in the period that cannot be billed: noProjectCount plus noDurationCount.",
		),
	noProjectCount: z
		.number()
		.describe("Done tasks with no project, whatever their duration."),
	noDurationCount: z
		.number()
		.describe("Done tasks with a project but no measured duration."),
	noDurationTasks: z
		.array(
			z.looseObject({
				taskId: rowId("The task with no measured duration."),
				assignedTo: z.string().describe("Who it is assigned to."),
				project: z.string().describe("Its project."),
				completedAt: ms("When it closed"),
			}),
		)
		.optional()
		.describe(
			"The done tasks counted in noDurationCount, at most 200; present only when listNoDuration=true was passed.",
		),
	noDurationTasksTruncated: z
		.boolean()
		.optional()
		.describe(
			"True when noDurationTasks was cut at its cap; present only with noDurationTasks.",
		),
	invalidDurationTaskCount: z
		.number()
		.describe(
			"Done tasks left out because their recorded duration is negative (an impossible value).",
		),
	truncated: z
		.boolean()
		.describe(
			"True when the scan hit its cap, so the totals are incomplete: narrow the period and ask again.",
		),
});

// ── writes: the handler builds the answer from a fixed set of keys ───────────

const writtenAs = (what: string) =>
	z
		.string()
		.nullable()
		.optional()
		.describe(
			`Who the ${what} is recorded as written by (the acting agent, or the signed-in person); absent when no name was resolved.`,
		);

export const storeMemoryServedOutputSchema = z.looseObject({
	memoryId: rowId(
		"The new memory's ID: get_memory reads it, soft_delete_memory retires it.",
	),
	namespace: z
		.string()
		.describe(
			"Where the memory was written (your own space when none was given).",
		),
	type: z.string().describe("The memory's type, as stored."),
	content: z.string().describe("The memory's content, as stored."),
	createdBy: writtenAs("memory"),
});

export const softDeleteMemoryServedOutputSchema = z.looseObject({
	deleted: z
		.boolean()
		.describe(
			"True: the memory is retired and no longer served by reads or search.",
		),
	memoryId: rowId("The memory that was retired."),
});

const taskIdOut = rowId("The task this result is about.");

/** update_task. */
export const taskUpdatedServedOutputSchema = z.looseObject({
	taskId: taskIdOut,
	updated: z.boolean().describe("True: the changes were written."),
});

/** start_task, pause_task, resume_task: the status the task moved to. */
export const taskStatusServedOutputSchema = z.looseObject({
	taskId: taskIdOut,
	status: z.string().describe("The status the task is in after this call."),
});

export const missionUpdatedServedOutputSchema = z.looseObject({
	missionId: rowId("The mission that was updated."),
	updated: z.boolean().describe("True: the changes were written."),
});

export const missionStatusServedOutputSchema = z.looseObject({
	missionId: rowId("The mission whose status was set."),
	status: z.string().describe("The mission's status after this call."),
});

export const writeDiaryServedOutputSchema = z.looseObject({
	diaryId: rowId("The diary entry's ID."),
	date: z.string().describe("The day the entry is for, as given."),
	orchestrator: z.string().describe("Whose diary the entry belongs to."),
});

export const briefingNoteUpdatedServedOutputSchema = z.looseObject({
	noteId: rowId("The note that was updated."),
	updated: z.boolean().describe("True: the changes were written."),
});

export const createRecurringTaskServedOutputSchema = z.looseObject({
	taskId: rowId(
		"The new template's ID: the recurringTaskId (or taskId) the recurring tools take.",
	),
	cronExpression: z.string().describe("The schedule, as stored."),
});

// ── more writes (same rule: the handler's own construction, or the Convex
//    `returns:` validator it passes through) ──────────────────────────────────

/** create_task: the task as created (tasks:create returns its ID). */
export const createTaskServedOutputSchema = z.looseObject({
	taskId: rowId(
		"The new task's ID: start_task, update_task and complete_task take it.",
	),
	title: z.string().describe("The task's title, as stored."),
	assignedTo: z.string().describe("Who the task is assigned to."),
	priority: z.string().describe("The task's priority, as stored."),
	status: z
		.string()
		.describe("The status the task was created in (todo for a new task)."),
});

/** complete_task, fail_task: the status the task closed with. */
export const taskClosedServedOutputSchema = taskStatusServedOutputSchema;

/** block_task: the block as recorded. */
export const blockTaskServedOutputSchema = z.looseObject({
	taskId: taskIdOut,
	status: z.string().describe("The task's status after this call: blocked."),
	reason: z.string().describe("The block reason, as recorded."),
	blockedOnTaskId: z
		.string()
		.optional()
		.describe(
			"The task this one is blocked on; absent when the block names no task.",
		),
	blockedCause: z
		.string()
		.describe(
			"What the task waits on: peer_task, human, authorisation or other.",
		),
	dependsOn: z
		.array(z.string())
		.optional()
		.describe(
			"The task's full dependency list after this call; present only when blockedBy was given.",
		),
});

/** add_task_dependency: the resulting dependency list. */
export const addTaskDependencyServedOutputSchema = z.looseObject({
	taskId: taskIdOut,
	dependsOn: z
		.array(z.string())
		.describe(
			"The task's full dependency list after this call (earlier ones kept).",
		),
	updated: z.boolean().describe("True: the list was written."),
});

/** checkout_task: tasks:checkout `returns:` (claimed false says why). */
export const checkoutTaskServedOutputSchema = z.looseObject({
	claimed: z
		.boolean()
		.describe(
			"True when the task is now yours and in progress; false when it could not be claimed (nothing was written).",
		),
	reason: z
		.string()
		.optional()
		.describe(
			"Why the claim failed (not found, paused, already has an open work segment, not todo); absent when claimed.",
		),
});

/** delete_task, delete_recurring_task: { deleted } from the Convex door. */
export const deletedServedOutputSchema = z.looseObject({
	deleted: z.boolean().describe("True: the row was deleted."),
});

/** correct_task_segment. */
export const correctTaskSegmentServedOutputSchema = z.looseObject({
	taskId: taskIdOut,
	segmentIndex: z
		.number()
		.describe("Which work segment was corrected (0 is the first)."),
	corrected: z
		.boolean()
		.describe("True: the segment and the task's measured time were rewritten."),
});

/** create_mission. */
export const createMissionServedOutputSchema = z.looseObject({
	missionId: rowId(
		"The new mission's ID: create_task and instantiate_template_into_mission take it.",
	),
	name: z.string().describe("The mission's name, as stored."),
	project: z.string().describe("The project the mission belongs to."),
	pilot: z.string().describe("Who pilots the mission."),
	status: z.string().describe("The status the mission was created in."),
});

/** create_briefing_note. */
export const createBriefingNoteServedOutputSchema = z.looseObject({
	noteId: rowId("The new note's ID: get_briefing_note reads it."),
	title: z.string().describe("The note's title, as stored."),
	topic: z.string().describe("The note's topic, as stored."),
	createdBy: writtenAs("note"),
});

/** store_episode. */
export const storeEpisodeServedOutputSchema = z.looseObject({
	memoryId: rowId("The new episode's ID: the episodeId get_episode takes."),
	type: z.string().describe("Always 'episode'."),
	severity: z.string().describe("The episode's severity, as stored."),
	namespace: z
		.string()
		.describe(
			"Where the episode was written (your own space when none was given).",
		),
	createdBy: writtenAs("episode"),
});

/** update_profile. */
export const updateProfileServedOutputSchema = z.looseObject({
	profileId: rowId("The profile's ID (created when none existed)."),
	orchestratorId: z.string().describe("Whose profile was written."),
	name: z
		.string()
		.optional()
		.describe("The display name sent; absent when none was given."),
});

/** set_summary. */
export const setSummaryServedOutputSchema = z.looseObject({
	orchestratorId: z.string().describe("Whose status was set."),
	instanceId: z
		.string()
		.optional()
		.describe("The instance whose status was set; absent when none was given."),
	summary: z.string().describe("The status summary, as stored."),
});

/** send_message: recipients by ID, or the channel; stateUnverified when a stated state could not be checked. */
export const sendMessageServedOutputSchema = z.looseObject({
	messageId: rowId("The new message's ID: list_broadcast_status takes it."),
	from: z.string().describe("Who the message is recorded as sent by."),
	recipientAgentIds: z
		.array(z.string())
		.optional()
		.describe(
			"The agent IDs it was sent to; present when sent by recipientAgentIds, absent when sent to a channel.",
		),
	channel: z
		.string()
		.optional()
		.describe(
			"Where it was sent; present when sent to a channel, absent when sent by recipientAgentIds.",
		),
	stateUnverified: z
		.array(z.string())
		.optional()
		.describe(
			"State claims in the content that could not be checked (e.g. GitHub unreachable), one sentence each; absent when every claim checked out or none was made.",
		),
});

/** mark_as_read: how many receipts were newly marked. */
export const markAsReadServedOutputSchema = z.looseObject({
	markedAsRead: z
		.number()
		.describe(
			"How many receipts this call marked read; one already read is not counted.",
		),
});

/** delete_message: messages:deleteMessage `returns:`. */
export const deleteMessageServedOutputSchema = z.looseObject({
	deleted: z.boolean().describe("True: the message was deleted."),
	receiptsDeleted: z
		.number()
		.describe("How many of its read receipts were deleted with it."),
});

/** update_recurring_task. */
export const updateRecurringTaskServedOutputSchema = z.looseObject({
	recurringTaskId: rowId("The template that was updated."),
	updated: z.boolean().describe("True: the changes were written."),
});

/** pause_recurring_task: recurringTasks:pause `returns:`. */
export const pauseRecurringTaskServedOutputSchema = z.looseObject({
	taskId: rowId("The template that was paused."),
	active: z
		.boolean()
		.describe("False: the schedule creates no task until resumed."),
});

/** resume_recurring_task: recurringTasks:resume `returns:`. */
export const resumeRecurringTaskServedOutputSchema = z.looseObject({
	taskId: rowId("The template that was resumed."),
	active: z.boolean().describe("True: the schedule runs again."),
	nextRunAt: ms("When it next creates a task"),
});

/** add_repo_mapping: the mapping as stored. */
export const addRepoMappingServedOutputSchema = z.looseObject({
	id: rowId("The mapping's ID."),
	repo: z.string().describe("The GitHub repo, as 'owner/name'."),
	orchestrator: z.string().describe("Who receives the repo's webhook events."),
	project: z
		.string()
		.describe("The project the repo's events are filed under."),
	active: z
		.boolean()
		.describe(
			"Whether the repo's events are routed; false keeps the mapping without routing.",
		),
	reviewer: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Who reviews the repo's pull-request tasks; absent when none was given (the fleet default applies).",
		),
	fallbackReviewer: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Who reviews when the reviewer is stopped; absent when none was given (the fleet default applies).",
		),
});

/** remove_repo_mapping: the repo and whether a mapping was removed. */
export const removeRepoMappingServedOutputSchema = z.looseObject({
	repo: z.string().describe("The repo the call was for."),
	deleted: z
		.boolean()
		.describe(
			"True when a mapping was removed; false when none existed for that repo.",
		),
});

/** validate_fix. */
export const validateFixServedOutputSchema = z.looseObject({
	patternId: rowId("The fix pattern that was validated."),
	validatedFix: z.string().describe("The fix recorded as the one that works."),
	validated: z.boolean().describe("True: the validated fix was written."),
});

/** link_issue_to_pattern. */
export const linkIssueToPatternServedOutputSchema = z.looseObject({
	patternId: rowId("The fix pattern the issue is linked to."),
	issueId: z.string().describe("The issue that was linked."),
	linked: z
		.boolean()
		.describe("True: the link exists (an existing link is left as it was)."),
});
