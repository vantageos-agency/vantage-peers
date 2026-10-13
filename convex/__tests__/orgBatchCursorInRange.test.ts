/// <reference types="vite/client" />
/**
 * BATCH F2 (org lane) — R-55: a read narrows by every predicate BEFORE it bounds
 * the result. The cursor anchor (`createdBefore`, or the businessUnits `cursor`)
 * of `mandates:list`, `profiles:listProfiles`, `missions:list` and
 * `businessUnits:list` used to be applied to a window that `.take()` had already
 * cut: a fixed-size wide scan (2000 rows) that finds the older rows only while
 * they happen to sit inside the newest 2001. With more rows than that, the page
 * came back EMPTY although older rows existed ("a short page while more exist").
 *
 * Each test seeds 2 rows older than the anchor BEHIND 2001+ newer rows, so the
 * old window holds none of them. The anchor in the index range finds them.
 *
 * Poles per read: PRESENT (the older rows are served), ABSENT (an anchor older
 * than every row serves a genuine empty success, not a refusal), REFUSED (a
 * caller that is not the fleet is not served: the existing deny poles in
 * publicRegistrationResolvesCaller.test.ts), cross-org (an ordinary member of
 * another organisation gets the typed envelope, never these rows).
 */

import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const FLEET = { subject: "test-service-account-user-id" };
type T = ReturnType<typeof createT>;
const createT = () => convexTest(schema, modules);
const asFleet = (t: T) =>
	t.withIdentity(FLEET as Parameters<typeof t.withIdentity>[0]);

// More rows than the old wide scan (2000 + 1) reads.
const NEWER = 2003;

async function ageOf(
	t: T,
	table: "mandates" | "profiles" | "missions" | "businessUnits",
): Promise<{ all: number[]; anchor: number; older: number[] }> {
	const times = await t.run(async (ctx) =>
		(await ctx.db.query(table).collect()).map((r) => r._creationTime),
	);
	const all = [...times].sort((a, b) => a - b);
	// The anchor is the creation time of the THIRD-oldest row: exactly the two
	// oldest rows are older than it.
	const anchor = all[2];
	return { all, anchor, older: all.filter((c) => c < anchor) };
}

