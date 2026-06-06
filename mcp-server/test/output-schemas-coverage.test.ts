/**
 * Day 92 C1 — outputSchema coverage test suite.
 *
 * B2 §3 standard: every VP MCP tool MUST have a module-level exported
 * outputSchema (Zod object) that matches the handler's success-path return.
 *
 * Asserts:
 *   1. Every tool name listed in the 87-tool matrix has a corresponding
 *      exported `<toolName>OutputSchema` from tools.ts.
 *   2. Each schema is a valid Zod schema (has a `.parse` method).
 *   3. Each schema validates a representative success response for that tool.
 *
 * Mission: k57a36y8w5t085bqr23dsmvb2d882506
 * Task:    k17ecyvk4613tkj720ehfwysxh883z49
 * Phase:   C1 — outputSchema coverage
 * PR:      #667 (B2 standard), whoami precedent commit 5231811
 */

import { describe, expect, it } from "vitest";
import * as tools from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool matrix — all 87 tool names with their exported schema name
// (86 original + validate_task_payload added in Day 92 F1)
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_SCHEMA_MAP: Record<string, keyof typeof tools> = {
	store_memory: "storeMemoryOutputSchema",
	soft_delete_memory: "softDeleteMemoryOutputSchema",
	get_memory: "getMemoryOutputSchema",
	recall: "recallOutputSchema",
	text_search: "textSearchOutputSchema",
	hybrid_search: "hybridSearchOutputSchema",
	store_episode: "storeEpisodeOutputSchema",
	get_profile: "getProfileOutputSchema",
	update_profile: "updateProfileOutputSchema",
	list_memories: "listMemoriesOutputSchema",
	send_message: "sendMessageOutputSchema",
	check_messages: "checkMessagesOutputSchema",
	mark_as_read: "markAsReadOutputSchema",
	delete_message: "deleteMessageOutputSchema",
	set_summary: "setSummaryOutputSchema",
	list_peers: "listPeersOutputSchema",
	list_messages: "listMessagesOutputSchema",
	list_broadcast_status: "listBroadcastStatusOutputSchema",
	create_task: "createTaskOutputSchema",
	list_tasks: "listTasksOutputSchema",
	update_task: "updateTaskOutputSchema",
	complete_task: "completeTaskOutputSchema",
	start_task: "startTaskOutputSchema",
	checkout_task: "checkoutTaskOutputSchema",
	delete_task: "deleteTaskOutputSchema",
	block_task: "blockTaskOutputSchema",
	add_task_dependency: "addTaskDependencyOutputSchema",
	list_tasks_by_mission: "listTasksByMissionOutputSchema",
	create_mission: "createMissionOutputSchema",
	list_missions: "listMissionsOutputSchema",
	get_mission: "getMissionOutputSchema",
	update_mission: "updateMissionOutputSchema",
	update_mission_status: "updateMissionStatusOutputSchema",
	write_diary: "writeDiaryOutputSchema",
	get_diary: "getDiaryOutputSchema",
	list_diaries: "listDiariesOutputSchema",
	create_briefing_note: "createBriefingNoteOutputSchema",
	update_briefing_note: "updateBriefingNoteOutputSchema",
	get_briefing_note: "getBriefingNoteOutputSchema",
	list_briefing_notes: "listBriefingNotesOutputSchema",
	register_component: "registerComponentOutputSchema",
	list_components: "listComponentsOutputSchema",
	get_component: "getComponentOutputSchema",
	update_component: "updateComponentOutputSchema",
	delete_component: "deleteComponentOutputSchema",
	search_components: "searchComponentsOutputSchema",
	create_recurring_task: "createRecurringTaskOutputSchema",
	list_recurring_tasks: "listRecurringTasksOutputSchema",
	pause_recurring_task: "pauseRecurringTaskOutputSchema",
	resume_recurring_task: "resumeRecurringTaskOutputSchema",
	delete_recurring_task: "deleteRecurringTaskOutputSchema",
	update_recurring_task: "updateRecurringTaskOutputSchema",
	create_mandate: "createMandateOutputSchema",
	accept_mandate: "acceptMandateOutputSchema",
	update_mandate: "updateMandateOutputSchema",
	settle_mandate: "settleMandateOutputSchema",
	validate_mandate_spending: "validateMandateSpendingOutputSchema",
	list_mandates: "listMandatesOutputSchema",
	create_bu: "createBuOutputSchema",
	update_bu: "updateBuOutputSchema",
	get_bu: "getBuOutputSchema",
	list_bus: "listBusOutputSchema",
	delete_bu: "deleteBuOutputSchema",
	add_repo_mapping: "addRepoMappingOutputSchema",
	list_repo_mappings: "listRepoMappingsOutputSchema",
	remove_repo_mapping: "removeRepoMappingOutputSchema",
	list_issues: "listIssuesOutputSchema",
	get_issue: "getIssueOutputSchema",
	update_issue_status: "updateIssueStatusOutputSchema",
	link_commit_to_issue: "linkCommitToIssueOutputSchema",
	verify_issue: "verifyIssueOutputSchema",
	issue_stats: "issueStatsOutputSchema",
	create_fix_pattern: "createFixPatternOutputSchema",
	add_fix_attempt: "addFixAttemptOutputSchema",
	validate_fix: "validateFixOutputSchema",
	search_fix_patterns: "searchFixPatternsOutputSchema",
	list_fix_patterns: "listFixPatternsOutputSchema",
	link_issue_to_pattern: "linkIssueToPatternOutputSchema",
	get_mission_template: "getMissionTemplateOutputSchema",
	update_mission_template: "updateMissionTemplateOutputSchema",
	instantiate_template_into_mission: "instantiateTemplateIntoMissionOutputSchema",
	add_deployment: "addDeploymentOutputSchema",
	remove_deployment: "removeDeploymentOutputSchema",
	list_errors: "listErrorsOutputSchema",
	get_error: "getErrorOutputSchema",
	whoami: "whoamiOutputSchema",
	validate_task_payload: "validateTaskPayloadOutputSchema",
};

