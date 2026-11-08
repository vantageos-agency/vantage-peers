/**
 * The outputSchema each structured tool ADVERTISES in tools/list (task
 * k1793xkjhzh1xm23gmmwjgwfyx8htbv0, PR C, finding 6).
 *
 * A tool declares one only when every success path of its handler returns
 * `structuredContent` that is the same object as its JSON text. The SDK then
 * validates that object against the schema on every call, so a schema here is a
 * contract the handler must honour, not documentation:
 *
 *   - every object is OPEN (z.looseObject): a client validates against the
 *     schema it read at connect time, so a field added later must still pass
 *     (task k17e9sx6e8wd951b47wvm0p5qn8hampb, output-schema-additive.test.ts);
 *   - only what the Convex `returns:` validator (or the handler's own
 *     construction) guarantees is required; a value whose set may grow
 *     (a status, a priority) is a string, never a closed enum;
 *   - an error result (isError) carries no structuredContent and is not
 *     validated (the SDK skips it).
 *
 * Which tools declare one, and why each other tool does not, is decided in
 * test/lib/toolMetadataDecisions.ts; every schema here is validated on a real
 * success through /mcp by test/output-schema-structured-content.test.ts.
 */

import { z } from "zod";

const id = z.string().describe("A Convex document ID.");
const creationTime = z
	.number()
	.describe("When the row was created (a millisecond timestamp).");
const looseRow = z.looseObject({});

// ── single-row reads ─────────────────────────────────────────────────────────

const memoryRow = {
	_id: id,
	_creationTime: creationTime,
	namespace: z.string(),
	type: z.string(),
	content: z.string(),
	createdBy: z.string(),
	relations: z.array(z.looseObject({ targetId: z.string(), type: z.string() })),
	isLatest: z.boolean(),
	createdAt: z.number(),
	updatedAt: z.number(),
};

/** get_memory: the memory row (memories:getMemory `returns:`). */
export const getMemoryServedOutputSchema = z.looseObject(memoryRow);

/** get_episode: a memory row of type episode, with its structured fields. */
export const getEpisodeServedOutputSchema = z.looseObject({
	...memoryRow,
	episode: z
		.looseObject({
			context: z.string(),
			goal: z.string(),
			action: z.string(),
			outcome: z.string(),
			insight: z.string(),
			severity: z.string(),
		})
		.optional(),
});

/** get_task: the task row (tasks:getById, taskFullValidator). */
export const getTaskServedOutputSchema = z.looseObject({
	_id: id,
	_creationTime: creationTime,
	title: z.string(),
	assignedTo: z.string(),
	priority: z.string(),
	status: z.string(),
});

/** get_fix_pattern: the pattern with its attempts (fixPatterns:get `returns:`). */
export const getFixPatternServedOutputSchema = z.looseObject({
	_id: id,
	_creationTime: creationTime,
	symptom: z.string(),
	rootCause: z.string(),
	tags: z.array(z.string()),
	stack: z.array(z.string()),
	sourceProject: z.string(),
	createdBy: z.string(),
	severity: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
	attempts: z.array(
		z.looseObject({
			_id: id,
			description: z.string(),
			worked: z.boolean(),
			why: z.string(),
			createdBy: z.string(),
			createdAt: z.number(),
		}),
	),
});

/** get_message: the message row (messages:getById). */
export const getMessageServedOutputSchema = z.looseObject({
	_id: id,
	_creationTime: creationTime,
	from: z.string(),
	channel: z.string(),
	content: z.string(),
});

/** get_recurring_task: the recurring template row (recurringTasks:getById). */
export const getRecurringTaskServedOutputSchema = z.looseObject({
	_id: id,
	_creationTime: creationTime,
	title: z.string(),
	assignedTo: z.string(),
	priority: z.string(),
	nextRunAt: z.number(),
	active: z.boolean(),
	createdBy: z.string(),
});

/** get_briefing_note: the note row (briefingNotes:get, briefingNoteFullValidator). */
export const getBriefingNoteServedOutputSchema = z.looseObject({
	_id: id,
	_creationTime: creationTime,
	title: z.string(),
	topic: z.string(),
	participants: z.array(z.string()),
	content: z.string(),
	createdBy: z.string(),
	createdAt: z.number(),
});

