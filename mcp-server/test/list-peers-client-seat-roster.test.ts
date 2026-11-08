/**
 * list_peers for a CLIENT org seat lists its own organisation's agents, each with
 * its agentId, and never another organisation's (VantagePeers Cloud, task
 * k177e8dyrnykk3c56yf2b0pgfs8hhz06).
 *
 * Measured at a22a021c: every seat of test/lib/seatWorld.ts reached the roster
 * path, orgRoster:getAgentDirectoryForAccessToken answered the org's agents, and
 * the per-name profiles:listProfiles enrichment then came back
 * `{ refused: true, items: [] }` (the MCP's client acts for the bearer's org via
 * `__actingOrg`, so Convex judges it an ordinary member and that door is
 * fleet-master-only). The whole listing was turned into REFUSED (RBAC_DENIED).
 *
 * Real /mcp route, real Convex functions (convex-test), two organisations seeded.
 */

import { describe, expect, it, vi } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import {
	closeWorld,
	connectAs,
	freshBackend,
	SEATS,
	type ToolResult,
	tokenFor,
} from "./lib/seatWorld.js";

vi.mock("convex/browser", async () => ({
	ConvexHttpClient: (await import("./lib/forwardingConvex.js"))
		.ForwardingConvexHttpClient,
}));

const OTHER_SLUG = "other-org";
const OTHER_ORG_ID = testClerkOrgId(OTHER_SLUG) as string;

describe("list_peers: a client org seat lists its own org's agents by agentId", () => {
	for (const seat of SEATS) {
		it(`${seat}: own org's agents with agentId, never another org's`, async () => {
			vi.stubGlobal(
				"fetch",
				async () => new Response("offline", { status: 503 }),
			);
			const world = await freshBackend(seat);
			try {
				const intruderId = await world.t.run(async (ctx) => {
					const now = Date.now();
					const intruder = await ctx.db.insert("agents", {
						orgSlug: OTHER_SLUG,
						clerkOrgId: OTHER_ORG_ID,
						name: "intruder",
						normalizedName: "intruder",
						ownerPersonId: "user_other",
						isActive: true,
						createdAt: now,
					});
					await ctx.db.insert("client_org_mapping", {
						clerkOrgSlug: OTHER_SLUG,
						clerkOrgId: OTHER_ORG_ID,
						allowedOrchestrators: ["intruder"],
						allowedAgentIds: [intruder],
						scopes: ["vantage:read"],
						displayName: OTHER_SLUG,
						isActive: true,
						createdAt: now,
					});
					return String(intruder);
				});
				const intruderAlias = world.ids.alias(intruderId);
				const client = await connectAs(await tokenFor(seat, world));
				const res = (await client.callTool({
					name: "list_peers",
					arguments: {},
				})) as ToolResult;
				await client.close();

				expect(res.isError, res.content[0]?.text).not.toBe(true);
				const parsed = JSON.parse(res.content[0].text);
				const peers: Array<{ name: string; agentId: string | null }> =
					Array.isArray(parsed) ? parsed : parsed.items;
				const byName = new Map(peers.map((p) => [p.name, p.agentId]));
				expect(byName.get("ulysse")).toBe(world.fixtures.strings.agentId);
				expect(byName.get("seatbot")).toBe(world.fixtures.strings.seatAgentId);
				expect(peers).toHaveLength(2);
				expect(res.content[0].text).not.toContain("intruder");
				expect(res.content[0].text).not.toContain(intruderAlias);
			} finally {
				closeWorld(world.harness);
				vi.unstubAllGlobals();
			}
		}, 120_000);
	}
});
