/**
 * Every tool the server serves is called end to end through /mcp, and answers
 * a success (VantagePeers Cloud, task k17d1q04zkfqnwxnjf6rjdbtqh8htnd0,
 * coverage 3/3).
 *
 * WHICH TOOLS: derived from tools/list, as served to every client of the
 * world (a person with a bound agent, the fleet master, and the fleet master
 * presenting a fleet agent's credential), never from a typed list. A tool
 * added to the server is therefore covered here the moment it is served.
 *
 * WHAT COUNTS AS CALLED, and why this mechanism: the per-tool table CALLS
 * (test/lib/e2eWorld.ts), run here through the real Hono app, the real bearer
 * middleware, the real McpServer and the real Convex functions (convex-test).
 * A tool is covered when its call in that table RESOLVED (no transport or
 * protocol error) with a result that is NOT an error result. A suite-wide
 * recorder was rejected: vitest runs files in separate workers and in no
 * fixed order, so a recorder read by a gate file sees only the files that
 * happened to run before it in the same worker, and an isError answer (a
 * refusal) would count as coverage. The table is deterministic, and it holds
 * the same calls the outputSchema suite validates.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CALLS, closeE2E, results, runE2E, served } from "./lib/e2eWorld.js";

vi.mock("convex/browser", async () => ({
	ConvexHttpClient: (await import("./lib/forwardingConvex.js"))
		.ForwardingConvexHttpClient,
}));

beforeAll(runE2E, 180_000);

afterAll(closeE2E);

describe("tool coverage: every served tool is called end to end through /mcp", () => {
	it("tools/list serves tools (the derivation is not degenerate)", () => {
		expect(served.size).toBeGreaterThan(80);
	});

	it("every served tool has a call in the table that answered a success", () => {
		const uncovered = [...served]
			.filter((tool) => {
				const r = results.get(tool);
				return r === undefined || r.isError === true;
			})
			.sort();
		expect(uncovered).toEqual([]);
	});

	it("the table calls nothing the server does not serve", () => {
		const unknown = [...new Set(CALLS.map((c) => c.tool))]
			.filter((t) => !served.has(t))
			.sort();
		expect(unknown).toEqual([]);
	});
});
