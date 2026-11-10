/**
 * One list contract for the paged list tools (VantagePeers Cloud, task
 * k17e90s1n85hjappy26vs2kww18hxjp1).
 *
 * Each paged list tool's description states its result through this one
 * generator, so two tools cannot describe the same envelope two ways:
 *
 *   - the Returns { ... } clause names exactly the outputSchema's top-level
 *     properties ({ items, nextCursor, truncated }, plus scopeFiltered? where
 *     the handler reports withheld rows). The row fields are stated once, by
 *     the outputSchema's `items`, never by a second, partial list here;
 *   - one sentence says what the TEXT block is, as the handler serialises it
 *     (capPage / capPageMirrored in src/tools.ts):
 *       "array-on-last-page"     a bare array when no page follows, else
 *                                { items, nextCursor };
 *       "array-unless-continued" a bare array unless a page follows or rows
 *                                were withheld, then { items, nextCursor?,
 *                                scopeFiltered? };
 *       "page-cursor-omitted"    { items, nextCursor }, nextCursor absent on
 *                                the last page;
 *       "page-cursor-always"     { items, nextCursor }, nextCursor null on the
 *                                last page;
 *       "mirrored"               JSON.stringify(structuredContent);
 *     a page the 60 KB cap cut is { _meta, items } in every non-mirrored form
 *     (plus nextCursor where the cut resumes, `cutResumes`).
 *
 * test/output-schema-structured-content.test.ts drives every tool's handler on
 * each code path (last page, a page with more behind it, a cut page, rows
 * withheld by scope) and fails when the real answer is not what this says.
 */

export type ListTextForm =
	| "array-on-last-page"
	| "array-unless-continued"
	| "page-cursor-omitted"
	| "page-cursor-always"
	| "mirrored";

export type ListContract = {
	/** What a row is, plural, e.g. "tasks". */
	rows: string;
	form: ListTextForm;
	/** The handler reports rows withheld by scope (scopedPageContinuation). */
	scopeFiltered?: true;
	/** A cut page carries the cursor after its last row shown (capPage continueFrom). */
	cutResumes?: true;
};

export const LIST_CONTRACTS = {
	list_tasks: { rows: "tasks", form: "array-on-last-page" },
	list_tasks_by_mission: {
		rows: "tasks",
		form: "array-unless-continued",
		scopeFiltered: true,
	},
	list_memories: {
		rows: "memories (latest versions only)",
		form: "page-cursor-omitted",
	},
	list_episodes: { rows: "episodes", form: "page-cursor-omitted" },
	list_peers: {
		rows: "profiles",
		form: "array-unless-continued",
		scopeFiltered: true,
	},
	list_messages: {
		rows: "messages",
		form: "array-on-last-page",
		cutResumes: true,
	},
	list_missions: { rows: "missions", form: "array-on-last-page" },
	list_diaries: { rows: "diary entries", form: "mirrored" },
	list_briefing_notes: { rows: "notes", form: "array-on-last-page" },
	list_recurring_tasks: {
		rows: "recurring templates",
		form: "array-unless-continued",
		scopeFiltered: true,
	},
	list_repo_mappings: { rows: "mappings", form: "page-cursor-always" },
	list_fix_patterns: { rows: "fix patterns", form: "array-on-last-page" },
} as const satisfies Record<string, ListContract>;

export type PagedListTool = keyof typeof LIST_CONTRACTS;

/** The structured result's top-level properties: what Returns { ... } names. */
export function listReturnsKeys(c: ListContract): string[] {
	return [
		"items",
		"nextCursor",
		"truncated",
		...(c.scopeFiltered ? ["scopeFiltered"] : []),
	];
}

const CUT_TEXT = (c: ListContract) =>
	`cut, it is { _meta, items${c.cutResumes ? ", nextCursor" : ""} }`;

function textSentence(c: ListContract): string {
	switch (c.form) {
		case "array-on-last-page":
			return `The text is the bare JSON array of the ${c.rows} on the last page, else { items, nextCursor }; ${CUT_TEXT(c)}.`;
		case "array-unless-continued":
			return `The text is the bare JSON array of the ${c.rows}, or { items, nextCursor?, scopeFiltered? } when another page exists or rows were withheld; ${CUT_TEXT(c)}.`;
		case "page-cursor-omitted":
			return `The text is { items, nextCursor }, without nextCursor on the last page; ${CUT_TEXT(c)}.`;
		case "page-cursor-always":
			return `The text is { items, nextCursor }; ${CUT_TEXT(c)}.`;
		case "mirrored":
			return "The text is the same object as JSON.";
	}
}

/** The Returns clause and the text sentence, as every paged list tool states them. */
export function listContractText(c: ListContract): string {
	const keys = listReturnsKeys(c)
		.map((k) => (k === "scopeFiltered" ? "scopeFiltered?" : k))
		.join(", ");
	const cutCursor = c.cutResumes
		? "the cursor that continues after the last row shown"
		: "null";
	const scope = c.scopeFiltered
		? "; scopeFiltered counts rows withheld by scope"
		: "";
	return (
		`Returns { ${keys} }: items are ${c.rows}, newest first; nextCursor is the next page's cursor, null on the last page; ` +
		`truncated is true when the 60 KB response cap cut the page (nextCursor is then ${cutCursor})${scope}. ` +
		textSentence(c)
	);
}

/** listContractText of a paged list tool, by name. */
export function listContract(tool: PagedListTool): string {
	return listContractText(LIST_CONTRACTS[tool]);
}
