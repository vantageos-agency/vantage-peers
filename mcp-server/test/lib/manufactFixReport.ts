/**
 * The field-level items of Manufact's documentation fix report (read by the
 * operator on 2026-11-09, scratchpad manufact/fix-report.json, md5
 * bd894de9fd43d0078a52febb04fbf264), each with the description it was
 * flagged on, as served at 7c49e7fd (task k177d10zrqvw6gj9jef5hypayd8hxe34).
 *
 * [tool, JSON pointer into the inputSchema ("#" = the tool description),
 * what was flagged ("restates": a validation rule its schema already
 * expresses; "source": where the value comes from is not said), the flagged
 * description]. Generated from tools/list, never typed by hand.
 */
export const REPORTED: ReadonlyArray<
	readonly [string, string, "restates" | "source", string]
> = [
	[
		"store_memory",
		"#/properties/type",
		"restates",
		"What kind of knowledge this is; recall and list_memories filter on it. episode is accepted but stores the text alone; store_episode records an episode with its context, goal, action, outcome and insight.",
	],
	[
		"recall",
		"#/properties/type",
		"restates",
		"Keep only memories of this kind: user (about a person), feedback (a rule or correction), project (a fact about work), reference (a pointer to an external source), episode (a structured past event). Omit to include every kind.",
	],
	[
		"recall",
		"#/properties/limit",
		"restates",
		"At most this many of the best matches come back; weaker matches beyond it are not returned.",
	],
	[
		"text_search",
		"#/properties/limit",
		"restates",
		"At most this many of the best matches come back; weaker matches beyond it are not returned.",
	],
	[
		"hybrid_search",
		"#/properties/limit",
		"restates",
		"At most this many of the best matches come back; weaker matches beyond it are not returned.",
	],
	[
		"list_episodes",
		"#/properties/limit",
		"restates",
		"At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page. Left out on a call that passes cursor, that page holds 50 rows.",
	],
	[
		"search_episodes_by_keyword",
		"#/properties/limit",
		"restates",
		"At most this many of the best matches come back; weaker matches beyond it are not returned.",
	],
	[
		"search_episodes_by_semantic",
		"#/properties/limit",
		"restates",
		"At most this many of the best matches come back; weaker matches beyond it are not returned.",
	],
	[
		"list_blocked_on_me",
		"#/properties/limit",
		"restates",
		"How many waiters to list; total still counts every waiter found.",
	],
	[
		"list_peers",
		"#/properties/limit",
		"restates",
		"At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
	],
	[
		"list_tasks",
		"#/properties/status",
		"restates",
		"Narrows the result to tasks in any of the given states. A shorthand stands alone in the list: open keeps everything not finished, active only work not started or under way, all applies no filter. Omit for every status.",
	],
	[
		"bulk_complete_tasks",
		"#/properties/filter/properties/status",
		"restates",
		"Close only open tasks currently in this state, e.g. review for the ones waiting on a reviewer. Omit to close open tasks whatever their state.",
	],
	[
		"billing_summary_by_project",
		"#/properties/from",
		"restates",
		"The moment the billed period starts: tasks completed at or after it count (a millisecond timestamp, as Date.now() gives). Omit to count from the first completed task.",
	],
	[
		"billing_summary_by_project",
		"#/properties/to",
		"restates",
		"The moment the billed period ends: tasks completed at or before it count (a millisecond timestamp, as Date.now() gives). Omit to count up to now.",
	],
	[
		"list_tasks_by_mission",
		"#/properties/status",
		"restates",
		"Narrows the result to tasks in any of the given states. A shorthand stands alone in the list: open keeps everything not finished, active only work not started or under way, all applies no filter. Omit for every status.",
	],
	[
		"list_missions",
		"#/properties/limit",
		"restates",
		"At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
	],
	[
		"list_diaries",
		"#/properties/limit",
		"restates",
		"At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
	],
	[
		"list_briefing_notes",
		"#/properties/limit",
		"restates",
		"At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
	],
	[
		"list_briefing_notes",
		"#/properties/fields",
		"restates",
		"How much of each row comes back: lite is each note's ID, creation time, topic, title, participants and author, without its content; full is every stored field.",
	],
	[
		"search_briefing_notes_by_keyword",
		"#/properties/limit",
		"restates",
		"At most this many of the best matches come back; weaker matches beyond it are not returned.",
	],
	[
		"list_recurring_tasks",
		"#/properties/limit",
		"restates",
		"At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
	],
	[
		"update_recurring_task",
		"#/properties/priority",
		"restates",
		"A new priority for future tasks. Omit to keep it.",
	],
	[
		"list_repo_mappings",
		"#/properties/limit",
		"restates",
		"At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
	],
	[
		"get_github_owner_bindings",
		"#/properties/limit",
		"restates",
		"At most this many rows come back in each of the two lists; when more exist, nextCursor (bindings) or unprovenNextCursor (unproven mappings) is the cursor for the next page.",
	],
	[
		"get_github_owner_bindings",
		"#/properties/unprovenCursor",
		"restates",
		"The unprovenNextCursor a previous get_github_owner_bindings call returned (fleet master only). Omit for the first page of unproven mappings.",
	],
	[
		"search_fix_patterns",
		"#/properties/limit",
		"restates",
		"At most this many of the best matches come back; weaker matches beyond it are not returned.",
	],
	[
		"list_fix_patterns",
		"#/properties/limit",
		"restates",
		"At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page.",
	],
	[
		"search_briefing_notes_by_keyword",
		"#/properties/createdBy",
		"source",
		"Keep only notes written by this agent. Omit for every author.",
	],
	[
		"get_message",
		"#",
		"restates",
		"Fetch a single peer message by its messageId: its full body, sender, channel, session day and organisation. Returns the message row as JSON (content, from, fromInstanceId, channel, sessionDay, tenantId, createdAt): from is the sender, tenantId the organisation it was sent in; an ID you may not read returns 'Message not found'. WHEN: use when you have a messageId from list_messages/check_messages and need the raw row (e.g. for read-receipt audit, delete confirmation, or referencing in a fix pattern). EXAMPLE: get_message messageId='jn7eg21wdaxzdcpdxwkvhaxqnh88jqg2'.",
	],
];