/** get_bulk_complete_run: the run row (tasks:getBulkCompleteRun `returns:`). */
export const getBulkCompleteRunServedOutputSchema = z.looseObject({
	bulkRunId: z.string(),
	createdBy: z.string(),
	status: z.string(),
	closed: z.number(),
	remaining: z.boolean(),
	startedAt: z.number(),
	updatedAt: z.number(),
});

// ── fixed envelopes ──────────────────────────────────────────────────────────

/** list_blocked_on_me: built in the handler from tasks:listBlockedOnMe. */
export const listBlockedOnMeServedOutputSchema = z.looseObject({
	entries: z.array(looseRow),
	total: z.number(),
	truncated: z.boolean(),
	oldestAge: z.number(),
});

/** list_broadcast_status: messages:listBroadcastStatus, receipts scope-filtered. */
export const listBroadcastStatusServedOutputSchema = z.looseObject({
	messageId: z.string(),
	from: z.string(),
	channel: z.string().optional(),
	createdAt: z.number(),
	receipts: z.array(
		z.looseObject({ recipient: z.string(), read: z.boolean() }),
	),
	truncated: z.boolean(),
	scopeFiltered: z.number().optional(),
});

/** get_github_owner_bindings: two cursor-paged lists; the second is the fleet master's only. */
export const getGithubOwnerBindingsServedOutputSchema = z.looseObject({
	bindings: z.array(looseRow),
	nextCursor: z.string().nullable(),
	unprovenMappings: z.array(looseRow).optional(),
	unprovenNextCursor: z.string().nullable().optional(),
});

/** billing_summary_by_project: tasks:billingSummaryByProject `returns:`. */
export const billingSummaryByProjectServedOutputSchema = z.looseObject({
	byProject: z.array(
		z.looseObject({
			project: z.string(),
			totalMinutes: z.number(),
			taskCount: z.number(),
			legacyTaskCount: z.number(),
			legacyMinutes: z.number(),
		}),
	),
	unattributedTaskCount: z.number(),
	noProjectCount: z.number(),
	noDurationCount: z.number(),
	noDurationTasks: z.array(looseRow).optional(),
	noDurationTasksTruncated: z.boolean().optional(),
	invalidDurationTaskCount: z.number(),
	truncated: z.boolean(),
});

// ── writes: the handler builds the answer from a fixed set of keys ───────────

export const storeMemoryServedOutputSchema = z.looseObject({
	memoryId: z.string(),
	namespace: z.string(),
	type: z.string(),
	content: z.string(),
	createdBy: z.string().nullable().optional(),
});

export const softDeleteMemoryServedOutputSchema = z.looseObject({
	deleted: z.boolean(),
	memoryId: z.string(),
});

/** update_task. */
export const taskUpdatedServedOutputSchema = z.looseObject({
	taskId: z.string(),
	updated: z.boolean(),
});

/** start_task, pause_task, resume_task: the status the task moved to. */
export const taskStatusServedOutputSchema = z.looseObject({
	taskId: z.string(),
	status: z.string(),
});

export const missionUpdatedServedOutputSchema = z.looseObject({
	missionId: z.string(),
	updated: z.boolean(),
});

export const missionStatusServedOutputSchema = z.looseObject({
	missionId: z.string(),
	status: z.string(),
});

export const writeDiaryServedOutputSchema = z.looseObject({
	diaryId: z.string(),
	date: z.string(),
	orchestrator: z.string(),
});

export const briefingNoteUpdatedServedOutputSchema = z.looseObject({
	noteId: z.string(),
	updated: z.boolean(),
});

export const createRecurringTaskServedOutputSchema = z.looseObject({
	taskId: z.string(),
	cronExpression: z.string(),
});

// ── more writes (same rule: the handler's own construction, or the Convex
//    `returns:` validator it passes through) ──────────────────────────────────

/** create_task: the task as created (tasks:create returns its ID). */
export const createTaskServedOutputSchema = z.looseObject({
	taskId: z.string(),
	title: z.string(),
	assignedTo: z.string(),
	priority: z.string(),
	status: z.string(),
});

/** complete_task, fail_task: the status the task closed with. */
export const taskClosedServedOutputSchema = taskStatusServedOutputSchema;

