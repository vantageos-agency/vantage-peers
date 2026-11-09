/**
 * erase_fix_pattern -- the MCP face of the Convex door fixPatterns:erase (task
 * k176x68sj2jkwx46nshvtt40e18ht1xh). The decision is the door's (author agent of the
 * operator organisation or an operator admin; RBAC_DENIED otherwise, pinned by
 * convex/__tests__/fixPatternErase.test.ts); this file pins what the MCP side owes:
 *
 *   - the tool is registered, destructive, and says what it returns;
 *   - it forwards the pattern ID to fixPatterns:erase and relays the door's answer;
 *   - the door is declared everywhere the MCP declares the doors it calls
 *     (MCP_CALLED_FUNCTIONS, VERIFIED_ACTOR_DOORS), so the boot check and the
 *     seat's proof both reach it;
 *   - its result schema is exported and describes every field.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import { MCP_CALLED_FUNCTIONS } from "../src/backendContract.js";
import { eraseFixPatternOutputSchema, registerTools } from "../src/tools.js";
import { VERIFIED_ACTOR_DOORS } from "../src/verifiedActor.js";

type Registered = {
	config: { description?: string; annotations?: Record<string, unknown> };
	handler: (args: unknown, extra?: unknown) => Promise<{
		isError?: boolean;
		content: { text: string }[];
	}>;
};

function register(calls: { name: string; args: unknown }[]): Registered | undefined {
	let found: Registered | undefined;
	const reg = (...a: unknown[]) => {
		if (a[0] === "erase_fix_pattern") {
			const config = (a.length > 2 ? a[a.length - 2] : {}) as Registered["config"];
			found = {
				config: {
					...config,
					description:
						typeof a[1] === "string" ? a[1] : (config as { description?: string }).description,
				},
				handler: a[a.length - 1] as Registered["handler"],
			};
		}
		return {};
	};
	const convex = {
		mutation: async (name: string, args: unknown) => {
			calls.push({ name, args });
			return { patternId: "p1", erased: true, cascaded: { fixAttempts: 2, searchEntry: 1 } };
		},
		query: async () => null,
		action: async () => null,
	} as unknown as ConvexHttpClient;
	registerTools({ tool: reg, registerTool: reg } as unknown as McpServer, convex);
	return found;
}

describe("erase_fix_pattern", () => {
	it("is registered as a destructive write and says what it returns", () => {
		const tool = register([]);
		expect(tool, "erase_fix_pattern is not registered").toBeDefined();
		const text = JSON.stringify(tool?.config);
		expect(text).toContain("destructiveHint");
		expect(text).toContain("RBAC_DENIED");
		expect(text).toContain("cascaded");
	});

	it("forwards the pattern ID to fixPatterns:erase and relays the answer", async () => {
		const calls: { name: string; args: unknown }[] = [];
		const tool = register(calls);
		const r = await tool?.handler({ patternId: "m9748paffd0emrbwyskj868e1x88kvhj" });
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("fixPatterns:erase");
		expect(calls[0].args).toMatchObject({ patternId: "m9748paffd0emrbwyskj868e1x88kvhj" });
		expect(JSON.parse(r?.content[0].text ?? "{}")).toMatchObject({ erased: true });
	});

	it("is declared as a called function and as a door that takes the seat's verified agent", () => {
		expect(MCP_CALLED_FUNCTIONS).toContain("fixPatterns:erase");
		expect(VERIFIED_ACTOR_DOORS.has("fixPatterns:erase")).toBe(true);
	});

	it("exports a result schema whose every field is described", () => {
		const shape = eraseFixPatternOutputSchema.shape as Record<string, { description?: string }>;
		for (const key of ["patternId", "erased", "cascaded"]) {
			expect(shape[key]?.description, `${key} has no description`).toBeTruthy();
		}
	});
});
