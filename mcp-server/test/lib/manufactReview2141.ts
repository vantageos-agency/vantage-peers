/**
 * The actionable items of Manufact's re-review of live 406c3994
 * (2026-11-09T21:41, scratchpad manufact/review-2141/actionable-2141.json,
 * md5 7091b6a1a7c85d40f235a981d64126f6), task
 * k1708xy6dwrb8xx36ztkxfd9d58hwf0t. Generated from that file, never typed.
 */

/** [tool, JSON pointer into the inputSchema, the description the judge read]. */
export const FLAGGED_FIELDS: ReadonlyArray<readonly [string, string, string]> =
	[
		[
			"store_memory",
			"#/properties/type",
			"What kind of knowledge this is; recall and list_memories filter on it. This tool stores the text alone: store_episode records an episode with its context, goal, action, outcome and insight.",
		],
		[
			"recall",
			"#/properties/type",
			"Keep only memories of this kind, the kind store_memory or store_episode recorded them under. Omit to include every kind.",
		],
		[
			"recall",
			"#/properties/limit",
			"How many of the best matches to return; the weaker matches beyond them are not returned.",
		],
		[
			"hybrid_search",
			"#/properties/limit",
			"How many of the best matches to return; the weaker matches beyond them are not returned.",
		],
		[
			"list_episodes",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page. Left out on a call that passes cursor, that page holds 50 rows.",
		],
		[
			"search_episodes_by_keyword",
			"#/properties/limit",
			"How many of the best matches to return; the weaker matches beyond them are not returned.",
		],
		[
			"search_episodes_by_semantic",
			"#/properties/limit",
			"How many of the best matches to return; the weaker matches beyond them are not returned.",
		],
		[
			"list_memories",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page. Left out on a call that passes cursor, that page holds 50 rows.",
		],
		[
			"send_message",
			"#/properties/fromAgentId",
			"The agent this message is sent as, named by its agent ID: yours is whoami's agent_id, and list_peers shows each agent's agentId; the recipients see that agent as the sender. Given beside from, the ID alone decides; a verified agent may only name itself. Omit it to be identified by your credential or by from.",
		],
		[
			"list_blocked_on_me",
			"#/properties/limit",
			"The page size: how many waiters entries holds; total still counts every waiter found.",
		],
		[
			"list_peers",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
		],
		[
			"list_peers",
			"#/properties/fields",
			"Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out.",
		],
		[
			"list_messages",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
		],
		[
			"list_tasks",
			"#/properties/status",
			"Narrows the result to tasks in any of the given states. The three shorthands each stand alone in the list and stand for a set of states: open for every state not finished, active for work not started or under way, all for no filter. Omit for every status.",
		],
		[
			"list_tasks",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
		],
		[
			"bulk_complete_tasks",
			"#/properties/filter/properties/status",
			"Close only the open tasks currently in this state, for example the ones waiting on a reviewer. Omit to close open tasks whatever their state.",
		],
		[
			"search_tasks_by_keyword",
			"#/properties/missionId",
			"Keep only tasks of this mission: its missionId as returned by list_missions. Omit for every mission.",
		],
		[
			"search_tasks_by_keyword",
			"#/properties/limit",
			"How many of the best matches to return; the weaker matches beyond them are not returned.",
		],
		[
			"correct_task_segment",
			"#/properties/reason",
			"The explanation a reviewer reads later, e.g. 'unrecorded break, real work was 5 hours'; it is stored on the segment beside the recorded and the corrected times.",
		],
		[
			"list_tasks_by_mission",
			"#/properties/status",
			"Narrows the result to tasks in any of the given states. The three shorthands each stand alone in the list and stand for a set of states: open for every state not finished, active for work not started or under way, all for no filter. Omit for every status.",
		],
		[
			"create_mission",
			"#/properties/status",
			"The lifecycle stage the mission starts in.",
		],
		[
			"list_missions",
			"#/properties/status",
			"Which missions to keep, as a list of stages; an alias stands alone: 'open' keeps every mission not finished, 'active' only those being planned or executed, 'all' applies no filter. Omit for every stage.",
		],
		[
			"list_missions",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
		],
		[
			"list_missions",
			"#/properties/fields",
			"How much of each row comes back: lite is each mission's ID, creation time, name, status, pilot, priority and project; full is every stored field.",
		],
		[
			"list_diaries",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
		],
		[
			"list_briefing_notes",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
		],
		[
			"search_briefing_notes_by_keyword",
			"#/properties/limit",
			"How many of the best matches to return; the weaker matches beyond them are not returned.",
		],
		[
			"list_recurring_tasks",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
		],
		[
			"list_repo_mappings",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
		],
		[
			"list_repo_mappings",
			"#/properties/fields",
			"How much of each row comes back: full is every stored field; lite is just the mapping's ID, creation time, repo, orchestrator and project.",
		],
		[
			"get_github_owner_bindings",
			"#/properties/limit",
			"The page size of each of the two lists; when more exist, nextCursor (bindings) or unprovenNextCursor (unproven mappings) is the cursor for the next page.",
		],
		[
			"search_fix_patterns",
			"#/properties/limit",
			"How many of the best matches to return; the weaker matches beyond them are not returned.",
		],
		[
			"list_fix_patterns",
			"#/properties/limit",
			"The page size: how many rows this page holds; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
		],
		[
			"get_fix_pattern",
			"#/properties/patternId",
			"Which fix pattern: its patternId as create_fix_pattern, search_fix_patterns or list_fix_patterns returned it.",
		],
		[
			"export_okf_bundle",
			"#/properties/urlTtl",
			"How long the signed download URL stays valid, in seconds; the bundle is purged when it expires. Omit it and the URL stays valid for one hour.",
		],
	];

/** "Align the output schema with the tool's documented result." */
export const OUTPUTS_ALIGN = [
	"recall",
	"get_profile",
	"list_peers",
	"list_tasks",
	"list_tasks_by_mission",
	"list_missions",
	"get_mission",
	"get_diary",
	"list_diaries",
	"list_briefing_notes",
	"search_briefing_notes_by_keyword",
	"list_recurring_tasks",
	"list_fix_patterns",
	"get_mission_template",
	"get_owner_tool_usage",
	"get_fix_pattern",
] as const;

/** "Resolve contradictions between the description, input schema, and annotations." */
export const CONTRADICTIONS = ["list_tasks", "list_missions"] as const;
