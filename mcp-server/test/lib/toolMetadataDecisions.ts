/**
 * Per-tool metadata decisions shared by test/tool-documentation-quality.test.ts
 * (what tools/list says) and test/output-schema-structured-content.test.ts (what
 * a real call through /mcp answers). Task k1793xkjhzh1xm23gmmwjgwfyx8htbv0, PR C.
 *
 * Finding 6 — outputSchema. Decided per tool from the handler and its Convex
 * door. A tool declares one ONLY when every success path returns
 * structuredContent equal to the JSON of its text.
 */

export const STRUCTURED_TOOLS = [
	// reads: one row or one fixed envelope, shape fixed by the Convex `returns:`
	"whoami",
	"get_memory",
	"get_episode",
	"get_task",
	"get_fix_pattern",
	"get_message",
	"get_recurring_task",
	"get_briefing_note",
	"get_bulk_complete_run",
	"list_blocked_on_me",
	"list_broadcast_status",
	"get_github_owner_bindings",
	"billing_summary_by_project",
	// writes: the handler builds the answer itself from a fixed set of keys
	"store_memory",
	"soft_delete_memory",
	"update_task",
	"start_task",
	"pause_task",
	"resume_task",
	"update_mission",
	"update_mission_status",
	"write_diary",
	"update_briefing_note",
	"create_recurring_task",
] as const;

const ARRAY =
	"answers a bare JSON array; structuredContent must be an object, and wrapping the array would make it differ from the text";
const CAPPED =
	"answers an array OR { items, nextCursor } through capListResponseBytes, which rewrites the text under byte pressure: a structuredContent would bypass the cap or diverge from the text";
const NULLABLE =
	"a missing or unreadable row is a SUCCESS whose text is JSON null, which no object schema admits";
const UNMEASURED =
	"result shape is fixed, but no success through /mcp was exercised in this delivery, so no schema is declared on an unvalidated shape";

export const UNSTRUCTURED_TOOLS: Record<string, string> = {
	recall: ARRAY,
	text_search: ARRAY,
	hybrid_search: ARRAY,
	search_episodes_by_keyword: ARRAY,
	search_episodes_by_semantic: ARRAY,
	search_messages_by_keyword: ARRAY,
	search_tasks_by_keyword: ARRAY,
	search_briefing_notes_by_keyword: ARRAY,
	search_fix_patterns: ARRAY,
	get_tool_usage: ARRAY,
	get_owner_tool_usage: ARRAY,
	list_episodes: CAPPED,
	list_memories: CAPPED,
	list_peers: CAPPED,
	list_messages: CAPPED,
	list_tasks: CAPPED,
	list_tasks_by_mission: CAPPED,
	list_missions: CAPPED,
	list_diaries: CAPPED,
	list_briefing_notes: CAPPED,
	list_recurring_tasks: CAPPED,
	list_repo_mappings: CAPPED,
	list_fix_patterns: CAPPED,
	get_profile: NULLABLE,
	get_mission: NULLABLE,
	get_mission_template: NULLABLE,
	get_diary: `${NULLABLE}; a stream marker may also follow the JSON`,
	check_messages:
		"answers free text ('No new messages.', stuck blocks) or a JSON array followed by prose; no single object shape",
	improvisation_digest:
		"fixed shape (countsByOrch, countsByCategory, samples), but its door serves the fleet master only with a fleet agent's verified credential, which no /mcp harness here presents: unvalidated, so undeclared",
	debate_get_room: UNMEASURED,
	debate_post_turn: UNMEASURED,
	erase_memory: UNMEASURED,
	erase_row: UNMEASURED,
	store_episode: UNMEASURED,
	update_profile: UNMEASURED,
	send_message: UNMEASURED,
	mark_as_read: UNMEASURED,
	delete_message: UNMEASURED,
	set_summary: UNMEASURED,
	create_task: UNMEASURED,
	bulk_complete_tasks: UNMEASURED,
	complete_task: UNMEASURED,
	fail_task: UNMEASURED,
	correct_task_segment: UNMEASURED,
	checkout_task: UNMEASURED,
	delete_task: UNMEASURED,
	block_task: UNMEASURED,
	add_task_dependency: UNMEASURED,
	create_mission: UNMEASURED,
	create_briefing_note: UNMEASURED,
	pause_recurring_task: UNMEASURED,
	resume_recurring_task: UNMEASURED,
	delete_recurring_task: UNMEASURED,
	update_recurring_task: UNMEASURED,
	add_repo_mapping: UNMEASURED,
	remove_repo_mapping: UNMEASURED,
	create_fix_pattern: UNMEASURED,
	add_fix_attempt: UNMEASURED,
	validate_fix: UNMEASURED,
	link_issue_to_pattern: UNMEASURED,
	update_mission_template: UNMEASURED,
	instantiate_template_into_mission: UNMEASURED,
	export_okf_bundle: UNMEASURED,
	import_okf_bundle: UNMEASURED,
	store_document_chunked: UNMEASURED,
	soft_delete_document: UNMEASURED,
	generate_upload_url: UNMEASURED,
	claim_upload: UNMEASURED,
};

/**
 * Policy finding (Manufact policy-review-d26bfdfb4c66): wording that tells the
 * model to call another tool, or prescribes how it words its answer.
 */
export const COERCIVE_PATTERNS: RegExp[] = [
	/VP-Sources/,
	/Sources:/,
	/\bMUST (call|be called)\b/i,
	/\bbefore (any|answering)\b/i,
	/\bfooter\b/i,
	/\b(always|must|should) (call|run|use) [a-z]+_[a-z_]+/i,
	/\bcall [a-z]+_[a-z_]+ (first|before|at session start)\b/i,
	/\bthen call\b/i,
	/\bsearch before storing\b/i,
	/(^|\n)\s*\d+\.\s*Call\b/,
];
