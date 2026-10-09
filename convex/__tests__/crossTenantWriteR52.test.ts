/// <reference types="vite/client" />
// crossTenantWriteR52.test.ts — task k17cncab6ymjkkwf7mbe72f9zh8fp0j2, step 3.
//
// R-52: a write that reaches a row carrying no (or an optional) tenant value,
// where the target is chosen by an argument or a caller-chosen stored field,
// must be dominated by a guard reading a SERVER-STAMPED tenant.
//
// Four sites, each pinned by two poles:
//   REFUSED  an ordinary member of org-a targeting an org-b row, or a fleet
//            (unstamped) row, is refused and the row is byte-identical after.
//   PRESENT  the legitimate owner (an org-a member on an org-a row) and the
//            fleet service account (master) are still served.
//
//   businessUnits:update   patch by args.buId
//   diary:write            patch by args.orchestrator + args.date
//   diary:deleteDiary      delete by args.diaryId
//   tasks:complete         patch of the mission named by the task's own
//                          caller-set missionId (completion itself is never
//                          refused; only the foreign mission is left alone)
//
// Fictitious identifiers only. The roster name "seat-x" sits on BOTH orgs'
// rosters on purpose: the roster check alone cannot tell the two tenants
// apart, which is exactly the gap the row stamp closes.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { fleetOperatorSlug, isFleetStamp, sameTenantStamp } from "../lib/operatorOrg";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const SEAT = "seat-x";
const asOrg = (t: T, slug: string) =>
	t.withIdentity({ subject: `user-${slug}`, organizationId: slug } as Parameters<
		T["withIdentity"]
	>[0]);
const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
		T["withIdentity"]
	>[0]);

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: 0,
		});
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [SEAT],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

const buFields = (name: string, orgId: string | undefined) => ({
	name,
	description: "d",
	purpose: "p",
	orchestratorId: SEAT,
	status: "idea" as const,
	businessModel: "m",
	targetCustomers: "c",
	services: [],
	pricing: "0",
	revenueProjections: { y1: 0, y2: 0, y3: 0 },
	coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
	coreProcesses: [],
	dependencies: [],
	kpis: [],
	managementFee: 10,
	createdAt: 1,
	updatedAt: 1,
	...(orgId !== undefined ? { orgId } : {}),
});

const NOTE = "Completed the work in commit abcdef1234567 with regression test, 3/3 pass";

