/**
 * TDD for mission k17at41v7e6re4ht9wbf3cvdah8cepjc — unknown-param /
 * dropped-param silent-success defect.
 *
 * MEASURED THIS MORNING (Eta): the MCP tool list is frozen at connection
 * open; a station saw 3 properties on `set_summary` where the server
 * publishes 4 (the 4th being `endOfDayIndex`). Three states — "written",
 * "could not write", "unknown field" — collapsed to an identical success
 * (200) at the caller.
 *
 * ROOT CAUSE (measured, file:line evidence):
 *   - mcp-server/src/tools.ts:3176-3235 (`set_summary` registration) builds
 *     its zod shape with `defineTool` (mcp-server/src/registerTool.ts).
 *   - Before this fix, `defineTool` forwarded the RAW zod shape to
 *     `server.tool(...)`. The MCP SDK
 *     (@modelcontextprotocol/sdk/dist/esm/server/mcp.js:166-181,
 *     `validateToolInput` -> `safeParseAsync(z.object(shape), args)`) parses
 *     incoming args in zod's DEFAULT (non-strict) object mode, which
 *     SILENTLY STRIPS any key not declared in the shape — confirmed by a
 *     scratch probe against `profiles:updateDynamic` directly (Convex's own
 *     arg validator DOES throw loud — "Validator error: Unexpected field
 *     `bogusParam` in object" — proving Convex was never the leak; the leak
 *     is upstream, at the MCP transport boundary, before Convex ever sees
 *     the call).
 *   - GREEN fix: mcp-server/src/registerTool.ts `buildStrictInputSchema`
 *     wraps every tool's shape in `z.object(shape).strict()` before handing
 *     it to `server.tool`. Zod's strict mode rejects (does not silently
 *     drop) any key absent from the shape and names it in a
 *     `unrecognized_keys` issue — the SDK then throws a loud
 *     `McpError(InvalidParams, ...)` before the handler (and therefore
 *     before Convex) ever runs.
 *
 * This test whitebox-checks the schema `defineTool` actually produces for
 * `set_summary`'s exact shape (mirrored here from tools.ts:3184-3199) rather
 * than standing up a full MCP transport — the stub in
 * `registerTool-scope-enforcement.test.ts` deliberately bypasses SDK-level
 * zod parsing (it only captures the guarded handler), so it cannot prove
 * this defect either way; this file closes that gap by parsing through the
 * schema `defineTool` builds.
 *
 * Fictitious identifiers only — no real client names.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildStrictInputSchema } from "../registerTool.js";

// Mirrors mcp-server/src/tools.ts:3184-3199 (set_summary's declared shape)
// exactly — DO NOT drift this from the real registration; if tools.ts
// changes the shape, update this mirror in the same commit.
const setSummaryShape = {
	orchestratorId: z.string(),
	instanceId: z.string().optional(),
	summary: z.string(),
	endOfDayIndex: z.string().optional(),
};

describe("set_summary — unknown-param silent-drop defect (mission k17at41v7e6re4ht9wbf3cvdah8cepjc)", () => {
	it("RED #1 (now GREEN post-fix): an UNKNOWN param is refused loudly and names the offending key", () => {
		const schema = buildStrictInputSchema(setSummaryShape);

		const result = schema.safeParse({
			orchestratorId: "alpha",
			instanceId: "alpha-vps",
			summary: "Standardizing tool descriptions",
			// `bogusStaleParam` is NOT in the shape — simulates a param the
			// server does not recognize (typo, or a client on a stale schema
			// sending a field the current server dropped).
			bogusStaleParam: "should-not-vanish-silently",
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			// Must NAME the offending parameter — a generic refusal is not
			// acceptable per the task's hard requirement.
			const unrecognizedIssue = result.error.issues.find(
				(issue) => issue.code === "unrecognized_keys",
			);
			expect(unrecognizedIssue).toBeDefined();
			expect((unrecognizedIssue as { keys: string[] }).keys).toContain(
				"bogusStaleParam",
			);
			expect(JSON.stringify(result.error.issues)).toContain(
				"bogusStaleParam",
			);
		}
	});

	it("MUST_PASS: a normal, complete, well-formed set_summary call still succeeds", () => {
		const schema = buildStrictInputSchema(setSummaryShape);

		const result = schema.safeParse({
			orchestratorId: "alpha",
			instanceId: "alpha-vps",
			summary: "Standardizing tool descriptions",
			endOfDayIndex: "EOD-INDEX 2026-08-14: 3 tasks closed",
		});

		expect(result.success).toBe(true);
	});

	it("MUST_PASS: a well-formed call OMITTING the optional endOfDayIndex still succeeds (frozen/stale client tool-list case)", () => {
		const schema = buildStrictInputSchema(setSummaryShape);

		// Mirrors the exact station scenario: a client connected before
		// `endOfDayIndex` existed, sending only 3 of the 4 published props.
		const result = schema.safeParse({
			orchestratorId: "alpha",
			instanceId: "alpha-vps",
			summary: "Standardizing tool descriptions",
		});

		expect(result.success).toBe(true);
	});
});
