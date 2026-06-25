// ─────────────────────────────────────────────────────────────────────────────
// tools-descriptions.test.ts — PR-H TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the VP-Sources doctrine verbatim requirement inside the descriptions of
// the 5 search/recall MCP tools. Each description MUST contain two mandatory
// substrings so that client LLMs read the doctrine inline.
//
// Mandatory substrings (verbatim, asserted as contains):
//   A) "MUST be called before any factual claim about fleet state, audits,
//      dette tooling, mission/task/client status, incident history, doctrine
//      references"
//   B) "Cite returned ids in the answer footer as
//      'VP-Sources: recall(\"<q>\")→[ids] | none-needed:<reason>'"
//
// Mission: k571gcctka8mq5jbkgpj0a0b2n892ctg (VP-MCP top level Bloc A)
// Task ref: k17cwt4j91rh5my7hewd2zpqxs892jyw
// Doctrine source: Eta Q1 message k977bvf03qzas7v7g0zqca9c7n8937zh
// Audit sections: 27 + 28.4
//
// T-GREEN must export from mcp-server/src/tools.ts:
//   - RECALL_TOOL_DESCRIPTION: string
//   - HYBRID_SEARCH_TOOL_DESCRIPTION: string
//   - TEXT_SEARCH_TOOL_DESCRIPTION: string
//   - LIST_BRIEFING_NOTES_TOOL_DESCRIPTION: string
//   - SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION: string
//
// All 5 imports will throw "does not provide an export named …" until T-GREEN
// ships them — that is the RED contract. Tests will also fail when the exports
// exist but the description strings do not yet contain the doctrine substrings.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";

// Expected exports from T-GREEN — these do NOT exist in tools.ts yet → RED
// @ts-expect-error — RED: exports do not exist yet, will exist post-T-GREEN
import {
	HYBRID_SEARCH_TOOL_DESCRIPTION,
	LIST_BRIEFING_NOTES_TOOL_DESCRIPTION,
	RECALL_TOOL_DESCRIPTION,
	SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION,
	TEXT_SEARCH_TOOL_DESCRIPTION,
} from "../tools.js";

// ─── VP-Sources doctrine verbatim substrings ────────────────────────────────

const SUBSTR_MUST_BE_CALLED =
	"MUST be called before any factual claim about fleet state, audits, dette tooling, mission/task/client status, incident history, doctrine references";

const SUBSTR_CITE_FOOTER =
	"Cite returned ids in the answer footer as 'VP-Sources: recall(\"<q>\")→[ids] | none-needed:<reason>'";

// ─── helper ─────────────────────────────────────────────────────────────────

function assertVpSourcesDoctrinePresent(desc: string, toolName: string): void {
	expect(
		desc,
		`${toolName}: missing MUST-BE-CALLED substring`,
	).toContain(SUBSTR_MUST_BE_CALLED);

	expect(
		desc,
		`${toolName}: missing CITE-FOOTER substring`,
	).toContain(SUBSTR_CITE_FOOTER);
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("VP-Sources doctrine embedded in tool descriptions (PR-H RED)", () => {
	it("recall description contains both VP-Sources doctrine substrings", () => {
		// Will fail until RECALL_TOOL_DESCRIPTION is exported AND updated
		expect(typeof RECALL_TOOL_DESCRIPTION).toBe("string");
		assertVpSourcesDoctrinePresent(RECALL_TOOL_DESCRIPTION, "recall");
	});

	it("hybrid_search description contains both VP-Sources doctrine substrings", () => {
		// Will fail until HYBRID_SEARCH_TOOL_DESCRIPTION is exported AND updated
		expect(typeof HYBRID_SEARCH_TOOL_DESCRIPTION).toBe("string");
		assertVpSourcesDoctrinePresent(
			HYBRID_SEARCH_TOOL_DESCRIPTION,
			"hybrid_search",
		);
	});

	it("text_search description contains both VP-Sources doctrine substrings", () => {
		// Will fail until TEXT_SEARCH_TOOL_DESCRIPTION is exported AND updated
		expect(typeof TEXT_SEARCH_TOOL_DESCRIPTION).toBe("string");
		assertVpSourcesDoctrinePresent(TEXT_SEARCH_TOOL_DESCRIPTION, "text_search");
	});

	it("list_briefing_notes description contains both VP-Sources doctrine substrings", () => {
		// Will fail until LIST_BRIEFING_NOTES_TOOL_DESCRIPTION is exported AND updated
		expect(typeof LIST_BRIEFING_NOTES_TOOL_DESCRIPTION).toBe("string");
		assertVpSourcesDoctrinePresent(
			LIST_BRIEFING_NOTES_TOOL_DESCRIPTION,
			"list_briefing_notes",
		);
	});

	it("search_briefing_notes_by_keyword description contains both VP-Sources doctrine substrings", () => {
		// Will fail until SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION is exported AND updated
		expect(typeof SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION).toBe(
			"string",
		);
		assertVpSourcesDoctrinePresent(
			SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION,
			"search_briefing_notes_by_keyword",
		);
	});
});