// ─────────────────────────────────────────────────────────────────────────────
// Representative success responses for schema validation (one per tool)
// ─────────────────────────────────────────────────────────────────────────────

const REPRESENTATIVE_RESPONSES: Record<string, unknown> = {
	store_memory: { memoryId: "abc123def456abc123def456abc12345", namespace: "global", type: "user", content: "test" },
	soft_delete_memory: { deleted: true, memoryId: "abc123def456abc123def456abc12345" },
	get_memory: { _id: "abc123def456abc123def456abc12345", namespace: "global", type: "user", content: "test" },
	recall: [{ _id: "abc123def456abc123def456abc12345", content: "test", score: 0.9 }],
	text_search: [{ _id: "abc123def456abc123def456abc12345", content: "test" }],
	hybrid_search: [{ _id: "abc123def456abc123def456abc12345", content: "test", score: 0.85 }],
	store_episode: { memoryId: "abc123def456abc123def456abc12345", type: "episode", severity: "major", namespace: "orchestrator/pi" },
	get_profile: { _id: "abc123def456abc123def456abc12345", orchestratorId: "pi", name: "Pi" },
	update_profile: { profileId: "abc123def456abc123def456abc12345", orchestratorId: "pi", name: "Pi" },
	list_memories: [{ _id: "abc123def456abc123def456abc12345", content: "test", type: "user" }],
	send_message: { messageId: "abc123def456abc123def456abc12345", from: "pi", channel: "broadcast" },
	check_messages: [{ receiptId: "abc123def456abc123def456abc12345", from: "pi", content: "hello", createdAt: 1700000000000 }],
	mark_as_read: { markedAsRead: 3 },
	delete_message: { deleted: true },
	set_summary: { orchestratorId: "pi", summary: "Working on C1" },
	list_peers: [{ _id: "abc123def456abc123def456abc12345", id: "pi", instanceId: "pi", role: "lead", workspace: "/home/pi", currentTask: "idle", lastSeen: "2026-06-06T00:00:00.000Z", sessionCount: 42 }],
	list_messages: [{ _id: "abc123def456abc123def456abc12345", from: "pi", content: "hello", channel: "broadcast" }],
	list_broadcast_status: [{ receiptId: "abc123def456abc123def456abc12345", recipient: "tau", isRead: true }],
	create_task: { taskId: "abc123def456abc123def456abc12345", title: "Test", assignedTo: "pi", priority: "medium", status: "todo" },
	list_tasks: [{ _id: "abc123def456abc123def456abc12345", title: "Test", status: "todo", priority: "medium" }],
	update_task: { taskId: "abc123def456abc123def456abc12345", updated: true },
	complete_task: { taskId: "abc123def456abc123def456abc12345", status: "done" },
	start_task: { taskId: "abc123def456abc123def456abc12345", status: "in_progress" },
	checkout_task: { claimed: true },
	delete_task: { deleted: true },
	block_task: { taskId: "abc123def456abc123def456abc12345", status: "blocked" },
	add_task_dependency: { taskId: "abc123def456abc123def456abc12345", dependsOn: ["dep123"], updated: true },
	list_tasks_by_mission: [{ _id: "abc123def456abc123def456abc12345", title: "Step 1", status: "todo" }],
	create_mission: { missionId: "abc123def456abc123def456abc12345", name: "C1 Mission", project: "vantage", pilot: "pi", status: "plan" },
	list_missions: [{ _id: "abc123def456abc123def456abc12345", name: "M1", project: "vantage", status: "plan" }],
	get_mission: { _id: "abc123def456abc123def456abc12345", name: "C1 Mission", project: "vantage", status: "plan" },
	update_mission: { missionId: "abc123def456abc123def456abc12345", updated: true },
	update_mission_status: { missionId: "abc123def456abc123def456abc12345", status: "execute" },
	write_diary: { diaryId: "abc123def456abc123def456abc12345", date: "2026-06-06", orchestrator: "pi" },
	get_diary: { _id: "abc123def456abc123def456abc12345", date: "2026-06-06", orchestrator: "pi", content: "Day notes" },
	list_diaries: [{ _id: "abc123def456abc123def456abc12345", date: "2026-06-06", orchestrator: "pi" }],
	create_briefing_note: { noteId: "abc123def456abc123def456abc12345", title: "C1 Brief", topic: "architecture", createdBy: "pi" },
	update_briefing_note: { noteId: "abc123def456abc123def456abc12345", updated: true },
	get_briefing_note: { _id: "abc123def456abc123def456abc12345", title: "C1 Brief", topic: "architecture", content: "Notes" },
	list_briefing_notes: [{ _id: "abc123def456abc123def456abc12345", title: "C1 Brief", topic: "architecture" }],
	register_component: { _id: "abc123def456abc123def456abc12345", name: "my-agent", type: "agent" },
	list_components: [{ _id: "abc123def456abc123def456abc12345", name: "my-agent", type: "agent" }],
	get_component: { _id: "abc123def456abc123def456abc12345", name: "my-agent", type: "agent", content: "..." },
	update_component: { componentId: "abc123def456abc123def456abc12345", updated: true },
	delete_component: { deleted: true },
	search_components: [{ _id: "abc123def456abc123def456abc12345", name: "my-agent", type: "agent" }],
	create_recurring_task: { taskId: "abc123def456abc123def456abc12345", cronExpression: "0 9 * * *" },
	list_recurring_tasks: [{ _id: "abc123def456abc123def456abc12345", title: "Daily standup", cronExpression: "0 9 * * *" }],
	pause_recurring_task: { paused: true },
	resume_recurring_task: { resumed: true },
	delete_recurring_task: { deleted: true },
	update_recurring_task: { recurringTaskId: "abc123def456abc123def456abc12345", updated: true },
	create_mandate: { mandateId: "abc123def456abc123def456abc12345", requestedBy: "pi", fulfilledBy: "sigma", service: "Dev work", budget: 10000 },
	accept_mandate: { mandateId: "abc123def456abc123def456abc12345", status: "accepted" },
	update_mandate: { mandateId: "abc123def456abc123def456abc12345", updated: true },
	settle_mandate: { mandateId: "abc123def456abc123def456abc12345", status: "settled", finalCost: 8500 },
	validate_mandate_spending: { within: true, remaining: 1500 },
	list_mandates: [{ _id: "abc123def456abc123def456abc12345", service: "Dev work", status: "accepted" }],
	create_bu: { buId: "abc123def456abc123def456abc12345", name: "VantagePeers", orchestratorId: "sigma", status: "building" },
	update_bu: { buId: "abc123def456abc123def456abc12345", updated: true },
	get_bu: { _id: "abc123def456abc123def456abc12345", name: "VantagePeers", status: "building" },
	list_bus: [{ _id: "abc123def456abc123def456abc12345", name: "VantagePeers", status: "building" }],
	delete_bu: { deleted: true },
	add_repo_mapping: { id: "abc123def456abc123def456abc12345", repo: "org/repo", orchestrator: "omega", project: "myproject", active: true },
	list_repo_mappings: [{ _id: "abc123def456abc123def456abc12345", repo: "org/repo", orchestrator: "omega" }],
	remove_repo_mapping: { repo: "org/repo", deleted: true },
	list_issues: { count: 1, issues: [{ _id: "abc123def456abc123def456abc12345", title: "Bug", status: "open" }] },
	get_issue: { _id: "abc123def456abc123def456abc12345", title: "Bug", status: "open", repo: "org/repo", issueNumber: 42 },
	update_issue_status: { repo: "org/repo", issueNumber: 42, status: "in_progress", updated: true },
	link_commit_to_issue: { repo: "org/repo", issueNumber: 42, commitSha: "abc1234", fixedBy: "omega", linked: true },
	verify_issue: { repo: "org/repo", issueNumber: 42, verifiedBy: "omega", verified: true },
	issue_stats: { open: 3, in_progress: 1, fixed: 2, verified: 1, closed: 5 },
	create_fix_pattern: { patternId: "abc123def456abc123def456abc12345", created: true },
	add_fix_attempt: { attemptId: "abc123def456abc123def456abc12345", patternId: "abc123def456abc123def456abc12345", worked: true },
	validate_fix: { patternId: "abc123def456abc123def456abc12345", validatedFix: "Use useCallback", validated: true },
	search_fix_patterns: [{ _id: "abc123def456abc123def456abc12345", symptom: "Hydration error", rootCause: "Missing key" }],
	list_fix_patterns: [{ _id: "abc123def456abc123def456abc12345", symptom: "Hydration error" }],
	link_issue_to_pattern: { patternId: "abc123def456abc123def456abc12345", issueId: "abc123def456abc123def456abc12346", linked: true },
	get_mission_template: { _id: "abc123def456abc123def456abc12345", name: "issue-resolution-v2", steps: [] },
	update_mission_template: { templateId: "abc123def456abc123def456abc12345", name: "issue-resolution-v2", stepCount: 5 },
	instantiate_template_into_mission: { taskIds: ["abc123def456abc123def456abc12345"], count: 5 },
	add_deployment: { id: "abc123def456abc123def456abc12345", name: "my-deployment", deploymentUrl: "https://my-deployment.convex.cloud", githubRepo: "org/repo", orchestrator: "sigma" },
	remove_deployment: { removed: "my-deployment" },
	list_errors: [{ _id: "abc123def456abc123def456abc12345", message: "TypeError", count: 3 }],
	get_error: { _id: "abc123def456abc123def456abc12345", message: "TypeError", stackTrace: "Error: ..." },
	whoami: { scope_profile_name: "alpha-test-trio", fromAllowList: ["Alpha", "alpha"], namespaceReadPrefixes: ["orchestrator/Alpha"], namespaceWritePrefixes: ["orchestrator/Alpha"], suggested_orchestrator_id: "Alpha" },
	validate_task_payload: { valid: true, errors: [], warnings: [] },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("C1 — outputSchema coverage (B2 §3)", () => {
	const toolNames = Object.keys(TOOL_SCHEMA_MAP);

	it(`covers all 87 tools (found ${toolNames.length})`, () => {
		expect(toolNames.length).toBe(87);
	});

	it.each(toolNames)("%s — outputSchema is exported", (toolName) => {
		const schemaKey = TOOL_SCHEMA_MAP[toolName];
		expect(schemaKey).toBeDefined();
		const schema = tools[schemaKey];
		expect(schema).toBeDefined();
		// Zod schemas always have a .parse method
		expect(typeof (schema as { parse?: unknown }).parse).toBe("function");
	});

	it.each(toolNames)("%s — schema validates representative response", (toolName) => {
		const schemaKey = TOOL_SCHEMA_MAP[toolName];
		const schema = tools[schemaKey] as { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
		const rep = REPRESENTATIVE_RESPONSES[toolName];

		expect(rep).toBeDefined();

		const result = schema.safeParse(rep);
		if (!result.success) {
			// Provide informative failure message
			throw new Error(
				`Schema validation failed for ${toolName} (schema: ${schemaKey}):\n` +
				`  Input: ${JSON.stringify(rep)}\n` +
				`  Error: ${JSON.stringify(result.error)}`,
			);
		}
		expect(result.success).toBe(true);
	});
});
