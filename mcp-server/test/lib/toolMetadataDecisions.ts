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
	"create_task",
	"complete_task",
	"fail_task",
	"block_task",
	"add_task_dependency",
	"checkout_task",
	"delete_task",
	"correct_task_segment",
	"create_mission",
	"create_briefing_note",
	"store_episode",
	"update_profile",
	"set_summary",
	"send_message",
	"mark_as_read",
	"delete_message",
	"update_recurring_task",
	"pause_recurring_task",
	"resume_recurring_task",
	"delete_recurring_task",
	"add_repo_mapping",
	"remove_repo_mapping",
	"validate_fix",
	"link_issue_to_pattern",
] as const;

const ARRAY =
	"answers a bare JSON array; structuredContent must be an object, and wrapping the array would make it differ from the text";
const CAPPED =
	"answers an array OR { items, nextCursor } through capListResponseBytes, which rewrites the text under byte pressure: a structuredContent would bypass the cap or diverge from the text";
const NULLABLE =
	"a missing or unreadable row is a SUCCESS whose text is JSON null, which no object schema admits";
const MASTER_AGENT =
	"a fleet-master door that refuses a typed acting name without a per-agent credential (and a client org is refused outright); no /mcp harness here presents that credential, so no success could be validated";
const STORAGE =
	"Knowledge Base / OKF path through Convex actions and file storage (upload, chunk, bundle) that this convex-test harness does not run; unvalidated, so undeclared";

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
	debate_get_room:
		"fixed { room, turns } from debate:getRoom, but no debate room is opened through /mcp in this harness: unvalidated, so undeclared",
	debate_post_turn:
		"accepted turns are a fixed shape, but posting needs an open room and a turn owner, which this harness does not set up: unvalidated, so undeclared",
	erase_memory:
		"three success paths (person, seat, fleet master) over three Convex doors, each passing its result through; not all exercised here, so undeclared",
	erase_row:
		"passes erase:eraseRow's result through; the fleet-master erase path is not exercised through /mcp here: unvalidated, so undeclared",
	bulk_complete_tasks:
		"answers a dry-run preview or a live run from one Convex door, two different shapes; not exercised through /mcp here, so undeclared",
	create_fix_pattern: MASTER_AGENT,
	add_fix_attempt: MASTER_AGENT,
	update_mission_template: MASTER_AGENT,
	instantiate_template_into_mission:
		"passes missionTemplates instantiation through, and needs a stored template, which this harness cannot store (update_mission_template is MASTER_AGENT): unvalidated, so undeclared",
	export_okf_bundle: STORAGE,
	import_okf_bundle: STORAGE,
	store_document_chunked: STORAGE,
	soft_delete_document: STORAGE,
	generate_upload_url: STORAGE,
	claim_upload: STORAGE,
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
