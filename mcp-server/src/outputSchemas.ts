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
	commit: z
		.string()
		.optional()
		.describe("The git commit of the attempt; absent when none was given."),
	createdBy: z.string().describe("Who recorded the attempt."),
	createdAt: ms("When the attempt was recorded"),
});

/** get_fix_pattern: the pattern with its attempts (fixPatterns:get `returns:`). */
export const getFixPatternServedOutputSchema = z.looseObject({
	_id: rowId("The pattern's ID: the patternId the fix-pattern tools take."),
	_creationTime: creationTime,
	symptom: z.string().describe("What was observed going wrong."),
	rootCause: z.string().describe("What actually caused it."),
	validatedFix: z
		.string()
		.optional()
		.describe(
			"The fix confirmed to work (validate_fix); absent until one is validated.",
		),
	files: z
		.array(z.string())
		.optional()
		.describe("The files the fix touched; absent when none were recorded."),
	tags: z
		.array(z.string())
		.describe("Free labels for finding the pattern; empty when none."),
	stack: z
		.array(z.string())
		.describe(
			"The technologies the pattern applies to, e.g. 'convex', 'nextjs'; empty when none.",
		),
	sourceProject: z.string().describe("The project where it was first seen."),
	linkedIssueIds: z
		.array(z.string())
		.optional()
		.describe(
			"The issues linked to the pattern (link_issue_to_pattern); absent when none.",
		),
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
	createdAt: ms("When the message was sent"),
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
		.array(
			z.looseObject({
				owner: z
					.string()
					.describe(
						"The GitHub owner (user or organisation login, lowercase) whose repositories the organisation may map.",
					),
				orgId: z
					.string()
					.describe("The slug of the organisation the owner is bound to."),
				installationId: z
					.number()
					.describe("The GitHub App installation that proved the binding."),
				accountType: z
					.string()
					.describe(
						"What the owner is on GitHub, as GitHub reports it: User or Organization.",
					),
				githubUserLogin: z
					.string()
					.describe("The GitHub user who authorised the installation."),
				boundAt: ms("When the owner was bound"),
				active: z
					.boolean()
					.describe(
						"False once the installation was deleted or suspended and the binding withdrawn; true otherwise.",
					),
			}),
		)
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
		.array(
			z.looseObject({
				repo: z.string().describe("The mapped repository, as owner/name."),
				orgId: z
					.string()
					.describe("The slug of the organisation the mapping belongs to."),
				project: z.string().describe("The project the mapping files it under."),
				reason: z
					.string()
					.describe(
						"Why it has no proof: owner-not-bound (no binding for the repository's owner) or owner-bound-to-another-org.",
					),
			}),
		)
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

// ── lists and searches (task k17592gg5t2tencwxks3kysghx8htqg8, outputs 1/3) ──
// The text of these tools is unchanged. Their structuredContent is the object
// form of the same answer (src/structuredResult.ts): { items } for a search
// whose text is a bare array, { items, nextCursor, truncated } for a page
// written through capListResponseBytes.

const pageCursor = z
	.string()
	.nullable()
	.describe(
		"The cursor to pass as `cursor` for the next (older) page; null on the last page, and null when truncated is true (a cut page has no continuation: narrow the query or lower limit instead).",
	);
const pageTruncated = z
	.boolean()
	.describe(
		"True when the page exceeded the 60 KB response cap and items holds only its first rows; false when items is the whole page.",
	);
const pageScopeFiltered = z
	.number()
	.optional()
	.describe(
		"How many rows of your own organisation on this page your session may not see and were left out; absent when none were.",
	);

/** A page of `row`: its rows, its continuation, and whether the cap cut it. */
const pageOf = (row: z.ZodType, rows: string, extra: z.ZodRawShape = {}) =>
	z.looseObject({
		items: z.array(row).describe(rows),
		nextCursor: pageCursor,
		truncated: pageTruncated,
		...extra,
	});

/** A search's matches: the same rows its text gives as a bare array. */
const matchesOf = (row: z.ZodType, rows: string) =>
	z.looseObject({
		items: z.array(row).describe(rows),
		truncated: z
			.boolean()
			.optional()
			.describe(
				"True when the answer exceeded the 60 KB response cap and items holds only its first rows (the text then says so in _meta); absent when items is the whole answer.",
			),
	});

const memoryTypeField = z
	.string()
	.describe(
		"What the memory is about: user, feedback, project, reference or episode.",
	);
const matchMemoryId = rowId(
	"The matching memory's ID: the memoryId get_memory takes.",
);
const matchNamespace = z
	.string()
	.describe("The namespace the matching memory is stored in.");
const matchContent = z.string().describe("The matching memory's indexed text.");

const semanticMatch = z.looseObject({
	memoryId: matchMemoryId,
	score: z
		.number()
		.describe(
			"How close the memory is in meaning to the query (cosine similarity, higher is closer).",
		),
	namespace: matchNamespace,
	type: memoryTypeField,
	content: matchContent,
});
const keywordMatch = z.looseObject({
	memoryId: matchMemoryId,
	namespace: matchNamespace,
	type: memoryTypeField,
	content: matchContent,
});
const hybridMatch = z.looseObject({
	memoryId: matchMemoryId,
	rrfScore: z
		.number()
		.describe(
			"The fused rank score of the meaning and keyword rankings (Reciprocal Rank Fusion, higher is better).",
		),
	namespace: matchNamespace,
	type: memoryTypeField,
	content: matchContent,
});

/** recall: search:recall `returns:`. */
export const recallServedOutputSchema = matchesOf(
	semanticMatch,
	"The memories closest in meaning to the query, best match first; empty when none passes the similarity threshold or the namespace holds none.",
);
/** text_search: search:textSearch `returns:`. */
export const textSearchServedOutputSchema = matchesOf(
	keywordMatch,
	"The memories matching the query's words, best match first; empty when none matches.",
);
/** hybrid_search: search:hybridSearch `returns:`. */
export const hybridSearchServedOutputSchema = matchesOf(
	hybridMatch,
	"The memories matching by meaning and by words, highest fused score first; empty when none matches.",
);
/** search_episodes_by_keyword: search:textSearch with type 'episode'. */
export const searchEpisodesByKeywordServedOutputSchema = matchesOf(
	keywordMatch,
	"The episodes matching the query's words, best match first; empty when none matches.",
);
/** search_episodes_by_semantic: search:recall with type 'episode'. */
export const searchEpisodesBySemanticServedOutputSchema = matchesOf(
	semanticMatch,
	"The episodes closest in meaning to the query, best match first; empty when none passes the similarity threshold.",
);

const messageFields = {
	_id: rowId("The message's ID: the messageId the message tools take."),
	from: z.string().describe("The sender: the agent or person who wrote it."),
	fromId: actorId("the sender"),
	fromInstanceId: z
		.string()
		.optional()
		.describe(
			"The sender's instance, e.g. 'pi-vps'; absent when none was recorded.",
		),
	content: z.string().describe("The full message body."),
	sessionDay: z
		.number()
		.optional()
		.describe(
			"The sender's working-day number when it was sent; absent when none was recorded.",
		),
	createdAt: ms("When the message was sent"),
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
};
const messageChannel =
	"Where it was sent: an agent's name, a comma-separated list of names, or 'broadcast'";

/** list_messages: rows of messages:listMessages `returns:`. */
export const listMessagesServedOutputSchema = pageOf(
	z.looseObject({
		...messageFields,
		_creationTime: creationTime,
		channel: z
			.string()
			.optional()
			.describe(
				`${messageChannel}; every stored message has one (the list door declares it optional)`,
			),
	}),
	"The messages, newest first; empty when none matches the filters.",
);

/** search_messages_by_keyword: messages rows, lite (ID, sender, channel, text, day, time) or full. */
export const searchMessagesByKeywordServedOutputSchema = matchesOf(
	z.looseObject({
		...messageFields,
		_creationTime: z
			.number()
			.optional()
			.describe(
				"When the row was created (milliseconds since the Unix epoch); present with fields='full' only.",
			),
		channel: z.string().describe(`${messageChannel}.`),
	}),
	"The messages whose text matches the query, best match first; empty when none matches.",
);

/** list_tasks / list_tasks_by_mission: task rows, lite (ID, creation time, title, status, priority, assignee, mission) or full. */
const taskListRow = getTaskServedOutputSchema;

/** list_tasks. */
export const listTasksServedOutputSchema = pageOf(
	taskListRow,
	"The tasks, newest first (newest-updated first with updatedSince); lite rows carry _id, _creationTime, title, status, priority, assignedTo and missionId, full rows every stored field.",
);

/** list_tasks_by_mission. */
export const listTasksByMissionServedOutputSchema = pageOf(
	taskListRow,
	"The mission's tasks, newest first; lite rows carry _id, _creationTime, title, status, priority, assignedTo and missionId, full rows every stored field.",
	{ scopeFiltered: pageScopeFiltered },
);

/** search_tasks_by_keyword: the lite projection carries no _creationTime. */
export const searchTasksByKeywordServedOutputSchema = matchesOf(
	taskListRow.extend({
		_creationTime: z
			.number()
			.optional()
			.describe(
				"When the task was created (milliseconds since the Unix epoch); present with fields='full' only.",
			),
	}),
	"The tasks whose title matches the query, best match first; lite rows carry _id, title, status, priority, assignedTo and missionId, full rows every stored field.",
);

const memoryListRow = z.looseObject(memoryRow);

/** list_memories: rows of memories:listMemories `returns:`. */
export const listMemoriesServedOutputSchema = pageOf(
	memoryListRow,
	"The memories (latest versions only), newest first; empty when the namespace holds none.",
);

/** list_episodes: memories rows of type 'episode'. */
export const listEpisodesServedOutputSchema = pageOf(
	memoryListRow,
	"The episodes (memories of type 'episode'), newest first; their structured fields are under episode.",
);

const nullableStatus = (what: string) =>
	z
		.string()
		.nullable()
		.describe(
			`${what}; null for an organisation's agent, whose profile is not read.`,
		);

/** list_peers: built in the handler, from the org roster or from profiles:listProfiles. */
export const listPeersServedOutputSchema = pageOf(
	z.looseObject({
		_id: z
			.string()
			.optional()
			.describe(
				"The profile row's ID; absent for an organisation's agent (listed from the roster, not from a profile).",
			),
		_creationTime: z
			.number()
			.optional()
			.describe(
				"When the profile was created (milliseconds since the Unix epoch); absent for an organisation's agent.",
			),
		id: z.string().describe("The orchestrator's name, as tools take it."),
		agentId: z
			.string()
			.nullable()
			.optional()
			.describe(
				"The agent's permanent ID, to pass in send_message recipientAgentIds; null when the agent is not addressable, absent on the fleet's own profile listing.",
			),
		instanceId: z
			.string()
			.describe("The instance the orchestrator runs as, e.g. 'sigma-vps'."),
		name: z.string().describe("The orchestrator's display name."),
		role: nullableStatus("What the orchestrator does"),
		workspace: nullableStatus("Where the orchestrator works"),
		currentTask: nullableStatus(
			"What the orchestrator is working on, 'idle' when nothing",
		),
		lastSeen: nullableStatus(
			"When the orchestrator was last active, as an ISO 8601 timestamp",
		),
		sessionCount: z
			.number()
			.nullable()
			.describe(
				"How many sessions the orchestrator has run; null for an organisation's agent, whose profile is not read.",
			),
	}),
	"The orchestrators, newest first; for an organisation, its agents.",
	{ scopeFiltered: pageScopeFiltered },
);

/** list_missions: missions rows, lite (ID, creation time, name, status, pilot, priority, project) or full. */
export const listMissionsServedOutputSchema = pageOf(
	z.looseObject({
		_id: rowId("The mission's ID: the missionId the mission tools take."),
		_creationTime: creationTime,
		name: z.string().describe("The mission's name."),
		status: z
			.string()
			.describe(
				"Which stage the mission is at: brainstorm, plan, execute, validate, complete or cancelled.",
			),
		pilot: z
			.string()
			.describe("The orchestrator leading the mission, by name."),
		priority: z
			.string()
			.describe("How urgent the mission is: urgent, high, medium or low."),
		project: z.string().describe("The project the mission belongs to."),
		description: z
			.string()
			.optional()
			.describe("What the mission is for; absent when none, and on lite rows."),
		brief: z
			.string()
			.optional()
			.describe("The mission brief; absent when none, and on lite rows."),
		agents: z
			.array(z.string())
			.optional()
			.describe(
				"The orchestrators working on the mission, by name; absent on lite rows.",
			),
		progress: z
			.number()
			.optional()
			.describe(
				"How far the mission has got, as a percentage; absent when never set, and on lite rows.",
			),
		createdBy: z
			.string()
			.optional()
			.describe("Who created the mission; absent on lite rows."),
		createdAt: z
			.number()
			.optional()
			.describe(
				"When the mission was created (milliseconds since the Unix epoch); absent on lite rows.",
			),
		updatedAt: z
			.number()
			.optional()
			.describe(
				"When the mission last changed (milliseconds since the Unix epoch); absent on lite rows.",
			),
		orgId: orgSlug("mission"),
	}),
	"The missions, newest first; lite rows carry _id, _creationTime, name, status, pilot, priority and project, full rows every stored field.",
);

/** A diary entry: diary:list and diary:get `returns:` (DIARY_LIST_ROW). */
const diaryRow = z.looseObject({
	_id: rowId("The diary entry's ID."),
	_creationTime: creationTime,
	date: z.string().describe("The day the entry is for, as YYYY-MM-DD."),
	orchestrator: z
		.string()
		.describe("The orchestrator the entry is about, by name."),
	instanceId: z
		.string()
		.optional()
		.describe("The instance that wrote it; absent when none was recorded."),
	content: z.string().describe("The diary entry itself."),
	highlights: z
		.array(z.string())
		.optional()
		.describe("The day's highlights; absent when none were given."),
	blockers: z
		.array(z.string())
		.optional()
		.describe("What blocked the day; absent when none were given."),
	createdBy: z
		.string()
		.optional()
		.describe(
			"Who wrote the entry, as authenticated; absent on entries written before it was recorded.",
		),
	createdById: actorId("the author"),
	createdAt: ms("When the entry was written"),
	orgId: orgSlug("entry"),
	clerkOrgId: clerkOrgId("entry"),
});

/** list_diaries: rows of diary:list `returns:` (DIARY_LIST_ROW). */
export const listDiariesServedOutputSchema = pageOf(
	diaryRow,
	"The diary entries, newest first; empty when none matches.",
);

const briefingNoteListFields = {
	_id: rowId("The note's ID: the noteId the briefing-note tools take."),
	title: z.string().describe("The note's title."),
	topic: z.string().describe("What the note is about, used to group notes."),
	participants: z
		.array(z.string())
		.describe("Who took part, by name; each of them may read the note."),
	createdBy: z.string().describe("Who wrote the note."),
	content: z
		.string()
		.optional()
		.describe(
			"The body of the note, or a preview when contentTruncated is true; absent on lite rows (get_briefing_note reads it).",
		),
	contentTruncated: z
		.boolean()
		.optional()
		.describe(
			"True when content is only a preview of a body stored apart; absent when content is the whole body, and on lite rows.",
		),
	decisions: z
		.array(z.string())
		.optional()
		.describe(
			"The decisions the note records; absent when none were given, and on lite rows.",
		),
	updatedAt: z
		.number()
		.optional()
		.describe(
			"When the note last changed (milliseconds since the Unix epoch); absent when it was never updated, and on lite rows.",
		),
	orgId: orgSlug("note"),
};

/** list_briefing_notes: briefingNotes:list `returns:` (full or lite rows). */
export const listBriefingNotesServedOutputSchema = pageOf(
	z.looseObject({
		...briefingNoteListFields,
		_creationTime: creationTime,
		createdAt: z
			.number()
			.optional()
			.describe(
				"When the note was written (milliseconds since the Unix epoch); absent on lite rows.",
			),
	}),
	"The notes, newest first; lite rows carry _id, _creationTime, topic, title, participants and createdBy, full rows every stored field.",
);

/** search_briefing_notes_by_keyword: briefingNotes:searchBriefingNotesByKeyword `returns:`. */
export const searchBriefingNotesByKeywordServedOutputSchema = matchesOf(
	z.looseObject({
		...briefingNoteListFields,
		_creationTime: z
			.number()
			.optional()
			.describe(
				"When the row was created (milliseconds since the Unix epoch); present with fields='full' only.",
			),
		createdAt: ms("When the note was written"),
	}),
	"The notes whose content matches the query, best match first; lite rows carry _id, title, topic, createdBy, createdAt and participants.",
);

/** list_recurring_tasks: recurringTasks rows. */
export const listRecurringTasksServedOutputSchema = pageOf(
	getRecurringTaskServedOutputSchema,
	"The recurring schedules, newest first; empty when none matches.",
	{ scopeFiltered: pageScopeFiltered },
);

/** list_repo_mappings: githubRepoMapping:list `returns:` (full or lite rows). */
export const listRepoMappingsServedOutputSchema = pageOf(
	z.looseObject({
		_id: rowId("The mapping's ID."),
		_creationTime: creationTime,
		repo: z
			.string()
			.describe("The GitHub repository, as owner/name, e.g. 'acme/app'."),
		orchestrator: z
			.string()
			.describe("The orchestrator the repository's events are routed to."),
		project: z.string().describe("The project the repository belongs to."),
		active: z
			.boolean()
			.optional()
			.describe(
				"Whether events are routed for the repository; absent on lite rows.",
			),
		lastDeployedSHA: z
			.string()
			.optional()
			.describe(
				"The commit last deployed to production; absent when no deploy was recorded, and on lite rows.",
			),
		lastDeployedAt: z
			.number()
			.optional()
			.describe(
				"When that commit was deployed (milliseconds since the Unix epoch); absent when no deploy was recorded, and on lite rows.",
			),
		reviewer: z
			.string()
			.optional()
			.describe(
				"Who reviews the repository's pull requests; absent when the fleet default applies, and on lite rows.",
			),
		fallbackReviewer: z
			.string()
			.optional()
			.describe(
				"Who reviews when the reviewer cannot; absent when the fleet default applies, and on lite rows.",
			),
		orgId: orgSlug("mapping"),
	}),
	"The mappings, newest first; lite rows carry _id, _creationTime, repo, orchestrator and project.",
);

/** list_fix_patterns: fixPatterns:listAll / listByProject `returns:`. */
export const listFixPatternsServedOutputSchema = pageOf(
	z.looseObject({
		_id: rowId("The pattern's ID: the patternId the fix-pattern tools take."),
		_creationTime: creationTime,
		symptom: z.string().describe("What was observed going wrong."),
		rootCause: z.string().describe("What actually caused it."),
		validatedFix: z
			.string()
			.optional()
			.describe(
				"The fix confirmed to work (validate_fix); absent until one is validated.",
			),
		files: z
			.array(z.string())
			.optional()
			.describe("The files the fix touched; absent when none were recorded."),
		tags: z
			.array(z.string())
			.describe("Free labels for finding the pattern; empty when none."),
		stack: z
			.array(z.string())
			.describe(
				"The technologies the pattern applies to, e.g. 'convex', 'nextjs'; empty when none.",
			),
		sourceProject: z.string().describe("The project where it was first seen."),
		linkedIssueIds: z
			.array(z.string())
			.optional()
			.describe(
				"The issues linked to the pattern (link_issue_to_pattern); absent when none.",
			),
		createdBy: z.string().describe("Who recorded the pattern."),
		severity: z
			.string()
			.describe("How much the problem matters: critical, major or minor."),
		createdAt: ms("When the pattern was recorded"),
		updatedAt: ms("When the pattern last changed"),
	}),
	"The fix patterns, newest first; empty when none matches.",
);

/** search_fix_patterns: search:searchFixPatterns `returns:`. */
export const searchFixPatternsServedOutputSchema = matchesOf(
	z.looseObject({
		patternId: rowId("The pattern's ID: the patternId get_fix_pattern takes."),
		score: z
			.number()
			.describe(
				"How close the pattern's symptom is in meaning to the query (cosine similarity, higher is closer).",
			),
		symptom: z.string().describe("What was observed going wrong."),
		rootCause: z.string().describe("What actually caused it."),
		validatedFix: z
			.string()
			.optional()
			.describe("The fix confirmed to work; absent until one is validated."),
		tags: z
			.array(z.string())
			.describe("Free labels on the pattern; empty when none."),
		stack: z
			.array(z.string())
			.describe("The technologies the pattern applies to; empty when none."),
		sourceProject: z.string().describe("The project where it was first seen."),
		severity: z
			.string()
			.describe("How much the problem matters: critical, major or minor."),
	}),
	"The fix patterns closest in meaning to the query, best match first; empty when none passes the similarity threshold.",
);

const toolUsageRow = z.looseObject({
	tool: z.string().describe("The MCP tool's name, e.g. 'store_memory'."),
	firstAt: ms("When the tool was first called"),
	lastAt: ms("When the tool was last called"),
	count: z.number().describe("How many times the tool was called."),
});

/** get_tool_usage: toolUsage:getToolUsage `returns:`. */
export const getToolUsageServedOutputSchema = matchesOf(
	toolUsageRow,
	"One row per tool the caller has called; empty when it has called none.",
);

/** get_owner_tool_usage: toolUsage:usageByOwner `returns:`. */
export const getOwnerToolUsageServedOutputSchema = matchesOf(
	toolUsageRow,
	"One row per tool, summed across the person's agents and its own calls; empty when none was called.",
);

// ── null-able reads, the inbox, Knowledge Base / OKF (task
// k170byeq1nzzv2q1z6qpag5fp18hvj8a, outputs 2/3) ────────────────────────────
// The text of these tools is unchanged (src/structuredResult.ts says how the
// structured form is derived from the same values).

/**
 * A read that may find nothing: { found: true, item } or { found: false, id }.
 * One object (an outputSchema is an object at the top), `found` decides which
 * of the two other fields is present.
 */
const foundOf = (item: z.ZodType, what: string, id: string) =>
	z.looseObject({
		found: z
			.boolean()
			.describe(
				`True when the ${what} exists and is visible to you (then item holds it); false when it does not or is not visible (then id says what was asked for). The text is the ${what} as JSON, or null.`,
			),
		item: item
			.optional()
			.describe(`The ${what}; present when found is true, absent otherwise.`),
		id: z
			.string()
			.optional()
			.describe(`${id}; present when found is false, absent otherwise.`),
	});

const profileRow = z.looseObject({
	_id: rowId("The profile row's ID."),
	_creationTime: creationTime,
	orchestratorId: z
		.string()
		.describe("The orchestrator's name, as the tools take it."),
	instanceId: z
		.string()
		.optional()
		.describe(
			"The instance the orchestrator runs as, e.g. 'sigma-vps'; absent when none was recorded.",
		),
	agentId: z
		.string()
		.optional()
		.describe(
			"The agent the profile belongs to, by its permanent ID; absent on profiles written before it was recorded.",
		),
	name: z.string().describe("The orchestrator's display name."),
	static: z
		.looseObject({
			role: z.string().describe("What the orchestrator is for."),
			workspace: z
				.string()
				.describe("The orchestrator's primary working directory."),
			capabilities: z
				.array(z.string())
				.describe(
					"Keywords for what the orchestrator can do; empty when none.",
				),
		})
		.describe("Identity facts that rarely change."),
	dynamic: z
		.looseObject({
			currentTask: z
				.string()
				.optional()
				.describe(
					"What the orchestrator is working on; absent when it set none.",
				),
			endOfDayIndex: z
				.string()
				.optional()
				.describe(
					"The index written at the end of its last working day; absent when none was written.",
				),
			lastSeen: ms("When the orchestrator was last active"),
			sessionCount: z
				.number()
				.describe("How many sessions the orchestrator has run."),
		})
		.describe("Session state, updated each session."),
});

/** get_profile: profiles:getProfile `returns:` (profileDocValidator) or null. */
export const getProfileServedOutputSchema = foundOf(
	profileRow,
	"profile",
	"The orchestratorId that was asked for",
);

const missionRow = z.looseObject({
	_id: rowId("The mission's ID: the missionId the mission tools take."),
	_creationTime: creationTime,
	name: z.string().describe("The mission's name."),
	description: z
		.string()
		.optional()
		.describe("What the mission is for; absent when none was given."),
	project: z.string().describe("The project the mission belongs to."),
	status: z
		.string()
		.describe(
			"Which stage the mission is at: brainstorm, plan, execute, validate, complete or cancelled.",
		),
	priority: z
		.string()
		.describe("How urgent the mission is: urgent, high, medium or low."),
	pilot: z.string().describe("The orchestrator leading the mission, by name."),
	agents: z
		.array(z.string())
		.describe("The orchestrators working on the mission, by name."),
	brief: z
		.string()
		.optional()
		.describe("The mission brief; absent when none was given."),
	startDate: z
		.number()
		.optional()
		.describe(
			"When work is planned to start (milliseconds since the Unix epoch); absent when not set.",
		),
	targetDate: z
		.number()
		.optional()
		.describe(
			"When the mission should be done (milliseconds since the Unix epoch); absent when not set.",
		),
	progress: z
		.number()
		.optional()
		.describe(
			"How far the mission has got, as a percentage; absent when never set.",
		),
	createdBy: z.string().describe("Who created the mission."),
	createdAt: ms("When the mission was created"),
	updatedAt: ms("When the mission last changed"),
	orgId: orgSlug("mission"),
	clerkOrgId: clerkOrgId("mission"),
	cancelledBy: z
		.string()
		.optional()
		.describe("Who cancelled the mission; absent unless it is cancelled."),
	cancelReason: z
		.string()
		.optional()
		.describe("Why the mission was cancelled; absent unless it is cancelled."),
	lastActedBy: z
		.string()
		.optional()
		.describe(
			"The person ('user:<subject>') who last created, edited or cancelled the mission from the dashboard; absent when only agents did.",
		),
	pilotId: actorId("the pilot"),
	agentIds: z
		.array(z.string())
		.optional()
		.describe(
			"The permanent IDs of the orchestrators in agents; absent on missions written before they were recorded.",
		),
	createdById: actorId("the creator"),
	cancelledById: actorId("whoever cancelled it"),
});

/** get_mission: missions:get `returns:` or null. */
export const getMissionServedOutputSchema = foundOf(
	missionRow,
	"mission",
	"The missionId that was asked for",
);

const templateRow = z.looseObject({
	_id: rowId("The template's ID."),
	_creationTime: creationTime,
	name: z
		.string()
		.describe(
			"The template's unique name, as instantiate_template_into_mission takes it.",
		),
	description: z
		.string()
		.optional()
		.describe("What the template is for; absent when none was given."),
	brief: z
		.string()
		.optional()
		.describe(
			"The brief a mission made from it gets when none is supplied; absent when none.",
		),
	steps: z
		.array(
			z.looseObject({
				title: z.string().describe("The title of the task the step creates."),
				description: z
					.string()
					.describe("The brief of the task the step creates."),
				tags: z
					.array(z.string())
					.optional()
					.describe("Labels the task gets; absent when none."),
				assignedTo: z
					.string()
					.optional()
					.describe(
						"The orchestrator role the task is assigned to; absent when the instantiation decides.",
					),
				assignedToInstance: z
					.string()
					.optional()
					.describe(
						"The instance the task is assigned to; absent when none is fixed.",
					),
				dependsOn: z
					.array(z.number())
					.optional()
					.describe(
						"The 0-based indexes of the steps this one waits on; absent when it waits on none.",
					),
			}),
		)
		.describe("The steps, in order; each becomes one task."),
	isDefault: z
		.boolean()
		.describe("True when the template is a default of the catalogue."),
	createdBy: z.string().describe("Who saved the template."),
	createdAt: ms("When the template was first saved"),
	updatedAt: ms("When the template last changed"),
	deletedAt: z
		.number()
		.optional()
		.describe(
			"When the template was soft-deleted (milliseconds since the Unix epoch); absent on a live template, the only kind a read returns.",
		),
});

/** get_mission_template: missionTemplates:getByName `returns:` or null. */
export const getMissionTemplateServedOutputSchema = foundOf(
	templateRow,
	"template",
	"The template name that was asked for",
);

/** get_diary: diary:get `returns:` or null. */
export const getDiaryServedOutputSchema = foundOf(
	diaryRow,
	"diary entry",
	"What was asked for, as '<orchestrator>/<date>'",
);

const stuckList = (what: string) =>
	z
		.looseObject({
			entries: z
				.array(
					z.looseObject({
						taskId: rowId("The task's ID."),
						title: z.string().describe("The task's title."),
						age: z
							.number()
							.describe(
								"How long the task has been in progress, in milliseconds (since its open work segment started, else since it started).",
							),
					}),
				)
				.describe(`${what}; empty when there are none.`),
			total: z
				.number()
				.describe(
					"How many such tasks were found, including any beyond entries.",
				),
			truncated: z
				.boolean()
				.describe(
					"True when the bounded scan stopped early, so more such tasks may exist.",
				),
			actionableStuckCount: z
				.number()
				.describe(
					"How many entries have no open work segment and are past the stuck threshold: the ones that call for action.",
				),
		})
		.describe(
			`${what}. The text shows this block only when entries is non-empty or truncated is true.`,
		);

/** check_messages: built from messages:checkNewMessagesEnvelope `returns:`. */
export const checkMessagesServedOutputSchema = z.looseObject({
	messages: z
		.array(
			z.looseObject({
				receiptId: rowId(
					"The receipt to pass to mark_as_read once the message is handled.",
				),
				from: z
					.string()
					.describe("The sender: the agent or person who wrote it."),
				fromInstanceId: z
					.string()
					.optional()
					.describe(
						"The sender's instance, e.g. 'pi-vps'; absent when none was recorded.",
					),
				fromId: actorId("the sender"),
				channel: z
					.string()
					.optional()
					.describe(
						"Where it was sent: an agent's name, a comma-separated list of names, or 'broadcast'; absent when the backend did not return it.",
					),
				content: z.string().describe("The full message body."),
				createdAt: ms("When the message was sent"),
			}),
		)
		.describe(
			"The unread messages, oldest first; empty when there are none (the text then says 'No new messages.' or shows only the stuck blocks).",
		),
	truncated: z
		.boolean()
		.describe(
			"True when more unread messages exist than this page holds; pass nextSince as since to read on.",
		),
	nextSince: z
		.number()
		.nullable()
		.describe(
			"The since value that resumes after this page; null when truncated is false.",
		),
	stuckInProgress: stuckList("Your own tasks in progress, of any age"),
	peersStuckOnYou: stuckList(
		"Tasks you created that are in progress with someone else",
	),
});

/** export_okf_bundle: okfBundleNode:exportOkfBundle (ExportOkfBundleResult). */
export const exportOkfBundleServedOutputSchema = z.looseObject({
	bundleUrl: z
		.string()
		.describe(
			"The signed URL the tarball downloads from, until manifest.urlExpiresAt.",
		),
	storageId: rowId(
		"The stored tarball, which import_okf_bundle takes as storageId.",
	),
	size: z.number().describe("The tarball's size, in bytes."),
	fileCount: z.number().describe("How many files the tarball holds."),
	manifest: z
		.looseObject({
			types: z
				.looseObject({
					memoryCount: z.number().describe("How many memories were exported."),
					briefingCount: z
						.number()
						.describe("How many briefing notes were exported."),
					taskCount: z.number().describe("How many tasks were exported."),
				})
				.describe("What the bundle holds, by record family."),
			truncated: z
				.boolean()
				.describe(
					"True when a size bound stopped the export early, so the bundle is incomplete.",
				),
			urlExpiresAt: z
				.string()
				.describe(
					"When bundleUrl stops working and the stored bundle is purged, as an ISO 8601 timestamp.",
				),
		})
		.describe("What the bundle contains and how long it is kept."),
});

/** import_okf_bundle: okfBundleNode:importOkfBundle (ImportOkfBundleResult). */
export const importOkfBundleServedOutputSchema = z.looseObject({
	imported: z
		.looseObject({
			memories: z
				.number()
				.describe("Memories written (in dry-run: that a merge would write)."),
			briefings: z
				.number()
				.describe(
					"Briefing notes written (in dry-run: that a merge would write).",
				),
			tasks: z
				.number()
				.describe("Tasks written (in dry-run: that a merge would write)."),
		})
		.describe("What the import wrote, by record family."),
	skipped: z
		.number()
		.describe("Entries left out because the same content is already stored."),
	conflicts: z
		.array(
			z.looseObject({
				path: z
					.string()
					.describe("The bundle file that could not be imported."),
				reason: z.string().describe("Why it could not be imported."),
			}),
		)
		.describe("The bundle files that could not be imported; empty when none."),
});

/** store_document_chunked: kb:storeDocumentChunked `returns:`. */
export const storeDocumentChunkedServedOutputSchema = z.looseObject({
	docId: z
		.string()
		.describe(
			"The document's ID: pass it again to replace the document, or to soft_delete_document.",
		),
	chunkCount: z
		.number()
		.describe("How many searchable chunks the document was split into."),
	storageId: rowId("The uploaded file the document was read from."),
});

/** soft_delete_document: kb:softDeleteDocument `returns:`. */
export const softDeleteDocumentServedOutputSchema = z.looseObject({
	docId: z.string().describe("The document that was soft-deleted."),
	markedCount: z
		.number()
		.describe(
			"How many of its chunks were marked deleted; 0 when none were live.",
		),
});

/** generate_upload_url: its two text items as one object. */
export const generateUploadUrlServedOutputSchema = z.looseObject({
	uploadUrl: z
		.string()
		.describe(
			"The one-time URL to POST the file to; the response gives its storageId. The text's first item is this URL alone.",
		),
	ticket: z
		.string()
		.nullable()
		.describe(
			"The upload ticket claim_upload takes with that storageId; null when no sha256 was passed, so the file can never be claimed.",
		),
	expiresAt: z
		.number()
		.optional()
		.describe(
			"When the ticket expires (milliseconds since the Unix epoch); absent when there is no ticket.",
		),
	note: z
		.string()
		.optional()
		.describe(
			"Why there is no ticket; present only when no sha256 was passed.",
		),
});

/** claim_upload: kbMutations:claimUpload `returns:`. */
export const claimUploadServedOutputSchema = z.looseObject({
	storageId: rowId(
		"The uploaded file, now bound to your organisation: store_document_chunked and import_okf_bundle accept it.",
	),
	orgId: z.string().describe("The organisation the file is bound to, by slug."),
});

// ── the last ten (task k17d1q04zkfqnwxnjf6rjdbtqh8htnd0, coverage 3/3) ─────
// Each answers the same object as its JSON text; debate_get_room's transcript
// goes through capPage (the room whole, the turns cut and declared when the
// whole answer exceeds the cap).

/** improvisation_digest: improvisationDigest:scanWindow `returns:`. */
export const improvisationDigestServedOutputSchema = z.looseObject({
	countsByOrch: z
		.record(z.string(), z.number())
		.describe(
			"For each orchestrator (by name), how many of its artifacts in the window state fleet facts without a source citation; an orchestrator with none is absent.",
		),
	countsByCategory: z
		.record(z.string(), z.number())
		.describe(
			"How many flagged artifacts each writing tool produced: complete_task (closing notes), send_message (messages), store_memory (memories).",
		),
	samples: z
		.array(
			z.looseObject({
				orchestrator: z
					.string()
					.describe("The orchestrator the artifact belongs to, by name."),
				day: z
					.string()
					.describe("The day the artifact was written, as YYYY-MM-DD."),
				category: z
					.string()
					.describe(
						"The tool that wrote it: complete_task, send_message or store_memory.",
					),
				snippet: z
					.string()
					.describe("The first 200 characters of the artifact's text."),
				artifactId: rowId(
					"The flagged task, message or memory, by its ID (get_task, get_message or get_memory reads it).",
				),
			}),
		)
		.describe(
			"Up to 50 flagged artifacts, newest first; empty when none was flagged.",
		),
});

/** debate_post_turn: the accepted branch of debate:postTurn (a refusal is an error result). */
export const debatePostTurnServedOutputSchema = z.looseObject({
	accepted: z
		.boolean()
		.describe("True: the turn was recorded in the room's transcript."),
	turnSeq: z.number().describe("The turn number that was recorded."),
	closed: z
		.boolean()
		.describe("True when this turn closed the room (see closeReason)."),
	closeReason: z
		.string()
		.optional()
		.describe(
			"Why the room closed: round_limit, operator_stop, all_done or all_silent; absent while the room stays open.",
		),
	workDuringTurn: z
		.string()
		.describe(
			"Whether work was done while the turn was open: always 'could_not_judge' for an agent today (the backend does not judge it), 'not_applicable' for a person.",
		),
});

const debateParticipant = z.looseObject({
	id: z.string().describe("The seat's ID in the template, e.g. 'p1'."),
	label: z.string().describe("The seat's display name."),
	kind: z.string().describe("Who sits there: agent or human."),
	channel: z
		.string()
		.optional()
		.describe(
			"The person a human seat is ('user:<subject>'); absent on an agent seat, and on the room creator's own seat.",
		),
	agentId: z
		.string()
		.optional()
		.describe(
			"The agent that sits at an agent seat, by its permanent ID; absent on a human seat.",
		),
	instanceId: z
		.string()
		.optional()
		.describe("The instance the turn is delivered to; absent when any."),
	transport: z
		.string()
		.describe("How a turn reaches the seat: waker, live-session or human."),
	deadlineSeconds: z
		.number()
		.nullable()
		.optional()
		.describe(
			"How long the seat has per turn, in seconds; null to wait without limit, absent for the template default.",
		),
	expectedLatencySeconds: z
		.number()
		.optional()
		.describe(
			"How long the seat usually takes to answer; absent when unknown.",
		),
	latencySource: z
		.string()
		.optional()
		.describe("Where expectedLatencySeconds comes from; absent when unknown."),
	latencyDeclaredAt: z
		.number()
		.optional()
		.describe(
			"When that latency was declared (milliseconds since the Unix epoch); absent when unknown.",
		),
	voiceKey: z
		.string()
		.nullable()
		.optional()
		.describe("The voice the seat speaks with; null or absent for none."),
});

const debateRoomRow = z.looseObject({
	_id: rowId("The room's ID: the roomId the debate tools take."),
	_creationTime: creationTime,
	tenantId: z.string().describe("The slug of the organisation the room is in."),
	tenantOrgId: z.string().describe("The permanent ID of that organisation."),
	templateId: rowId("The template the room was created from."),
	template: z
		.looseObject({
			id: z.string().describe("The template's key within its organisation."),
			name: z.string().describe("The template's display name."),
			language: z
				.string()
				.describe("The language turns are asked in, e.g. 'en'."),
			turnInstruction: z
				.string()
				.describe("The instruction every turn message carries."),
			participants: z
				.array(debateParticipant)
				.describe("The seats, in speaking order."),
			roundLimit: z.number().describe("How many rounds the room runs at most."),
			maxAnswerChars: z
				.number()
				.describe("The longest answer a turn accepts, in characters."),
			turnDeadlineSeconds: z
				.number()
				.describe("The default time a seat has per turn, in seconds."),
			maxConsecutiveSkips: z
				.number()
				.describe(
					"How many turns in a row a seat may miss before it is dropped.",
				),
			voiceEnabled: z.boolean().describe("Whether turns are also voiced."),
		})
		.describe(
			"The template, frozen when the room was created: later edits of the template do not reach a running room.",
		),
	settings: z
		.looseObject({
			maxRoundLimit: z.number().describe("The highest round limit allowed."),
			maxParticipants: z.number().describe("The most seats a room may have."),
			maxRefusalRows: z
				.number()
				.describe("How many refused turns are written to the transcript."),
			maxTurnMessageChars: z
				.number()
				.describe("The longest turn message, in characters."),
			pollSeconds: z
				.number()
				.describe("How often a waiting seat is polled, in seconds."),
			maxAnswerCharsCeiling: z
				.number()
				.describe("The highest maxAnswerChars a template may set."),
			maxLabelChars: z
				.number()
				.describe("The longest name or seat label, in characters."),
			maxTurnInstructionChars: z
				.number()
				.describe("The longest turn instruction, in characters."),
			maxActiveRooms: z
				.number()
				.describe("How many rooms of one organisation may be open at once."),
		})
		.describe(
			"The organisation's debate settings, frozen when the room was created.",
		),
	subject: z.string().describe("What the room debates."),
	status: z.string().describe("Where the room is: active, stalled or closed."),
	closeReason: z
		.string()
		.optional()
		.describe(
			"Why it closed: round_limit, operator_stop, all_done or all_silent; absent while it is open.",
		),
	round: z.number().describe("The current round, counting from 1."),
	position: z
		.number()
		.describe(
			"The seat whose turn it is, as an index into template.participants (from 0).",
		),
	turnSeq: z.number().describe("The number of the current turn."),
	awaiting: z
		.looseObject({
			participantId: z.string().describe("The seat the room waits on."),
			messageId: z
				.string()
				.optional()
				.describe(
					"The turn message sent to that seat; absent before it was delivered.",
				),
			deliveredAt: z
				.number()
				.optional()
				.describe(
					"When it was delivered (milliseconds since the Unix epoch); absent before.",
				),
			deadlineAt: z
				.number()
				.optional()
				.describe(
					"When the turn expires (milliseconds since the Unix epoch); absent when it does not.",
				),
		})
		.optional()
		.describe(
			"Whose answer the room waits for; absent when it waits on nobody.",
		),
	participantState: z
		.array(
			z.looseObject({
				participantId: z.string().describe("The seat."),
				consecutiveSkips: z
					.number()
					.describe("How many turns in a row it has missed."),
				dropped: z
					.boolean()
					.describe("True once it missed too many turns and left the room."),
				roundKind: z
					.string()
					.optional()
					.describe(
						"What it did this round: answer or skipped; absent before it spoke.",
					),
				roundDone: z
					.boolean()
					.optional()
					.describe(
						"True when it said it has nothing more to add this round; absent otherwise.",
					),
			}),
		)
		.describe("Each seat's state in the current round."),
	createdBy: z
		.string()
		.describe("Who created the room, the sender of every turn message."),
	createdById: z
		.string()
		.describe(
			"The permanent ID of the room's creator ('user:<subject>' for a person).",
		),
	createdAt: ms("When the room was created"),
	closedAt: z
		.number()
		.optional()
		.describe(
			"When the room closed (milliseconds since the Unix epoch); absent while it is open.",
		),
	refusalRows: z
		.number()
		.describe("How many refused turns were written to the transcript."),
	refusalsOverflow: z
		.number()
		.describe(
			"How many refused turns beyond settings.maxRefusalRows were only counted.",
		),
});

const debateTurnRow = z.looseObject({
	_id: rowId("The turn row's ID."),
	_creationTime: creationTime,
	roomId: rowId("The room the turn belongs to."),
	turnSeq: z.number().describe("The turn's number."),
	round: z.number().describe("The round it was in."),
	position: z
		.number()
		.describe("The seat's index in template.participants (from 0)."),
	participantId: z
		.string()
		.optional()
		.describe("The seat that spoke; absent on a system row."),
	kind: z
		.string()
		.describe(
			"What the row is: answer, operator, skipped, dropped, refused or system.",
		),
	writer: z
		.string()
		.describe(
			"The backend function that wrote it: postTurn, expireTurn, closeRoom or deliverTurn.",
		),
	text: z
		.string()
		.optional()
		.describe("What was said; absent on a row that carries no text."),
	reason: z
		.string()
		.optional()
		.describe(
			"The refusal reason, or the close reason of a final system row; absent otherwise.",
		),
	done: z
		.boolean()
		.optional()
		.describe(
			"True when the seat said it has nothing more to add; absent otherwise.",
		),
	workDuringTurn: z
		.string()
		.optional()
		.describe(
			"Whether work was done while the turn was open: 'could_not_judge' on an agent's answer today; absent on rows that do not record it.",
		),
	deadlineAt: z
		.number()
		.optional()
		.describe(
			"The deadline a skipped turn expired at (milliseconds since the Unix epoch); absent otherwise.",
		),
	audioStorageId: z
		.string()
		.optional()
		.describe("The stored voice recording of the turn; absent without voice."),
	voiceMark: z
		.string()
		.optional()
		.describe("The voice worker's mark on the turn; absent without voice."),
	postedAt: ms("When the turn was posted"),
});

/** debate_get_room: debate:getRoom `returns:` (null is an error result). */
export const debateGetRoomServedOutputSchema = z.looseObject({
	room: debateRoomRow.describe("The room, whole."),
	turns: z
		.array(debateTurnRow)
		.describe(
			"The transcript, in order; only its first turns when truncated is true.",
		),
	truncated: z
		.boolean()
		.optional()
		.describe(
			"True when the answer exceeded the 60 KB response cap and turns holds only the first turns (the text then says so in _meta); absent when turns is the whole transcript.",
		),
});

/** erase_memory: redactResultValidator, the same for its three doors. */
export const eraseMemoryServedOutputSchema = z.looseObject({
	memoryId: rowId("The memory that was erased from."),
	replacements: z
		.number()
		.describe(
			"How many occurrences were replaced, across the memory's versions.",
		),
	contentHashChanged: z
		.boolean()
		.describe("True when the stored content hash was recomputed."),
});

/** erase_row: erase:eraseRow `returns:`. */
export const eraseRowServedOutputSchema = z.looseObject({
	table: z.string().describe("The table the row was erased from."),
	rowId: rowId("The row that was erased."),
	erased: z.boolean().describe("True: the row is deleted."),
	cascaded: z
		.record(z.string(), z.number())
		.describe(
			"For each dependent table, how many rows were deleted with it (receipts, turns, participants); empty when none.",
		),
});

/** bulk_complete_tasks: tasks:bulkComplete `returns:` (dry run and live run). */
export const bulkCompleteTasksServedOutputSchema = z.looseObject({
	count: z
		.number()
		.describe(
			"How many tasks match (dry run) or were closed (live run); a lower bound when remaining is true.",
		),
	sampleIds: z
		.array(z.string())
		.describe("Up to 10 of those tasks, by ID; empty when none matched."),
	bulkRunId: z
		.string()
		.describe(
			"The run's ID, the evidence of the call; get_bulk_complete_run reads a live run.",
		),
	executedAt: z
		.number()
		.optional()
		.describe(
			"When the live run closed the tasks (milliseconds since the Unix epoch); absent on a dry run.",
		),
	cappedAt: z
		.number()
		.optional()
		.describe(
			"The per-call cap (500) when more tasks matched than one call closes; absent otherwise.",
		),
	remaining: z
		.boolean()
		.optional()
		.describe(
			"True when matching tasks are left beyond the cap (a live run drains them in the background); absent otherwise.",
		),
});

/** create_fix_pattern. */
export const createFixPatternServedOutputSchema = z.looseObject({
	patternId: rowId("The new fix pattern."),
	created: z.boolean().describe("True: the pattern was written."),
});

/** add_fix_attempt. */
export const addFixAttemptServedOutputSchema = z.looseObject({
	attemptId: rowId("The attempt that was recorded."),
	patternId: rowId("The fix pattern it was recorded on."),
	worked: z
		.boolean()
		.describe("Whether the attempt fixed the problem, as given."),
});

/** update_mission_template. */
export const updateMissionTemplateServedOutputSchema = z.looseObject({
	templateId: rowId("The template that was written."),
	name: z.string().describe("Its unique name."),
	stepCount: z.number().describe("How many steps it now has."),
});

/** instantiate_template_into_mission: missionTemplates:instantiateTemplateIntoMission `returns:`. */
export const instantiateTemplateIntoMissionServedOutputSchema = z.looseObject({
	taskIds: z
		.array(z.string())
		.describe(
			"The tasks created in the mission, one per template step, in order.",
		),
	count: z.number().describe("How many tasks were created."),
});
