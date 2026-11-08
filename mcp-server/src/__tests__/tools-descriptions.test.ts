// ─────────────────────────────────────────────────────────────────────────────
// tools-descriptions.test.ts — the 5 search/recall descriptions describe only
// their own tool.
// ─────────────────────────────────────────────────────────────────────────────
//
// These descriptions once embedded the "VP-Sources" doctrine (the model MUST
// call recall before any factual claim, and cite ids in an answer footer).
// Anthropic Software Directory Policy D (Manufact policy-review-d26bfdfb4c66)
// forbids tool metadata that coerces the model into calling other tools or
// prescribes its answer; the citation workflow is now user documentation
// (mcp-server/README.md, "Citing what an answer rests on").
// Task k1793xkjhzh1xm23gmmwjgwfyx8htbv0 (PR C). The fleet-wide guard over
// every served tool is in test/tool-documentation-quality.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import {
	HYBRID_SEARCH_TOOL_DESCRIPTION,
	LIST_BRIEFING_NOTES_TOOL_DESCRIPTION,
	RECALL_TOOL_DESCRIPTION,
	SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION,
	TEXT_SEARCH_TOOL_DESCRIPTION,
} from "../tools.js";

const DESCRIPTIONS: Array<[string, string]> = [
	["recall", RECALL_TOOL_DESCRIPTION],
	["hybrid_search", HYBRID_SEARCH_TOOL_DESCRIPTION],
	["text_search", TEXT_SEARCH_TOOL_DESCRIPTION],
	["list_briefing_notes", LIST_BRIEFING_NOTES_TOOL_DESCRIPTION],
	[
		"search_briefing_notes_by_keyword",
		SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION,
	],
];

describe("search/recall descriptions carry no citation doctrine", () => {
	for (const [tool, desc] of DESCRIPTIONS) {
		it(`${tool}: no doctrine, still says what it returns`, () => {
			expect(desc).not.toMatch(/VP-Sources/);
			expect(desc).not.toMatch(/MUST be called/);
			expect(desc).not.toMatch(/footer/i);
			expect(desc).toMatch(/Returns /);
		});
	}
});