describe("R-55: the cursor anchor is inside the read, not applied to a cut window", () => {
	test("mandates:list createdBefore reaches older rows behind 2001+ newer ones", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < NEWER; i++) {
				await ctx.db.insert("mandates", {
					requestedBy: "sigma",
					fulfilledBy: "eta",
					service: `s-${i}`,
					budget: 1,
					status: "requested",
					createdAt: i,
					updatedAt: i,
				});
			}
		});
		const { anchor, older } = await ageOf(t, "mandates");
		expect(older).toHaveLength(2);
		const page = await asFleet(t).query(api.mandates.list, {
			limit: 50,
			createdBefore: anchor,
		});
		if (!Array.isArray(page)) throw new Error("fleet was refused");
		expect(page.map((r) => r._creationTime).sort((a, b) => a - b)).toEqual(older);
	});

	test("mandates:list: an anchor older than every row is a genuine empty success", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("mandates", {
				requestedBy: "sigma",
				fulfilledBy: "eta",
				service: "only",
				budget: 1,
				status: "requested",
				createdAt: 1,
				updatedAt: 1,
			});
		});
		const page = await asFleet(t).query(api.mandates.list, {
			limit: 10,
			createdBefore: 1,
		});
		expect(page).toEqual([]);
	});

	test("profiles:listProfiles createdBefore reaches older rows behind 2001+ newer ones", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < NEWER; i++) {
				await ctx.db.insert("profiles", {
					orchestratorId: `orch-${i}`,
					name: `orch-${i}`,
					static: { role: "r", workspace: "w", capabilities: [] },
					dynamic: { lastSeen: i, sessionCount: 0 },
				});
			}
		});
		const { anchor, older } = await ageOf(t, "profiles");
		expect(older).toHaveLength(2);
		const page = await asFleet(t).query(api.profiles.listProfiles, {
			limit: 50,
			createdBefore: anchor,
		});
		if (!Array.isArray(page)) throw new Error("fleet was refused");
		expect(page.map((r) => r._creationTime).sort((a, b) => a - b)).toEqual(older);
	});

	test("missions:list (fleet, no filter) createdBefore reaches older rows behind 2001+ newer ones", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < NEWER; i++) {
				await ctx.db.insert("missions", {
					name: `m-${i}`,
					project: "p",
					status: "plan",
					priority: "medium",
					pilot: "sigma",
					agents: ["sigma"],
					createdBy: "sigma",
					createdAt: i,
					updatedAt: i,
				});
			}
		});
		const { anchor, older } = await ageOf(t, "missions");
		expect(older).toHaveLength(2);
		const page = (await asFleet(t).query(api.missions.list, {
			limit: 50,
			fields: "lite",
			createdBefore: anchor,
		})) as { _creationTime: number }[];
		expect(page.map((r) => r._creationTime).sort((a, b) => a - b)).toEqual(older);
	});

	test("missions:list (fleet, project filter) createdBefore reaches older rows behind 2001+ newer ones", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < NEWER; i++) {
				await ctx.db.insert("missions", {
					name: `m-${i}`,
					project: "p",
					status: "plan",
					priority: "medium",
					pilot: "sigma",
					agents: ["sigma"],
					createdBy: "sigma",
					createdAt: i,
					updatedAt: i,
				});
			}
		});
		const { anchor, older } = await ageOf(t, "missions");
		const page = (await asFleet(t).query(api.missions.list, {
			limit: 50,
			fields: "lite",
			project: "p",
			createdBefore: anchor,
		})) as { _creationTime: number }[];
		expect(page.map((r) => r._creationTime).sort((a, b) => a - b)).toEqual(older);
	});

	test("businessUnits:list legacy createdBefore and the cursor reach older rows behind 2001+ newer ones", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < NEWER; i++) {
				await ctx.db.insert("businessUnits", {
					name: `bu-${i}`,
					description: "d",
					purpose: "p",
					orchestratorId: "sigma",
					status: "idea",
					businessModel: "m",
					targetCustomers: "c",
					services: [],
					pricing: "p",
					revenueProjections: { y1: 1, y2: 2, y3: 3 },
					coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
					coreProcesses: [],
					dependencies: [],
					kpis: [],
					managementFee: 10,
					createdAt: i,
					updatedAt: i,
				});
			}
		});
		const { anchor, older, all } = await ageOf(t, "businessUnits");
		expect(older).toHaveLength(2);
		const legacy = await asFleet(t).query(api.businessUnits.list, {
			limit: 50,
			fields: "lite",
			createdBefore: anchor,
		});
		expect(
			legacy.items.map((r) => r._creationTime).sort((a, b) => a - b),
		).toEqual(older);

		// The cursor of the page that ends at the third-oldest row resumes at the
		// two oldest, however deep that row sits.
		const row = await t.run(async (ctx) =>
			(await ctx.db.query("businessUnits").collect()).find(
				(r) => r._creationTime === all[2],
			),
		);
		const cursor = btoa(JSON.stringify({ time: all[2], id: row?._id }));
		const resumed = await asFleet(t).query(api.businessUnits.list, {
			limit: 50,
			fields: "lite",
			cursor,
		});
		expect(
			resumed.items.map((r) => r._creationTime).sort((a, b) => a - b),
		).toEqual(older);
	});

	test("cross-org: an ordinary member of another organisation is not served the fleet's rows", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-x",
				clerkOrgId: testClerkOrgId("org-x"),
				allowedOrchestrators: [],
				scopes: ["view-own-missions"],
				displayName: "org-x",
				isActive: true,
				createdAt: Date.now(),
			});
			await ctx.db.insert("mandates", {
				requestedBy: "sigma",
				fulfilledBy: "eta",
				service: "fleet-only",
				budget: 1,
				status: "requested",
				createdAt: 1,
				updatedAt: 1,
			});
			await ctx.db.insert("profiles", {
				orchestratorId: "sigma",
				name: "sigma",
				static: { role: "r", workspace: "w", capabilities: [] },
				dynamic: { lastSeen: 1, sessionCount: 0 },
			});
		});
		const member = t.withIdentity({
			subject: "member-of-x",
			organizationId: "org-x",
			org_id: testClerkOrgId("org-x"),
			org_role: "org:editor",
		} as Parameters<typeof t.withIdentity>[0]);
		const mandates = await member.query(api.mandates.list, {
			createdBefore: Date.now() + 1e6,
		});
		expect(mandates).toEqual({ refused: true, items: [] });
		const profiles = await member.query(api.profiles.listProfiles, {
			createdBefore: Date.now() + 1e6,
		});
		expect(profiles).toEqual({ refused: true, items: [] });
	});
});
