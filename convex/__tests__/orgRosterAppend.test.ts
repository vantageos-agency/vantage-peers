/// <reference types="vite/client" />
//
// Task k173nws3xcp969t7dtvet5zqd58fr8gr: clientOrgMapping:addRosterMembers is
// the ONE append-only write path for a client org's roster
// (client_org_mapping.allowedOrchestrators). Never removes or reorders, never
// admits "*" or an operator orchestrator's name, never touches the operator
// org or an inactive org.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedOrg(
	t: T,
	clerkOrgSlug: string,
	allowedOrchestrators: string[],
	opts: { orgKind?: "operator" | "client"; isActive?: boolean } = {},
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
		});
	});
}

async function seedWorld(t: T) {
	await seedOrg(t, "perello", ["pi", "sigma"], { orgKind: "operator" });
	await seedOrg(t, "cgt-alsachimie", ["neo", "hal", "mimir"], {
		orgKind: "client",
	});
}

async function rosterOf(t: T, slug: string) {
	return await t.run(async (ctx) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.unique();
		return row?.allowedOrchestrators ?? null;
	});
}

const add = (t: T, clerkOrgSlug: string, names: string[]) =>
	t.mutation(internal.clientOrgMapping.addRosterMembers, {
		clerkOrgSlug,
		names,
	});

describe("addRosterMembers: append", () => {
	test("(a) appending bob gives [neo,hal,mimir,bob], previous [neo,hal,mimir]", async () => {
		const t = createT();
		await seedWorld(t);
		const r = await add(t, "cgt-alsachimie", ["bob"]);
		expect(r).toEqual({
			clerkOrgSlug: "cgt-alsachimie",
			previous: ["neo", "hal", "mimir"],
			current: ["neo", "hal", "mimir", "bob"],
		});
		expect(await rosterOf(t, "cgt-alsachimie")).toEqual([
			"neo",
			"hal",
			"mimir",
			"bob",
		]);
	});

	test("(a) names are normalised before storing", async () => {
		const t = createT();
		await seedWorld(t);
		const r = await add(t, "cgt-alsachimie", ["  Bob "]);
		expect(r.current).toEqual(["neo", "hal", "mimir", "bob"]);
	});

	test("(b) appending neo again is a no-op, no duplicate", async () => {
		const t = createT();
		await seedWorld(t);
		const r = await add(t, "cgt-alsachimie", ["neo"]);
		expect(r.previous).toEqual(["neo", "hal", "mimir"]);
		expect(r.current).toEqual(["neo", "hal", "mimir"]);
		expect(await rosterOf(t, "cgt-alsachimie")).toEqual([
			"neo",
			"hal",
			"mimir",
		]);
	});

	test("(b) a repeated name inside one call is stored once", async () => {
		const t = createT();
		await seedWorld(t);
		const r = await add(t, "cgt-alsachimie", ["bob", "BOB", "neo"]);
		expect(r.current).toEqual(["neo", "hal", "mimir", "bob"]);
	});

	test("(e) existing names are never removed or reordered", async () => {
		const t = createT();
		await seedWorld(t);
		await add(t, "cgt-alsachimie", ["zed"]);
		await add(t, "cgt-alsachimie", ["bob"]);
		await add(t, "cgt-alsachimie", []);
		expect(await rosterOf(t, "cgt-alsachimie")).toEqual([
			"neo",
			"hal",
			"mimir",
			"zed",
			"bob",
		]);
	});

	test("(e) a refused call leaves the roster untouched", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(add(t, "cgt-alsachimie", ["bob", "pi"])).rejects.toThrow();
		expect(await rosterOf(t, "cgt-alsachimie")).toEqual([
			"neo",
			"hal",
			"mimir",
		]);
	});
});

describe("addRosterMembers: refused names", () => {
	test('(c) "*" is refused', async () => {
		const t = createT();
		await seedWorld(t);
		await expect(add(t, "cgt-alsachimie", ["*"])).rejects.toThrow(
			/INVALID_ROSTER_NAME/,
		);
	});

	test("(c) the empty string is refused", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(add(t, "cgt-alsachimie", [" "])).rejects.toThrow(
			/INVALID_ROSTER_NAME/,
		);
	});

	test('(c) "Bad Name!" is refused', async () => {
		const t = createT();
		await seedWorld(t);
		await expect(add(t, "cgt-alsachimie", ["Bad Name!"])).rejects.toThrow(
			/INVALID_ROSTER_NAME/,
		);
	});

	test("(c) a name over 41 characters is refused", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(add(t, "cgt-alsachimie", ["a".repeat(42)])).rejects.toThrow(
			/INVALID_ROSTER_NAME/,
		);
	});

	test("(c) pi, on an active operator roster, is refused", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(add(t, "cgt-alsachimie", ["pi"])).rejects.toThrow(
			/OPERATOR_ORCHESTRATOR_NAME/,
		);
		await expect(add(t, "cgt-alsachimie", ["SIGMA"])).rejects.toThrow(
			/OPERATOR_ORCHESTRATOR_NAME/,
		);
	});

	test("(c) a name on an INACTIVE operator roster is not reserved", async () => {
		const t = createT();
		await seedOrg(t, "old-operator", ["relic"], {
			orgKind: "operator",
			isActive: false,
		});
		await seedOrg(t, "cgt-alsachimie", ["neo"], { orgKind: "client" });
		const r = await add(t, "cgt-alsachimie", ["relic"]);
		expect(r.current).toEqual(["neo", "relic"]);
	});
});

describe("addRosterMembers: refused orgs", () => {
	test("(d) the operator org is refused", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(add(t, "perello", ["bob"])).rejects.toThrow(
			/OPERATOR_ORG_ROSTER_OUT_OF_SCOPE/,
		);
		expect(await rosterOf(t, "perello")).toEqual(["pi", "sigma"]);
	});

	test("(d) an unknown slug is refused", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(add(t, "nobody", ["bob"])).rejects.toThrow(
			/ORG_MAPPING_NOT_FOUND/,
		);
	});

	test("(d) an inactive client org is refused", async () => {
		const t = createT();
		await seedWorld(t);
		await seedOrg(t, "dormant", ["neo"], {
			orgKind: "client",
			isActive: false,
		});
		await expect(add(t, "dormant", ["bob"])).rejects.toThrow(
			/ORG_MAPPING_INACTIVE/,
		);
		expect(await rosterOf(t, "dormant")).toEqual(["neo"]);
	});
});
