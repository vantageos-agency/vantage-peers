/// <reference types="vite/client" />
/**
 * MEMBER DEFAULTS — two defects measured live on dev with a real ordinary
 * member (Clerk role org:editor) of a freshly provisioned org.
 *
 *  1. WITHHELD GRANT: provisionOrganization defaulted the mapping scopes to
 *     ["view-own-tasks"], so a member of a new org was refused its OWN org's
 *     missions (RBAC_DENIED Missing scope "view-own-missions").
 *  2. EXISTENCE ORACLE: profiles:getProfile refused a non-roster orchestrator
 *     only when a profile row existed, and answered success `null` when none did.
 *
 * Every deny pole is an ORDINARY member; the master/service account appears
 * only where a fixture needs privileged setup, never to prove a denial.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER = "test-master-token-member-defaults";
beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

type T = ReturnType<typeof createT>;
const createT = () => convexTest(schema, modules);

const asMemberOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `editor-of-${org}`,
		organizationId: org,
		organizationSlug: org,
		orgRole: "org:editor",
	} as Parameters<typeof t.withIdentity>[0]);

async function provision(t: T, slug: string, seat: string) {
	// NO `scopes` argument: the default is the subject under test.
	await t.mutation(api.oauth.provisionOrganization, {
		callerToken: MASTER,
		clerkOrgSlug: slug,
		displayName: slug,
		orchestrators: [{ name: seat }],
	});
}

async function seedMission(t: T, name: string, orgId: string, pilot: string) {
	await t.run((ctx) =>
		ctx.db.insert("missions", {
			name,
			project: "p",
			status: "execute",
			priority: "medium",
			pilot,
			agents: [pilot],
			createdBy: pilot,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId,
		} as never),
	);
}

async function mappingScopes(t: T, slug: string): Promise<string[]> {
	return await t.run(async (ctx) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.unique();
		return row?.scopes ?? [];
	});
}

describe("provisionOrganization default member scopes", () => {
	test("a member of a freshly provisioned org reads its OWN org's missions only", async () => {
		const t = createT();
		await provision(t, "org-a", "seat-a");
		await provision(t, "org-b", "seat-b");
		await seedMission(t, "mission-of-a", "org-a", "seat-a");
		await seedMission(t, "mission-of-b", "org-b", "seat-b");

		const rows = (await asMemberOf(t, "org-a").query(api.missions.list, {})) as {
			name: string;
		}[];
		expect(rows.map((r) => r.name)).toEqual(["mission-of-a"]);
	});

	test("the default carries no cross-tenant or fleet-wide scope", async () => {
		const t = createT();
		await provision(t, "org-a", "seat-a");
		const scopes = await mappingScopes(t, "org-a");
		expect([...scopes].sort()).toEqual(["view-own-missions", "view-own-tasks"]);
		for (const forbidden of [
			"cross-tenant-read",
			"view-stats-aggregated",
			"view-orchestrator-summary",
		]) {
			expect(scopes).not.toContain(forbidden);
		}
	});

	test("a fleet-wide aggregate stays refused for that same member", async () => {
		const t = createT();
		await provision(t, "org-a", "seat-a");
		await expect(
			asMemberOf(t, "org-a").query(api.stats.openTaskCountsByOrchestrator, {}),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			asMemberOf(t, "org-a").query(api.issues.getStats, {}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("profiles:getProfile — roster check does not depend on existence", () => {
	async function seedProfile(t: T, orchestratorId: string) {
		await t.run((ctx) =>
			ctx.db.insert("profiles", {
				orchestratorId,
				name: orchestratorId,
				static: { role: orchestratorId, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			}),
		);
	}

	test("non-roster orchestrator WITH a row -> refused not-on-roster", async () => {
		const t = createT();
		await provision(t, "org-a", "seat-a");
		await seedProfile(t, "outsider");
		await expect(
			asMemberOf(t, "org-a").query(api.profiles.getProfile, {
				orchestratorId: "outsider",
			}),
		).rejects.toThrow(/not-on-roster/);
	});

	test("non-roster orchestrator WITHOUT a row -> refused identically (no oracle)", async () => {
		const t = createT();
		await provision(t, "org-a", "seat-a");
		await expect(
			asMemberOf(t, "org-a").query(api.profiles.getProfile, {
				orchestratorId: "ghost",
			}),
		).rejects.toThrow(/not-on-roster/);
	});

	test("on-roster WITHOUT a row -> null (an absence stays an absence)", async () => {
		const t = createT();
		await provision(t, "org-a", "seat-a");
		const r = await asMemberOf(t, "org-a").query(api.profiles.getProfile, {
			orchestratorId: "seat-a",
		});
		expect(r).toBeNull();
	});

	test("on-roster WITH a row -> served", async () => {
		const t = createT();
		await provision(t, "org-a", "seat-a");
		await seedProfile(t, "seat-a");
		const r = await asMemberOf(t, "org-a").query(api.profiles.getProfile, {
			orchestratorId: "seat-a",
		});
		expect(r?.orchestratorId).toBe("seat-a");
	});
});

describe("memberScopesMigration:addDefaultMemberScopes", () => {
	async function seedLegacy(t: T) {
		const base = {
			allowedOrchestrators: ["x"],
			displayName: "d",
			createdAt: Date.now(),
		};
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				...base,
				clerkOrgSlug: "legacy",
				scopes: ["view-own-tasks"],
				isActive: true,
			});
			await ctx.db.insert("client_org_mapping", {
				...base,
				clerkOrgSlug: "inactive",
				scopes: ["view-own-tasks"],
				isActive: false,
			});
			await ctx.db.insert("client_org_mapping", {
				...base,
				allowedOrchestrators: ["*"],
				fleetWide: true, // the explicit flag that replaced the "*" sentinel (M1)
				clerkOrgSlug: "master-sentinel",
				scopes: ["cross-tenant-read"],
				isActive: true,
			});
			await ctx.db.insert("client_org_mapping", {
				...base,
				clerkOrgSlug: "already",
				scopes: ["view-own-tasks", "view-own-missions"],
				isActive: true,
			});
		});
	}
	const run = (t: T, dryRun: boolean, extra: { batchSize?: number } = {}) =>
		t.mutation(internal.memberScopesMigration.addDefaultMemberScopes, {
			dryRun,
			cursor: null,
			...extra,
		});

	test("dry run reports and writes nothing", async () => {
		const t = createT();
		await seedLegacy(t);
		const r = await run(t, true);
		expect(r.updatedSlugs).toEqual(["legacy"]);
		expect(await mappingScopes(t, "legacy")).toEqual(["view-own-tasks"]);
	});

	test("real run adds own-org scopes only to active non-master mappings, never cross-tenant-read", async () => {
		const t = createT();
		await seedLegacy(t);
		const r = await run(t, false);
		expect(r.updated).toBe(1);
		expect((await mappingScopes(t, "legacy")).sort()).toEqual([
			"view-own-missions",
			"view-own-tasks",
		]);
		expect(await mappingScopes(t, "inactive")).toEqual(["view-own-tasks"]);
		expect(await mappingScopes(t, "master-sentinel")).toEqual([
			"cross-tenant-read",
		]);
		for (const s of ["legacy", "already"]) {
			expect(await mappingScopes(t, s)).not.toContain("cross-tenant-read");
		}
	});

	test("second run is a no-op", async () => {
		const t = createT();
		await seedLegacy(t);
		await run(t, false);
		const again = await run(t, false);
		expect(again.updated).toBe(0);
		expect((await mappingScopes(t, "legacy")).length).toBe(2);
	});

	test("batchSize out of range is rejected", async () => {
		const t = createT();
		await expect(run(t, true, { batchSize: 0 })).rejects.toThrow(/out of expected range/);
		await expect(run(t, true, { batchSize: 201 })).rejects.toThrow(/out of expected range/);
	});

	test("paginates: a batch of 1 reports not done and a continue cursor", async () => {
		const t = createT();
		await seedLegacy(t);
		const r = await run(t, true, { batchSize: 1 });
		expect(r.scanned).toBe(1);
		expect(r.isDone).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// missions:list — the grant is consulted INSIDE the read, not after it
// (PR #1394 review). Burial pole: the member's own mission is OLDER than
// `limit` newer missions of another org. A fleet-wide `take(limit)` followed by
// filterByOrgScope served [] — byte-identical to "no missions".
// ─────────────────────────────────────────────────────────────────────────────
describe("missions:list — a member's mission is not buried under other orgs' newer rows", () => {
	type Row = { name: string; orgId?: string };
	const OTHERS = 40;

	async function buried(t: T) {
		await provision(t, "org-a", "seat-a");
		await provision(t, "org-b", "seat-b");
		await seedMission(t, "own-old", "org-a", "seat-a");
		for (let i = 0; i < OTHERS; i++) {
			await seedMission(t, `other-${i}`, "org-b", "seat-b");
		}
		// A legacy row with NO orgId, newest of all: never visible to a member.
		await t.run((ctx) =>
			ctx.db.insert("missions", {
				name: "legacy-no-org",
				project: "p",
				status: "execute",
				priority: "medium",
				pilot: "seat-a",
				agents: ["seat-a"],
				createdBy: "seat-a",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never),
		);
	}

	const names = (rows: unknown) => (rows as Row[]).map((r) => r.name);

	test("served for {} (default limit 50)", async () => {
		const t = createT();
		await buried(t);
		expect(names(await asMemberOf(t, "org-a").query(api.missions.list, {}))).toEqual([
			"own-old",
		]);
	});

	test("served for the MCP defaults (limit 20, lite)", async () => {
		const t = createT();
		await buried(t);
		const rows = await asMemberOf(t, "org-a").query(api.missions.list, {
			limit: 20,
			fields: "lite",
		});
		expect(names(rows)).toEqual(["own-old"]);
	});

	test("served for limit 1", async () => {
		const t = createT();
		await buried(t);
		const rows = await asMemberOf(t, "org-a").query(api.missions.list, { limit: 1 });
		expect(names(rows)).toEqual(["own-old"]);
	});

	test("served under a status filter and a project filter", async () => {
		const t = createT();
		await buried(t);
		const m = asMemberOf(t, "org-a");
		expect(names(await m.query(api.missions.list, { status: "execute", limit: 1 }))).toEqual([
			"own-old",
		]);
		expect(names(await m.query(api.missions.list, { status: ["execute", "plan"], limit: 1 }))).toEqual([
			"own-old",
		]);
		expect(names(await m.query(api.missions.list, { project: "p", limit: 1 }))).toEqual([
			"own-old",
		]);
		expect(names(await m.query(api.missions.list, { pilot: "seat-a" as never, limit: 1 }))).toEqual([
			"own-old",
		]);
	});

	test("another org's missions and the orgId-less legacy row are never returned", async () => {
		const t = createT();
		await buried(t);
		const rows = (await asMemberOf(t, "org-b").query(api.missions.list, {
			limit: 100,
		})) as Row[];
		expect(rows).toHaveLength(OTHERS);
		expect(rows.every((r) => r.orgId === "org-b")).toBe(true);
		const own = (await asMemberOf(t, "org-a").query(api.missions.list, {
			limit: 100,
		})) as Row[];
		expect(own.map((r) => r.name)).toEqual(["own-old"]);
		expect(own.some((r) => r.name === "legacy-no-org")).toBe(false);
	});

	test("cursor paging (createdBefore) stays inside the org and pages correctly", async () => {
		const t = createT();
		await provision(t, "org-a", "seat-a");
		await provision(t, "org-b", "seat-b");
		for (let i = 0; i < 3; i++) await seedMission(t, `a-${i}`, "org-a", "seat-a");
		for (let i = 0; i < 5; i++) await seedMission(t, `b-${i}`, "org-b", "seat-b");
		const m = asMemberOf(t, "org-a");
		const page1 = (await m.query(api.missions.list, { limit: 2 })) as (Row & {
			_creationTime: number;
		})[];
		expect(names(page1)).toEqual(["a-2", "a-1"]);
		const page2 = await m.query(api.missions.list, {
			limit: 2,
			createdBefore: page1[1]._creationTime,
		});
		expect(names(page2)).toEqual(["a-0"]);
	});

	test("master path unchanged: reads fleet-wide, legacy rows included", async () => {
		const t = createT();
		await buried(t);
		const rows = (await t.query(internal.missions.listForWebhook, {
			limit: 100,
		})) as Row[];
		expect(rows).toHaveLength(OTHERS + 2);
		expect(rows.some((r) => r.name === "legacy-no-org")).toBe(true);
		expect(rows.some((r) => r.name === "own-old")).toBe(true);
	});
});
