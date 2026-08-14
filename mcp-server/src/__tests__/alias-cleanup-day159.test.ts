// ─────────────────────────────────────────────────────────────────────────────
// alias-cleanup-day159.test.ts — mission vp-mcp-alias-cleanup-v1, task S2
// ─────────────────────────────────────────────────────────────────────────────
//
// Strict TDD RED→GREEN. For each of the 14 arbitrated pairs (S1), assert:
//   (a) the SURVIVOR name IS registered, and
//   (b) the CONDEMNED name is NOT registered.
//
// Authority is FLEET USAGE (S1 call-site counts), never the code's
// "DEPRECATED ALIAS" labels — those are inverted for the memory-search tools
// (the code labels the fleet-used survivors recall/text_search as aliases).
//
// Arbitration: /root/coding/elpi-corp/analysis/vantagepeers/vp-restructuring/
//   S1-arbitrated-pairs-day159.md
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import { registerTools } from "../tools.js";

// survivor (KEEP) ← condemned (DELETE)
const PAIRS: ReadonlyArray<readonly [survivor: string, condemned: string]> = [
	["write_diary", "create_diary"],
	["add_fix_attempt", "create_fix_attempt"],
	["validate_fix", "check_fix"],
	["validate_mandate_spending", "check_mandate_spending"],
	["remove_repo_mapping", "delete_repo_mapping"],
	["add_repo_mapping", "register_repo_mapping"],
	["remove_deployment", "delete_deployment"],
	["add_deployment", "register_deployment"],
	["set_summary", "update_summary"],
	["add_task_dependency", "create_task_dependency"],
	["search_components", "search_components_by_keyword"],
	["search_fix_patterns", "search_fix_patterns_by_semantic"],
	["recall", "search_memories_by_semantic"],
	["text_search", "search_memories_by_keyword"],
];

function registeredToolNames(): Set<string> {
	const names = new Set<string>();
	const server = {
		tool: (...call: unknown[]) => {
			if (typeof call[0] === "string") names.add(call[0]);
		},
		registerTool: (...call: unknown[]) => {
			if (typeof call[0] === "string") names.add(call[0]);
		},
	} as unknown as McpServer;
	const convex = {} as unknown as ConvexHttpClient;
	registerTools(server, convex);
	return names;
}

describe("alias cleanup day159 — 14 condemned tools removed, survivors kept", () => {
	const names = registeredToolNames();

	for (const [survivor, condemned] of PAIRS) {
		it(`keeps survivor '${survivor}'`, () => {
			expect(names.has(survivor), `survivor '${survivor}' must stay`).toBe(
				true,
			);
		});

		it(`removes condemned '${condemned}'`, () => {
			expect(
				names.has(condemned),
				`condemned '${condemned}' must be gone`,
			).toBe(false);
		});
	}
});
