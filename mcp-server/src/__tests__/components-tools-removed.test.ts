// ─────────────────────────────────────────────────────────────────────────────
// components-tools-removed.test.ts — task k173r2p1yh94m5f7yvgr1b30gx8dn3ez
// ─────────────────────────────────────────────────────────────────────────────
//
// The components table + module were removed entirely (operator ruling: a
// tool serving nothing is removed, not left registered). This asserts BOTH
// poles against the real registerTools() harness, not against a hand-copied
// list of names:
//   (a) NEGATIVE — none of the six removed tools are in the served list.
//   (b) POSITIVE CONTROL — a surviving, unrelated tool (list_memories) IS
//       still in the served list, so a broken/emptied harness (one that
//       registers nothing) cannot pass (a) by accident.
//
// RED before the removal commit: all six names in REMOVED_TOOLS were
// present in registerToolNames(), so every "not.toContain" assertion below
// failed. GREEN after: none are present, and the positive control still is.
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import { registerTools } from "../tools.js";

const REMOVED_TOOLS = [
	"list_components",
	"register_component",
	"get_component",
	"update_component",
	"delete_component",
	"search_components",
] as const;

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

describe("components table removal — served tool list", () => {
	const names = registeredToolNames();

	for (const removed of REMOVED_TOOLS) {
		it(`'${removed}' is NOT in the served tool list`, () => {
			expect(names.has(removed)).toBe(false);
		});
	}

	it("positive control: 'list_memories' IS still in the served tool list", () => {
		expect(names.has("list_memories")).toBe(true);
	});

	it("positive control: the served list is non-trivially large (harness is not empty)", () => {
		expect(names.size).toBeGreaterThan(50);
	});
});