describe("businessUnits:update — R-52", () => {
	test("REFUSED: org-a member cannot patch org-b's business unit (shared roster name)", async () => {
		const t = makeT();
		await seedOrgs(t);
		const buId = await t.run((ctx) =>
			ctx.db.insert("businessUnits", buFields("org-b bu", "org-b")),
		);
		const before = await t.run((ctx) => ctx.db.get(buId));
		await expect(
			asOrg(t, "org-a").mutation(api.businessUnits.update, {
				buId,
				callerOrchestrator: SEAT,
				name: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(buId))).toEqual(before);
	});

	test("REFUSED: org-a member cannot patch a fleet (unstamped) business unit", async () => {
		const t = makeT();
		await seedOrgs(t);
		const buId = await t.run((ctx) =>
			ctx.db.insert("businessUnits", buFields("fleet bu", undefined)),
		);
		const before = await t.run((ctx) => ctx.db.get(buId));
		await expect(
			asOrg(t, "org-a").mutation(api.businessUnits.update, {
				buId,
				callerOrchestrator: SEAT,
				name: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(buId))).toEqual(before);
	});

	test("PRESENT: org-a creates a business unit, stamped org-a, and updates it", async () => {
		const t = makeT();
		await seedOrgs(t);
		const a = asOrg(t, "org-a");
		const { createdAt: _c, updatedAt: _u, orgId: _o, ...createArgs } = buFields("own bu", undefined);
		const buId = await a.mutation(api.businessUnits.create, createArgs);
		expect((await t.run((ctx) => ctx.db.get(buId)))?.orgId).toBe("org-a");
		await a.mutation(api.businessUnits.update, {
			buId,
			callerOrchestrator: SEAT,
			name: "renamed",
		});
		expect((await t.run((ctx) => ctx.db.get(buId)))?.name).toBe("renamed");
	});

	test("PRESENT: the fleet service account still patches fleet and org rows", async () => {
		const t = makeT();
		await seedOrgs(t);
		const fleet = await t.run((ctx) =>
			ctx.db.insert("businessUnits", buFields("fleet bu", undefined)),
		);
		const orgB = await t.run((ctx) =>
			ctx.db.insert("businessUnits", buFields("org-b bu", "org-b")),
		);
		const m = asMaster(t);
		await m.mutation(api.businessUnits.update, { buId: fleet, callerOrchestrator: "system", name: "f2" });
		await m.mutation(api.businessUnits.update, { buId: orgB, callerOrchestrator: "system", name: "b2" });
		expect((await t.run((ctx) => ctx.db.get(fleet)))?.name).toBe("f2");
		expect((await t.run((ctx) => ctx.db.get(orgB)))?.name).toBe("b2");
	});
});

const diaryRow = (orgId: string | undefined) => ({
	date: "2026-10-01",
	orchestrator: SEAT,
	content: "original",
	createdAt: 1,
	...(orgId !== undefined ? { orgId } : {}),
});

describe("diary:write — R-52", () => {
	test("REFUSED: org-a's write never alters org-b's entry for the same seat name and date", async () => {
		const t = makeT();
		await seedOrgs(t);
		const id = await t.run((ctx) => ctx.db.insert("diary", diaryRow("org-b")));
		const before = await t.run((ctx) => ctx.db.get(id));
		const mine = await asOrg(t, "org-a").mutation(api.diary.write, {
			date: "2026-10-01",
			orchestrator: SEAT,
			content: "org-a's own",
		});
		expect(mine).not.toBe(id);
		expect(await t.run((ctx) => ctx.db.get(id))).toEqual(before);
		expect((await t.run((ctx) => ctx.db.get(mine)))?.orgId).toBe("org-a");
	});

	test("REFUSED: org-a's write never alters a fleet (unstamped) entry", async () => {
		const t = makeT();
		await seedOrgs(t);
		const id = await t.run((ctx) => ctx.db.insert("diary", diaryRow(undefined)));
		const before = await t.run((ctx) => ctx.db.get(id));
		const mine = await asOrg(t, "org-a").mutation(api.diary.write, {
			date: "2026-10-01",
			orchestrator: SEAT,
			content: "org-a's own",
		});
		expect(mine).not.toBe(id);
		expect(await t.run((ctx) => ctx.db.get(id))).toEqual(before);
	});

	test("PRESENT: org-a inserts a stamped entry and upserts it", async () => {
		const t = makeT();
		await seedOrgs(t);
		const a = asOrg(t, "org-a");
		const id = await a.mutation(api.diary.write, { date: "2026-10-01", orchestrator: SEAT, content: "v1" });
		expect((await t.run((ctx) => ctx.db.get(id)))?.orgId).toBe("org-a");
		const again = await a.mutation(api.diary.write, { date: "2026-10-01", orchestrator: SEAT, content: "v2" });
		expect(again).toBe(id);
		expect((await t.run((ctx) => ctx.db.get(id)))?.content).toBe("v2");
	});

	test("PRESENT: the fleet service account still upserts a fleet entry", async () => {
		const t = makeT();
		await seedOrgs(t);
		const id = await t.run((ctx) => ctx.db.insert("diary", diaryRow(undefined)));
		const got = await asMaster(t).mutation(api.diary.write, {
			date: "2026-10-01",
			orchestrator: SEAT,
			content: "master v2",
		});
		expect(got).toBe(id);
		expect((await t.run((ctx) => ctx.db.get(id)))?.content).toBe("master v2");
	});
});

describe("diary:deleteDiary — R-52", () => {
	test("REFUSED: org-a member cannot delete org-b's entry (shared seat name)", async () => {
		const t = makeT();
		await seedOrgs(t);
		const id = await t.run((ctx) => ctx.db.insert("diary", diaryRow("org-b")));
		await expect(
			asOrg(t, "org-a").mutation(api.diary.deleteDiary, { diaryId: id, callerOrchestrator: SEAT }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
	});

	test("REFUSED: org-a member cannot delete a fleet (unstamped) entry", async () => {
		const t = makeT();
		await seedOrgs(t);
		const id = await t.run((ctx) => ctx.db.insert("diary", diaryRow(undefined)));
		await expect(
			asOrg(t, "org-a").mutation(api.diary.deleteDiary, { diaryId: id, callerOrchestrator: SEAT }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
	});

	test("PRESENT: org-a deletes its own entry; master deletes any", async () => {
		const t = makeT();
		await seedOrgs(t);
		const own = await t.run((ctx) => ctx.db.insert("diary", diaryRow("org-a")));
		const other = await t.run((ctx) =>
			ctx.db.insert("diary", { ...diaryRow("org-b"), date: "2026-10-02" }),
		);
		await asOrg(t, "org-a").mutation(api.diary.deleteDiary, { diaryId: own, callerOrchestrator: SEAT });
		expect(await t.run((ctx) => ctx.db.get(own))).toBeNull();
		await asMaster(t).mutation(api.diary.deleteDiary, { diaryId: other, callerOrchestrator: "system" });
		expect(await t.run((ctx) => ctx.db.get(other))).toBeNull();
	});
});

const missionRow = (orgId: string | undefined) => ({
	name: "m",
	project: "p",
	status: "execute" as const,
	priority: "medium" as const,
	pilot: SEAT,
	agents: [SEAT],
	createdBy: SEAT,
	createdAt: 1,
	updatedAt: 1,
	...(orgId !== undefined ? { orgId } : {}),
});

async function completeTaskNaming(
	t: T,
	caller: ReturnType<typeof asOrg>,
	missionId: Id<"missions">,
	by: string,
) {
	const taskId = await caller.mutation(api.tasks.create, {
		title: "Close the loop",
		assignedTo: by,
		priority: "high",
		status: "todo",
		createdBy: by,
		missionId,
	});
	await caller.mutation(api.tasks.complete, {
		taskId,
		callerOrchestrator: by,
		completionNote: NOTE,
	});
	return t.run((ctx) => ctx.db.get(taskId));
}

describe("tasks:complete mission auto-complete — R-52", () => {
	test("REFUSED: org-a task naming org-b's mission leaves that mission untouched", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await t.run((ctx) => ctx.db.insert("missions", missionRow("org-b")));
		const before = await t.run((ctx) => ctx.db.get(missionId));
		const task = await completeTaskNaming(t, asOrg(t, "org-a"), missionId, SEAT);
		expect(task?.status).toBe("done");
		expect(await t.run((ctx) => ctx.db.get(missionId))).toEqual(before);
	});

	test("REFUSED: org-a task naming a fleet mission leaves it untouched", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await t.run((ctx) => ctx.db.insert("missions", missionRow(undefined)));
		const before = await t.run((ctx) => ctx.db.get(missionId));
		await completeTaskNaming(t, asOrg(t, "org-a"), missionId, SEAT);
		expect(await t.run((ctx) => ctx.db.get(missionId))).toEqual(before);
	});

	test("PRESENT: org-a task on org-a's own mission still completes the mission", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await t.run((ctx) => ctx.db.insert("missions", missionRow("org-a")));
		await completeTaskNaming(t, asOrg(t, "org-a"), missionId, SEAT);
		expect((await t.run((ctx) => ctx.db.get(missionId)))?.status).toBe("complete");
	});

	test("PRESENT: a fleet (master) task on a fleet mission still completes the mission", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await t.run((ctx) => ctx.db.insert("missions", missionRow(undefined)));
		await completeTaskNaming(t, asMaster(t), missionId, "sigma");
		expect((await t.run((ctx) => ctx.db.get(missionId)))?.status).toBe("complete");
	});
});

describe("diary shared (seat, date) key — own-row selection, R-52 follow-up", () => {
	const key = { date: "2026-10-03", orchestrator: SEAT };
	const contentOf = async (t: T, caller: ReturnType<typeof asOrg>) =>
		(await caller.query(api.diary.get, key))?.content;

	test("PRESENT P1: org-b writes the shared key, then org-a writes it; each reads back its own", async () => {
		const t = makeT();
		await seedOrgs(t);
		const b = asOrg(t, "org-b");
		const a = asOrg(t, "org-a");
		const idB = await b.mutation(api.diary.write, { ...key, content: "from b" });
		const idA = await a.mutation(api.diary.write, { ...key, content: "from a" });
		expect(idA).not.toBe(idB);
		expect(await contentOf(t, a)).toBe("from a");
		expect(await contentOf(t, b)).toBe("from b");
		await a.mutation(api.diary.write, { ...key, content: "a v2" });
		expect(await contentOf(t, a)).toBe("a v2");
		expect(await contentOf(t, b)).toBe("from b");
	});

	test("PRESENT P2: master writes the shared key, then org-a writes it; both succeed", async () => {
		const t = makeT();
		await seedOrgs(t);
		const m = asMaster(t);
		const a = asOrg(t, "org-a");
		const idM = await m.mutation(api.diary.write, { ...key, content: "fleet" });
		const idA = await a.mutation(api.diary.write, { ...key, content: "from a" });
		expect(idA).not.toBe(idM);
		expect(await contentOf(t, a)).toBe("from a");
		expect(await contentOf(t, m)).toBe("fleet");
	});

	test("PRESENT: get on a shared key returns the caller's own row for org-a, org-b and master", async () => {
		const t = makeT();
		await seedOrgs(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("diary", { ...key, content: "fleet", createdAt: 1 });
			await ctx.db.insert("diary", { ...key, content: "from a", createdAt: 2, orgId: "org-a" });
			await ctx.db.insert("diary", { ...key, content: "from b", createdAt: 3, orgId: "org-b" });
		});
		expect(await contentOf(t, asOrg(t, "org-a"))).toBe("from a");
		expect(await contentOf(t, asOrg(t, "org-b"))).toBe("from b");
		expect(await contentOf(t, asMaster(t))).toBe("fleet");
	});

	test("REFUSED: list and listByDateRange never return a foreign tenant's row to an org caller", async () => {
		const t = makeT();
		await seedOrgs(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("diary", { ...key, content: "from a", createdAt: 2, orgId: "org-a" });
			await ctx.db.insert("diary", { ...key, content: "from b", createdAt: 3, orgId: "org-b" });
			await ctx.db.insert("diary", { ...key, content: "fleet", createdAt: 1 });
		});
		const a = asOrg(t, "org-a");
		const range = { from: "2026-10-01", to: "2026-10-31" };
		const names = (rows: unknown) =>
			(Array.isArray(rows) ? rows : []).map((r: { content: string }) => r.content);
		expect(names(await a.query(api.diary.list, { orchestrator: SEAT }))).toEqual(["from a"]);
		expect(names(await a.query(api.diary.list, {}))).toEqual(["from a"]);
		expect(names(await a.query(api.diary.listByDateRange, { ...range, orchestrator: SEAT }))).toEqual(["from a"]);
		expect(names(await a.query(api.diary.listByDateRange, range))).toEqual(["from a"]);
	});
});

