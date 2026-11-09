/**
 * erase_fix_pattern end to end through the real /mcp route (task
 * k176x68sj2jkwx46nshvtt40e18ht1xh): a SUCCESS as an admin of the operator
 * organisation (a person bearer, built by test/lib/e2eWorld.ts), and the refusals
 * the door owes everyone else, relayed as RBAC_DENIED with the pattern unchanged.
 * The success also validates against the tool's outputSchema in
 * test/output-schema-structured-content.test.ts and counts in
 * test/tool-coverage.test.ts through the same CALLS table.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeE2E, poles, results, runE2E, seeded, world } from "./lib/e2eWorld.js";

vi.mock("convex/browser", async () => ({
	ConvexHttpClient: (await import("./lib/forwardingConvex.js"))
		.ForwardingConvexHttpClient,
}));

beforeAll(runE2E, 180_000);
afterAll(closeE2E);

const present = (id: string) =>
	world.t.run(async (ctx) => (await ctx.db.get(world.ids.toBackend(id) as never)) !== null);

describe("erase_fix_pattern through /mcp", () => {
	it("SERVED: an admin of the operator organisation erases the pattern and its attempts", async () => {
		const r = results.get("erase_fix_pattern");
		expect(r?.isError, r?.content[0]?.text).toBeFalsy();
		expect(r?.structuredContent).toMatchObject({
			erased: true,
			cascaded: { fixAttempts: 1 },
		});
		expect(await present(seeded.erase.patternId)).toBe(false);
	});

	for (const pole of ["agent-seat", "client-person"]) {
		it(`REFUSED: ${pole} gets RBAC_DENIED and the pattern is unchanged`, async () => {
			const r = poles.get(`refused:erase_fix_pattern:${pole}`);
			expect(r?.isError).toBe(true);
			expect(r?.content[0]?.text).toContain("RBAC_DENIED");
			expect(await present(seeded.erase.keptPatternId)).toBe(true);
		});
	}
});