/** block_task: the block as recorded. */
export const blockTaskServedOutputSchema = z.looseObject({
	taskId: z.string(),
	status: z.string(),
	reason: z.string(),
	blockedOnTaskId: z.string().optional(),
	blockedCause: z.string(),
	dependsOn: z.array(z.string()).optional(),
});

/** add_task_dependency: the resulting dependency list. */
export const addTaskDependencyServedOutputSchema = z.looseObject({
	taskId: z.string(),
	dependsOn: z.array(z.string()),
	updated: z.boolean(),
});

/** checkout_task: tasks:checkout `returns:` (claimed false says why). */
export const checkoutTaskServedOutputSchema = z.looseObject({
	claimed: z.boolean(),
	reason: z.string().optional(),
});

/** delete_task, delete_recurring_task: { deleted } from the Convex door. */
export const deletedServedOutputSchema = z.looseObject({
	deleted: z.boolean(),
});

/** correct_task_segment. */
export const correctTaskSegmentServedOutputSchema = z.looseObject({
	taskId: z.string(),
	segmentIndex: z.number(),
	corrected: z.boolean(),
});

/** create_mission. */
export const createMissionServedOutputSchema = z.looseObject({
	missionId: z.string(),
	name: z.string(),
	project: z.string(),
	pilot: z.string(),
	status: z.string(),
});

/** create_briefing_note. */
export const createBriefingNoteServedOutputSchema = z.looseObject({
	noteId: z.string(),
	title: z.string(),
	topic: z.string(),
	createdBy: z.string().nullable().optional(),
});

/** store_episode. */
export const storeEpisodeServedOutputSchema = z.looseObject({
	memoryId: z.string(),
	type: z.string(),
	severity: z.string(),
	namespace: z.string(),
	createdBy: z.string().nullable().optional(),
});

/** update_profile. */
export const updateProfileServedOutputSchema = z.looseObject({
	profileId: z.string(),
	orchestratorId: z.string(),
	name: z.string().optional(),
});

/** set_summary. */
export const setSummaryServedOutputSchema = z.looseObject({
	orchestratorId: z.string(),
	instanceId: z.string().optional(),
	summary: z.string(),
});

/** send_message: recipients by ID, or the channel; stateUnverified when a stated state could not be checked. */
export const sendMessageServedOutputSchema = z.looseObject({
	messageId: z.string(),
	from: z.string(),
	recipientAgentIds: z.array(z.string()).optional(),
	channel: z.string().optional(),
	stateUnverified: z.array(z.unknown()).optional(),
});

/** mark_as_read: how many receipts were newly marked. */
export const markAsReadServedOutputSchema = z.looseObject({
	markedAsRead: z.number(),
});

/** delete_message: messages:deleteMessage `returns:`. */
export const deleteMessageServedOutputSchema = z.looseObject({
	deleted: z.boolean(),
	receiptsDeleted: z.number(),
});

/** update_recurring_task. */
export const updateRecurringTaskServedOutputSchema = z.looseObject({
	recurringTaskId: z.string(),
	updated: z.boolean(),
});

/** pause_recurring_task: recurringTasks:pause `returns:`. */
export const pauseRecurringTaskServedOutputSchema = z.looseObject({
	taskId: z.string(),
	active: z.boolean(),
});

/** resume_recurring_task: recurringTasks:resume `returns:`. */
export const resumeRecurringTaskServedOutputSchema = z.looseObject({
	taskId: z.string(),
	active: z.boolean(),
	nextRunAt: z.number(),
});

/** add_repo_mapping: the mapping as stored. */
export const addRepoMappingServedOutputSchema = z.looseObject({
	id: z.string(),
	repo: z.string(),
	orchestrator: z.string(),
	project: z.string(),
	active: z.boolean(),
	reviewer: z.string().nullable().optional(),
	fallbackReviewer: z.string().nullable().optional(),
});

/** remove_repo_mapping: the repo and whether a mapping was removed. */
export const removeRepoMappingServedOutputSchema = z.looseObject({
	repo: z.string(),
	deleted: z.boolean(),
});

/** validate_fix. */
export const validateFixServedOutputSchema = z.looseObject({
	patternId: z.string(),
	validatedFix: z.string(),
	validated: z.boolean(),
});

/** link_issue_to_pattern. */
export const linkIssueToPatternServedOutputSchema = z.looseObject({
	patternId: z.string(),
	issueId: z.string(),
	linked: z.boolean(),
});