// RULING 4: after backfill_org_stamp the fleet's rows carry the OPERATOR org's
// slug, while a master write still stamps nothing. Master's own tenant is
// therefore {unstamped, operator-stamped}, never the unstamped one alone.
describe("fleet equivalence after backfill_org_stamp — R-52 follow-up", () => {
	async function seedFleet(t: T) {
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "fleet-org",
				allowedOrchestrators: ["sigma"],
				scopes: [],
				displayName: "fleet-org",
				isActive: true,
				orgKind: "operator" as const,
				createdAt: 1,
			});
			await ctx.db.insert("agents", {
				orgSlug: "fleet-org",
				name: "sigma",
				normalizedName: "sigma",
				isActive: true,
				createdAt: 1,
			});
		});
	}
	const backfill = async (t: T, table: "diary" | "missions") => {
		const r = await t.mutation(internal.migrations.backfill_org_stamp.run, {
			table,
			dryRun: false,
		});
		expect(r.stamped).toBeGreaterThan(0);
	};

	test("PRESENT Q1: master get reads the operator-stamped fleet row and master write updates it in place", async () => {
		const t = makeT();
		await seedFleet(t);
		await t.run((ctx) =>
			ctx.db.insert("diary", {
				date: "2026-10-01",
				orchestrator: "sigma",
				content: "fleet v1",
				createdAt: 1,
			}),
		);
		await backfill(t, "diary");
		const row = await t.run((ctx) => ctx.db.query("diary").first());
		expect(row?.orgId).toBe("fleet-org");
		const m = asMaster(t);
		const got = await m.query(api.diary.get, { date: "2026-10-01", orchestrator: "sigma" });
		expect(got?.content).toBe("fleet v1");
		await m.mutation(api.diary.write, { date: "2026-10-01", orchestrator: "sigma", content: "fleet v2" });
		const rows = await t.run((ctx) => ctx.db.query("diary").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0].content).toBe("fleet v2");
	});

	test("PRESENT Q1b: with an unstamped and an operator-stamped candidate, master prefers the operator-stamped row and never throws", async () => {
		const t = makeT();
		await seedFleet(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("diary", { date: "2026-10-01", orchestrator: "sigma", content: "unstamped", createdAt: 1 });
			await ctx.db.insert("diary", { date: "2026-10-01", orchestrator: "sigma", content: "operator", createdAt: 2, orgId: "fleet-org" });
		});
		const got = await asMaster(t).query(api.diary.get, { date: "2026-10-01", orchestrator: "sigma" });
		expect(got?.content).toBe("operator");
	});

	test("REFUSED: an ordinary org-a member still cannot read or touch an operator-stamped fleet row", async () => {
		const t = makeT();
		await seedFleet(t);
		await seedOrgs(t);
		const id = await t.run((ctx) =>
			ctx.db.insert("diary", { date: "2026-10-01", orchestrator: SEAT, content: "fleet", createdAt: 1, orgId: "fleet-org" }),
		);
		const a = asOrg(t, "org-a");
		expect(await a.query(api.diary.get, { date: "2026-10-01", orchestrator: SEAT })).toBeNull();
		await expect(
			a.mutation(api.diary.deleteDiary, { diaryId: id, callerOrchestrator: SEAT }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
	});

	test("PRESENT Q2: a master task completes sigma's operator-stamped fleet mission", async () => {
		const t = makeT();
		await seedFleet(t);
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", { ...missionRow(undefined), createdBy: "sigma" }),
		);
		await backfill(t, "missions");
		expect((await t.run((ctx) => ctx.db.get(missionId)))?.orgId).toBe("fleet-org");
		await completeTaskNaming(t, asMaster(t), missionId, "sigma");
		expect((await t.run((ctx) => ctx.db.get(missionId)))?.status).toBe("complete");
	});

	test("REFUSED: an org-a task still cannot close an operator-stamped fleet mission", async () => {
		const t = makeT();
		await seedFleet(t);
		await seedOrgs(t);
		const missionId = await t.run((ctx) => ctx.db.insert("missions", missionRow("fleet-org")));
		await completeTaskNaming(t, asOrg(t, "org-a"), missionId, SEAT);
		expect((await t.run((ctx) => ctx.db.get(missionId)))?.status).toBe("execute");
	});
});

