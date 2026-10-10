/// <reference types="vite/client" />
//
// Task k173nws3xcp969t7dtvet5zqd58fr8gr, module M1: clientOrgMapping:addRosterMembers
// is the ONE append-only write path for a client org's roster, and it writes
// AGENT IDs (client_org_mapping.allowedAgentIds). Never removes or reorders,
// never lists an agent of another organisation (the operator's included), an
// inactive agent or a non-agent id, never touches the operator org or an
// inactive org. The legacy name roster is copied beside it (labels only).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const CLIENT = "cgt-alsachimie";

async function seedAgent(
	t: T,
	orgSlug: string,
	name: string,
	isActive = true,
): Promise<Id<"agents">> {
	return await t.run((ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			name,
			normalizedName: name.toLowerCase(),
			isActive,
			createdAt: Date.now(),
		}),
	);
}

async function seedOrg(
	t: T,
	clerkOrgSlug: string,
	allowedOrchestrators: string[],
	opts: {
		orgKind?: "operator" | "client";
		isActive?: boolean;
		allowedAgentIds?: Id<"agents">[];
	} = {},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: opts.isActive ?? true,
			createdAt: Date.now(),
			...(opts.orgKind !== undefined ? { orgKind: opts.orgKind } : {}),
			...(opts.allowedAgentIds !== undefined
				? { allowedAgentIds: opts.allowedAgentIds }
				: {}),
		});
	});
}

async function seedWorld(t: T) {
	const neo = await seedAgent(t, CLIENT, "neo");
	const hal = await seedAgent(t, CLIENT, "hal");
	const mimir = await seedAgent(t, CLIENT, "mimir");
	const bob = await seedAgent(t, CLIENT, "bob");
	const zed = await seedAgent(t, CLIENT, "zed");
	const dormant = await seedAgent(t, CLIENT, "dormant", false);
	const opPi = await seedAgent(t, "perello", "pi");
	const otherAda = await seedAgent(t, "other-client", "ada");
	await seedOrg(t, "perello", ["pi", "sigma"], { orgKind: "operator" });
	await seedOrg(t, CLIENT, ["neo", "hal", "mimir"], {
		orgKind: "client",
		allowedAgentIds: [neo, hal, mimir],
	});
	return { neo, hal, mimir, bob, zed, dormant, opPi, otherAda };
}

async function rowOf(t: T, slug: string) {
	return await t.run(async (ctx) =>
		ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.unique(),
	);
}

const add = (t: T, clerkOrgSlug: string, agentIds: Id<"agents">[]) =>
	t.mutation(internal.clientOrgMapping.addRosterMembers, {
		clerkOrgSlug,
		agentIds,
	});

describe("addRosterMembers: append", () => {
	test("(a) appending bob gives [neo,hal,mimir,bob] by ID, previous [neo,hal,mimir]; the label is copied beside it", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const r = await add(t, CLIENT, [w.bob]);
		expect(r).toEqual({
			clerkOrgSlug: CLIENT,
			previous: [w.neo, w.hal, w.mimir],
			current: [w.neo, w.hal, w.mimir, w.bob],
		});
		const row = await rowOf(t, CLIENT);
		expect(row?.allowedAgentIds).toEqual([w.neo, w.hal, w.mimir, w.bob]);
		expect(row?.allowedOrchestrators).toEqual(["neo", "hal", "mimir", "bob"]);
	});

	test("(b) appending neo again is a no-op, no duplicate", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const r = await add(t, CLIENT, [w.neo]);
		expect(r.previous).toEqual([w.neo, w.hal, w.mimir]);
		expect(r.current).toEqual([w.neo, w.hal, w.mimir]);
		const row = await rowOf(t, CLIENT);
		expect(row?.allowedAgentIds).toEqual([w.neo, w.hal, w.mimir]);
		expect(row?.allowedOrchestrators).toEqual(["neo", "hal", "mimir"]);
	});

	test("(b) a repeated ID inside one call is stored once", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const r = await add(t, CLIENT, [w.bob, w.bob, w.neo]);
		expect(r.current).toEqual([w.neo, w.hal, w.mimir, w.bob]);
	});

	test("(e) existing IDs are never removed or reordered", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await add(t, CLIENT, [w.zed]);
		await add(t, CLIENT, [w.bob]);
		await add(t, CLIENT, []);
		expect((await rowOf(t, CLIENT))?.allowedAgentIds).toEqual([
			w.neo,
			w.hal,
			w.mimir,
			w.zed,
			w.bob,
		]);
	});

	test("(e) a refused call leaves the roster untouched", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(add(t, CLIENT, [w.bob, w.opPi])).rejects.toThrow();
		const row = await rowOf(t, CLIENT);
		expect(row?.allowedAgentIds).toEqual([w.neo, w.hal, w.mimir]);
		expect(row?.allowedOrchestrators).toEqual(["neo", "hal", "mimir"]);
	});

	test("(f) a first write on an org with no stored ID roster creates it", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await seedOrg(t, "fresh", ["x"], { orgKind: "client" });
		const fresh = await seedAgent(t, "fresh", "x");
		const r = await add(t, "fresh", [fresh]);
		expect(r.previous).toEqual([]);
		expect(r.current).toEqual([fresh]);
		expect(w.neo).toBeDefined();
	});
});

describe("addRosterMembers: refused agents", () => {
	test("(c) an operator-org agent is refused: a client lists the agents of its own org only", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(add(t, CLIENT, [w.opPi])).rejects.toThrow(/AGENT_NOT_IN_ORG/);
	});

	test("(c) another client's agent, even one named like a local agent, is refused", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(add(t, CLIENT, [w.otherAda])).rejects.toThrow(
			/AGENT_NOT_IN_ORG/,
		);
	});

	test("(c) an inactive agent is refused", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(add(t, CLIENT, [w.dormant])).rejects.toThrow(
			/AGENT_NOT_IN_ORG/,
		);
	});

	test("(c) a deleted agent is refused", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await t.run((ctx) => ctx.db.delete(w.bob));
		await expect(add(t, CLIENT, [w.bob])).rejects.toThrow(/AGENT_NOT_IN_ORG/);
	});
});

describe("addRosterMembers: refused orgs", () => {
	test("(d) the operator org is refused", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(add(t, "perello", [w.opPi])).rejects.toThrow(
			/OPERATOR_ORG_ROSTER_OUT_OF_SCOPE/,
		);
		expect((await rowOf(t, "perello"))?.allowedOrchestrators).toEqual([
			"pi",
			"sigma",
		]);
	});

	test("(d) an unknown slug is refused", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(add(t, "nobody", [w.bob])).rejects.toThrow(
			/ORG_MAPPING_NOT_FOUND/,
		);
	});

	test("(d) an inactive client org is refused", async () => {
		const t = createT();
		await seedWorld(t);
		const neo = await seedAgent(t, "dormant-org", "neo");
		const bob = await seedAgent(t, "dormant-org", "bob");
		await seedOrg(t, "dormant-org", ["neo"], {
			orgKind: "client",
			isActive: false,
			allowedAgentIds: [neo],
		});
		await expect(add(t, "dormant-org", [bob])).rejects.toThrow(
			/ORG_MAPPING_INACTIVE/,
		);
		expect((await rowOf(t, "dormant-org"))?.allowedAgentIds).toEqual([neo]);
	});
});
