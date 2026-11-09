/**
 * structuredContent for the lists and searches (task
 * k17592gg5t2tencwxks3kysghx8htqg8, outputs 1/3).
 *
 * Their TEXT is unchanged, byte for byte: a client that reads only the text sees
 * what it saw before. MCP requires structuredContent to be an object, so the
 * same answer is given its object form here, built from the very values the
 * text was written from (never re-parsed from the text, never re-queried):
 *
 *   - a bare-array answer (the searches, tool usage) -> { items };
 *   - a page written through capListResponseBytes -> { items, nextCursor,
 *     truncated }, plus scopeFiltered when the page carries it.
 *
 * `truncated` is true exactly when capListResponseBytes cut the page; the
 * items are then the rows the cut text shows and nextCursor is null, because
 * the cut text carries no continuation (the cursor of the full page would skip
 * the rows that were cut).
 */

/** What capListResponse made of a page: its text, the rows that text shows, and whether it cut. */
export type CappedList = {
	text: string;
	shown: unknown[];
	truncated: boolean;
};

/** The structured form of a bare-array answer. */
export function arrayStructured(rows: unknown): { items: unknown[] } {
	return { items: Array.isArray(rows) ? rows : [] };
}

/** The structured form of a page. */
export type PageStructured = {
	items: unknown[];
	nextCursor: string | null;
	truncated: boolean;
	scopeFiltered?: number;
};

/**
 * `payload` is the value the handler serialised into the text (a bare array or
 * a { items, nextCursor?, scopeFiltered? } page); `cap` is what
 * capListResponse made of it.
 */
export function pageStructured(
	payload: unknown,
	cap: CappedList,
): PageStructured {
	if (cap.truncated) {
		return { items: cap.shown, nextCursor: null, truncated: true };
	}
	if (Array.isArray(payload)) {
		return { items: payload, nextCursor: null, truncated: false };
	}
	const page =
		payload !== null && typeof payload === "object"
			? (payload as {
					items?: unknown;
					nextCursor?: unknown;
					scopeFiltered?: unknown;
				})
			: {};
	return {
		items: Array.isArray(page.items) ? page.items : [],
		nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
		truncated: false,
		...(typeof page.scopeFiltered === "number"
			? { scopeFiltered: page.scopeFiltered }
			: {}),
	};
}