// RULING 4, member side: master writes stay unstamped, and those rows ARE the
// operator org's range, so a MEMBER of the operator org reads and writes them;
// any other org stays on its own stamp only.
describe("operator-org member sees the fleet range — R-52 follow-up", () => {
	const D = "2026-10-07";
	async function seedWorld(t: T) {
		await t.run(async (ctx) => {
			for (const [slug, kind] of [["fleet-org", "operator"], ["org-a", "client"]] as const) {
				await ctx.db.insert("client_org_mapping", {
					clerkOrgSlug: slug,
					allowedOrchestrators: ["sigma"],
					scopes: ["view-own-tasks"],
					displayName: slug,
					isActive: true,
					orgKind: kind,
					createdAt: 1,
				});
			}
		});
		await asMaster(t).mutation(api.diary.write, { date: D, orchestrator: "sigma", content: "fleet entry" });
	}
	const contents = (rows: unknown) =>
		(Array.isArray(rows) ? rows : []).map((r: { content: string }) => r.content);

	test("PRESENT R1: master writes, then an operator-org member's get returns the row", async () => {
		const t = makeT();
		await seedWorld(t);
		const got = await asOrg(t, "fleet-org").query(api.diary.get, { date: D, orchestrator: "sigma" });
		expect(got?.content).toBe("fleet entry");
	});

	test("PRESENT R2: an operator-org member's list {orchestrator} and listByDateRange contain it", async () => {
		const t = makeT();
		await seedWorld(t);
		const m = asOrg(t, "fleet-org");
		expect(contents(await m.query(api.diary.list, { orchestrator: "sigma" }))).toEqual(["fleet entry"]);
		expect(
			contents(await m.query(api.diary.listByDateRange, { from: D, to: D, orchestrator: "sigma" })),
		).toEqual(["fleet entry"]);
	});

	test("PRESENT R3: an operator-org member's list {} (the dashboard feed call) and range without orchestrator contain it", async () => {
		const t = makeT();
		await seedWorld(t);
		const m = asOrg(t, "fleet-org");
		expect(contents(await m.query(api.diary.list, {}))).toEqual(["fleet entry"]);
		expect(contents(await m.query(api.diary.listByDateRange, { from: D, to: D }))).toEqual(["fleet entry"]);
	});

	test("PRESENT: an operator-org member writing the key updates the fleet row, no duplicate", async () => {
		const t = makeT();
		await seedWorld(t);
		await asOrg(t, "fleet-org").mutation(api.diary.write, { date: D, orchestrator: "sigma", content: "member v2" });
		const rows = await t.run((ctx) => ctx.db.query("diary").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0].content).toBe("member v2");
	});

	test("REFUSED: a non-operator org member reads no unstamped fleet row (get, list, list {}, range)", async () => {
		const t = makeT();
		await seedWorld(t);
		const a = asOrg(t, "org-a");
		expect(await a.query(api.diary.get, { date: D, orchestrator: "sigma" })).toBeNull();
		expect(contents(await a.query(api.diary.list, { orchestrator: "sigma" }))).toEqual([]);
		expect(contents(await a.query(api.diary.list, {}))).toEqual([]);
		expect(contents(await a.query(api.diary.listByDateRange, { from: D, to: D }))).toEqual([]);
		expect(contents(await a.query(api.diary.listByDateRange, { from: D, to: D, orchestrator: "sigma" }))).toEqual([]);
	});
});

