/**
 * Per-tool metadata decisions shared by test/tool-documentation-quality.test.ts
 * (what tools/list says) and test/output-schema-structured-content.test.ts (what
 * a real call through /mcp answers). Task k1793xkjhzh1xm23gmmwjgwfyx8htbv0, PR C.
 *
 * Finding 6 — outputSchema. Decided per tool from the handler and its Convex
 * door. A tool declares one ONLY when every success path returns
 * structuredContent equal to the JSON of its text.
 */

/**
 * The 23 lists and searches (task k17592gg5t2tencwxks3kysghx8htqg8). Their text
 * stays byte-identical; their structuredContent is:
 *   - "array": the text is a bare JSON array, structuredContent is { items }
 *     holding that same array (MCP requires an object);
 *   - "page": the text goes through capListResponseBytes (a bare array, a
 *     { items, nextCursor?, scopeFiltered? } page, or the { _meta, items }
 *     envelope written when the cap cut the page); structuredContent is
 *     { items, nextCursor, truncated } (plus scopeFiltered when the text has
 *     it), truncated true exactly when the cap cut.
 */
export const LIST_FORMS = {
	recall: "array",
	text_search: "array",
	hybrid_search: "array",
	search_episodes_by_keyword: "array",
	search_episodes_by_semantic: "array",
	search_messages_by_keyword: "array",
	search_tasks_by_keyword: "array",
	search_briefing_notes_by_keyword: "array",
	search_fix_patterns: "array",
	get_tool_usage: "array",
	get_owner_tool_usage: "array",
	list_episodes: "page",
	list_memories: "page",
	list_peers: "page",
	list_messages: "page",
	list_tasks: "page",
	list_tasks_by_mission: "page",
	list_missions: "page",
	list_diaries: "page",
	list_briefing_notes: "page",
	list_recurring_tasks: "page",
	list_repo_mappings: "page",
	list_fix_patterns: "page",
} as const satisfies Record<string, "array" | "page">;

/**
 * The other tools whose text is not the two-space JSON of their
 * structuredContent (task k170byeq1nzzv2q1z6qpag5fp18hvj8a, outputs 2/3). The
 * text is unchanged; structuredContent is:
 *   - "found": { found: true, item } for a row, { found: false, id } where the
 *     text is JSON null;
 *   - "inbox": { messages, truncated, nextSince, stuckInProgress,
 *     peersStuckOnYou }, the values check_messages writes its text from (a JSON
 *     array of messages with a resume note and stuck blocks, or free text);
 *   - "upload-url": { uploadUrl, ticket, expiresAt? , note? }, the two text
 *     items of generate_upload_url as one object;
 *   - "compact": the same object as the text, written without indentation.
 */
export const TEXT_FORMS = {
	get_profile: "found",
	get_mission: "found",
	get_mission_template: "found",
	get_diary: "found",
	check_messages: "inbox",
	generate_upload_url: "upload-url",
	claim_upload: "compact",
} as const satisfies Record<
	string,
	"found" | "inbox" | "upload-url" | "compact"
>;

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
	// lists and searches (task k17592gg5t2tencwxks3kysghx8htqg8, outputs 1/3):
	// the text is unchanged; structuredContent is the object form of the same
	// answer, as LIST_FORMS says.
	"recall",
	"text_search",
	"hybrid_search",
	"search_episodes_by_keyword",
	"search_episodes_by_semantic",
	"search_messages_by_keyword",
	"search_tasks_by_keyword",
	"search_briefing_notes_by_keyword",
	"search_fix_patterns",
	"get_tool_usage",
	"get_owner_tool_usage",
	"list_episodes",
	"list_memories",
	"list_peers",
	"list_messages",
	"list_tasks",
	"list_tasks_by_mission",
	"list_missions",
	"list_diaries",
	"list_briefing_notes",
	"list_recurring_tasks",
	"list_repo_mappings",
	"list_fix_patterns",
	// null-able reads, the inbox, and the Knowledge Base / OKF tools (task
	// k170byeq1nzzv2q1z6qpag5fp18hvj8a, outputs 2/3), as TEXT_FORMS says.
	"get_profile",
	"get_mission",
	"get_mission_template",
	"get_diary",
	"check_messages",
	"export_okf_bundle",
	"import_okf_bundle",
	"store_document_chunked",
	"soft_delete_document",
	"generate_upload_url",
	"claim_upload",
] as const;

const MASTER_AGENT =
	"a fleet-master door that refuses a typed acting name without a per-agent credential (and a client org is refused outright); no /mcp harness here presents that credential, so no success could be validated";

export const UNSTRUCTURED_TOOLS: Record<string, string> = {
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