describe("fleetOperatorSlug fails closed — R-52 follow-up", () => {
	const mapping = (slug: string, orgKind: "operator" | "client") => ({
		clerkOrgSlug: slug,
		allowedOrchestrators: [],
		scopes: [],
		displayName: slug,
		isActive: true,
		orgKind,
		createdAt: 1,
	});
	test("exactly one operator org -> its slug; 2+ -> undefined; 0 -> undefined", async () => {
		const one = makeT();
		await one.run((ctx) => ctx.db.insert("client_org_mapping", mapping("op-1", "operator")));
		expect(await one.run((ctx) => fleetOperatorSlug(ctx.db))).toBe("op-1");

		const two = makeT();
		await two.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping("op-1", "operator"));
			await ctx.db.insert("client_org_mapping", mapping("op-2", "operator"));
		});
		expect(await two.run((ctx) => fleetOperatorSlug(ctx.db) ?? null)).toBeNull();

		const none = makeT();
		await none.run((ctx) => ctx.db.insert("client_org_mapping", mapping("org-a", "client")));
		expect(await none.run((ctx) => fleetOperatorSlug(ctx.db) ?? null)).toBeNull();
	});

	test("with 2 operators, no operator slug widens: only the unstamped stamp is the fleet's", () => {
		expect(isFleetStamp({ orgId: "op-1" }, undefined)).toBe(false);
		expect(isFleetStamp({}, undefined)).toBe(true);
		expect(sameTenantStamp({ orgId: "op-1" }, {}, undefined)).toBe(false);
	});

	test("with 2 active operators a master get does not read an operator-stamped row", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping("op-1", "operator"));
			await ctx.db.insert("client_org_mapping", mapping("op-2", "operator"));
			await ctx.db.insert("diary", { date: "2026-10-07", orchestrator: "sigma", content: "stamped", createdAt: 1, orgId: "op-1" });
		});
		expect(await asMaster(t).query(api.diary.get, { date: "2026-10-07", orchestrator: "sigma" })).toBeNull();
	});
});
