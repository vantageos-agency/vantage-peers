/// <reference types="vite/client" />
//
// backfill_org_stamp — every unstamped row gets its real org, or the fleet
// stamp, or is REPORTED and left alone. Hermetic: no deployment is touched.

import type { FunctionReturnType } from "convex/server";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import { type StampTable, TABLE_ORDER } from "../migrations/backfill_org_stamp";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);
const run = internal.migrations.backfill_org_stamp.run;
const NOW = 1_700_000_000_000;
// The operator org's slug as SEEDED in the operator mapping row; the migration
// derives it from orgKind, the test only names what it seeded.
const FLEET_STAMP = "fleet-org";

type Totals = {
	examined: number;
	alreadyStamped: number;
	toStampOrg: number;
	toStampFleet: number;
	undecidable: number;
	stamped: number;
	pages: number;
};
type PerTable = Record<StampTable, Totals>;
const createT = () => convexTest({ schema, modules });
type T = ReturnType<typeof createT>;

const zero = (): Totals => ({
	examined: 0,
	alreadyStamped: 0,
	toStampOrg: 0,
	toStampFleet: 0,
	undecidable: 0,
	stamped: 0,
	pages: 0,
});

// Walks every table to the end the way an operator would, and refuses to spin.
async function walkAll(t: T, dryRun: boolean, pageSize?: number) {
	const out = Object.fromEntries(
		TABLE_ORDER.map((n) => [n, zero()]),
	) as PerTable;
	let table: StampTable | null = TABLE_ORDER[0];
	let cursor: string | null = null;
	let guard = 0;
	while (table !== null) {
		if (++guard > 200) throw new Error("walk did not terminate");
		const r: FunctionReturnType<typeof run> = await t.mutation(run, {
			table,
			dryRun,
			cursor,
			pageSize,
		});
		const o = out[table];
		o.examined += r.examined;
		o.alreadyStamped += r.alreadyStamped;
		o.toStampOrg += r.toStampOrg;
		o.toStampFleet += r.toStampFleet;
		o.undecidable += r.undecidable;
		o.stamped += r.stamped;
		o.pages++;
		table = r.nextTable;
		cursor = r.nextCursor;
	}
	return out;
}

async function seed(t: T) {
	return await t.run(async (ctx) => {
		const mapping = (slug: string, isActive: boolean, operator: boolean) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		await mapping("fleet-org", true, true);
		await mapping("acme-hr", true, false);
		await mapping("dormant", false, false);
		const agent = (name: string, orgSlug: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name.toLowerCase(),
				isActive: true,
				createdAt: NOW,
			});
		await agent("sigma", "fleet-org");
		await agent("nadia", "acme-hr");
		await agent("twin", "fleet-org");
		await agent("twin", "acme-hr");
		await agent("ghost", "dormant");

		const mission = (createdBy: string, orgId?: string) =>
			ctx.db.insert("missions", {
				name: `m-${createdBy}`,
				project: "p",
				status: "execute" as const,
				priority: "medium" as const,
				pilot: "x",
				agents: [],
				createdBy,
				...(orgId === undefined ? {} : { orgId }),
				createdAt: NOW,
				updatedAt: NOW,
			});
		const task = (extra: Record<string, unknown>) =>
			ctx.db.insert("tasks", {
				title: "t",
				assignedTo: "x",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "stranger",
				createdAt: NOW,
				updatedAt: NOW,
				...extra,
			});
		const message = (from: string, tenantId?: string) =>
			ctx.db.insert("messages", {
				from,
				channel: "c",
				content: "hi",
				createdAt: NOW,
				...(tenantId === undefined ? {} : { tenantId }),
			});
		const receipt = (messageId: string, tenantId?: string) =>
			ctx.db.insert("messageReceipts", {
				messageId: messageId as never,
				recipient: "pi",
				...(tenantId === undefined ? {} : { tenantId }),
			});

		const mFleet = await mission("sigma");
		const mOrg = await mission("nadia");
		const mUnknown = await mission("stranger");
		const mAmbiguous = await mission("twin");
		const mUnmapped = await mission("ghost");
		const mKept = await mission("sigma", "keep-org");

		const tOrg = await task({ missionId: mOrg });
		const tOrphanParent = await task({
			missionId: mUnknown,
			createdBy: "sigma",
		});
		const tFleetByAgent = await task({ createdBy: "sigma" });
		const tKept = await task({ missionId: mOrg, orgId: "keep-org" });
		const tInheritKept = await task({ missionId: mKept });

		const xFleet = await message("sigma");
		const xUnknown = await message("stranger");
		const xKept = await message("sigma", "keep-org");
		const rFleet = await receipt(xFleet);
		const rUnknown = await receipt(xUnknown);
		const rKept = await receipt(xFleet, "keep-org");

		const note = await ctx.db.insert("briefingNotes", {
			title: "n",
			topic: "t",
			participants: [],
			content: "c",
			createdBy: "nadia",
			createdAt: NOW,
		});
		const recurring = await ctx.db.insert("recurringTasks", {
			title: "r",
			assignedTo: "x",
			priority: "low" as const,
			cronExpression: "0 9 * * *",
			nextRunAt: NOW,
			active: true,
			createdBy: "sigma",
			createdAt: NOW,
			updatedAt: NOW,
		});
		return {
			mFleet,
			mOrg,
			mUnknown,
			mAmbiguous,
			mUnmapped,
			mKept,
			tOrg,
			tOrphanParent,
			tFleetByAgent,
			tKept,
			tInheritKept,
			xFleet,
			xUnknown,
			xKept,
			rFleet,
			rUnknown,
			rKept,
			note,
			recurring,
		};
	});
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function snapshot(t: T, s: Seeded) {
	return await t.run(async (ctx) => ({
		mFleet: (await ctx.db.get(s.mFleet))?.orgId,
		mOrg: (await ctx.db.get(s.mOrg))?.orgId,
		mUnknown: (await ctx.db.get(s.mUnknown))?.orgId,
		mAmbiguous: (await ctx.db.get(s.mAmbiguous))?.orgId,
		mUnmapped: (await ctx.db.get(s.mUnmapped))?.orgId,
		mKept: (await ctx.db.get(s.mKept))?.orgId,
		tOrg: (await ctx.db.get(s.tOrg))?.orgId,
		tOrphanParent: (await ctx.db.get(s.tOrphanParent))?.orgId,
		tFleetByAgent: (await ctx.db.get(s.tFleetByAgent))?.orgId,
		tKept: (await ctx.db.get(s.tKept))?.orgId,
		tInheritKept: (await ctx.db.get(s.tInheritKept))?.orgId,
		xFleet: (await ctx.db.get(s.xFleet))?.tenantId,
		xUnknown: (await ctx.db.get(s.xUnknown))?.tenantId,
		xKept: (await ctx.db.get(s.xKept))?.tenantId,
		rFleet: (await ctx.db.get(s.rFleet))?.tenantId,
		rUnknown: (await ctx.db.get(s.rUnknown))?.tenantId,
		rKept: (await ctx.db.get(s.rKept))?.tenantId,
		note: (await ctx.db.get(s.note))?.orgId,
		recurring: (await ctx.db.get(s.recurring))?.orgId,
	}));
}

describe("backfill_org_stamp", () => {
	test("REFUSED: zero active operator orgs refuses the run and writes nothing", async () => {
		const t = createT();
		const id = await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "acme-hr",
				clerkOrgId: testClerkOrgId("acme-hr"),
				allowedOrchestrators: [],
				scopes: [],
				displayName: "acme-hr",
				isActive: true,
				createdAt: NOW,
			});
			return await ctx.db.insert("missions", {
				name: "m",
				project: "p",
				status: "execute" as const,
				priority: "medium" as const,
				pilot: "x",
				agents: [],
				createdBy: "sigma",
				createdAt: NOW,
				updatedAt: NOW,
			});
		});
		await expect(
			t.mutation(run, { table: "missions", dryRun: false }),
		).rejects.toThrow(/exactly one active operator/);
		expect((await t.run((ctx) => ctx.db.get(id)))?.orgId).toBeUndefined();
	});

	test("REFUSED: two active operator orgs refuses the run", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (const slug of ["op-a", "op-b"]) {
				await ctx.db.insert("client_org_mapping", {
					clerkOrgSlug: slug,
					clerkOrgId: testClerkOrgId(slug),
					allowedOrchestrators: [],
					scopes: [],
					displayName: slug,
					isActive: true,
					createdAt: NOW,
					orgKind: "operator" as const,
				});
			}
		});
		await expect(
			t.mutation(run, { table: "missions", dryRun: true }),
		).rejects.toThrow(/found 2/);
	});

	test("dry run counts per table and writes nothing", async () => {
		const t = createT();
		const s = await seed(t);
		const before = await snapshot(t, s);
		const c = await walkAll(t, true);
		expect(await snapshot(t, s)).toEqual(before);
		expect(c.missions).toMatchObject({
			examined: 6,
			alreadyStamped: 1,
			toStampOrg: 1,
			toStampFleet: 1,
			undecidable: 3,
			stamped: 0,
		});
		expect(c.messages).toMatchObject({
			examined: 3,
			alreadyStamped: 1,
			toStampFleet: 1,
			undecidable: 1,
			stamped: 0,
		});
		// tOrg -> acme-hr via mission; tOrphanParent: mission undecidable;
		// tFleetByAgent: no mission, createdBy sigma; tKept/tInheritKept stamped
		// or inherit from the kept mission.
		expect(c.tasks).toMatchObject({
			examined: 5,
			alreadyStamped: 1,
			toStampOrg: 2,
			toStampFleet: 1,
			undecidable: 1,
			stamped: 0,
		});
		expect(c.messageReceipts).toMatchObject({
			examined: 3,
			alreadyStamped: 1,
			toStampFleet: 1,
			undecidable: 1,
			stamped: 0,
		});
		expect(c.briefingNotes).toMatchObject({ toStampOrg: 1, undecidable: 0 });
		expect(c.recurringTasks).toMatchObject({ toStampFleet: 1, undecidable: 0 });
	});

	test("the run stamps each row by its rule and leaves the undecidable ones alone", async () => {
		const t = createT();
		const s = await seed(t);
		await walkAll(t, false);
		const snap = await snapshot(t, s);
		expect(snap).toEqual({
			mFleet: FLEET_STAMP,
			mOrg: "acme-hr",
			mUnknown: undefined,
			mAmbiguous: undefined,
			mUnmapped: undefined,
			mKept: "keep-org",
			tOrg: "acme-hr",
			tOrphanParent: undefined,
			tFleetByAgent: FLEET_STAMP,
			tKept: "keep-org",
			tInheritKept: "keep-org",
			xFleet: FLEET_STAMP,
			xUnknown: undefined,
			xKept: "keep-org",
			rFleet: FLEET_STAMP,
			rUnknown: undefined,
			rKept: "keep-org",
			note: "acme-hr",
			recurring: FLEET_STAMP,
		});
	});

	test("a dry run predicts the real run exactly", async () => {
		const t = createT();
		await seed(t);
		const dry = await walkAll(t, true);
		const real = await walkAll(t, false);
		for (const n of TABLE_ORDER) {
			expect(real[n].stamped).toBe(dry[n].toStampOrg + dry[n].toStampFleet);
			expect(real[n].undecidable).toBe(dry[n].undecidable);
		}
	});

	test("a second run changes nothing and the dry run after shows zero to stamp", async () => {
		const t = createT();
		const s = await seed(t);
		await walkAll(t, false);
		const once = await snapshot(t, s);
		const second = await walkAll(t, false);
		expect(await snapshot(t, s)).toEqual(once);
		const after = await walkAll(t, true);
		for (const n of TABLE_ORDER) {
			expect(second[n].stamped).toBe(0);
			expect(after[n].toStampOrg + after[n].toStampFleet).toBe(0);
		}
		expect(after.missions.undecidable).toBe(3);
		expect(after.tasks.undecidable).toBe(1);
	});

	test("an existing orgId is never overwritten, even when the rule would assign another", async () => {
		const t = createT();
		const s = await seed(t);
		await walkAll(t, false);
		const snap = await snapshot(t, s);
		// created by sigma (fleet) but already stamped keep-org
		expect(snap.mKept).toBe("keep-org");
		expect(snap.xKept).toBe("keep-org");
		expect(snap.tKept).toBe("keep-org");
		expect(snap.rKept).toBe("keep-org");
	});

	test("undecidable rows are reported by id and reason", async () => {
		const t = createT();
		const s = await seed(t);
		const r = await t.mutation(run, { table: "missions", dryRun: true });
		expect(r.undecidable).toBe(3);
		expect([...r.undecidableIds].sort()).toEqual(
			[s.mUnknown, s.mAmbiguous, s.mUnmapped].sort(),
		);
		expect(r.undecidableByReason).toMatchObject({
			unknownAgent: 1,
			ambiguousAgent: 1,
			orgUnmapped: 1,
		});
	});

	test("pagination continues across batches and reaches every row", async () => {
		const t = createT();
		const s = await seed(t);
		const c = await walkAll(t, false, 2);
		expect(c.missions.pages).toBeGreaterThan(1);
		expect(c.missions.examined).toBe(6);
		expect(c.tasks.examined).toBe(5);
		const snap = await snapshot(t, s);
		expect(snap.mFleet).toBe(FLEET_STAMP);
		expect(snap.mUnmapped).toBeUndefined();
		expect(snap.recurring).toBe(FLEET_STAMP);
		expect(snap.rFleet).toBe(FLEET_STAMP);
	});
});

// k174d95s5qqy8t2r5rdrz3pr3d8fqv82 — Argus REVISE on #1475. The R-52 gate in
// tasks.complete (`taskMayReachFleetRepoRows`) must still admit a fleet task
// AFTER the backfill has stamped it with FLEET_STAMP.
describe("a stamped fleet task still reaches the fleet's issue on complete", () => {
	const NOTE =
		"Fixed the defect in commit abcdef1234567 with regression test, 3/3 pass";

	async function seedFleetIssue(t: T, taskOrgId?: string) {
		return await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: 0,
			});
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "fleet-org",
				clerkOrgId: testClerkOrgId("fleet-org"),
				allowedOrchestrators: [],
				scopes: [],
				displayName: "fleet-org",
				isActive: true,
				createdAt: NOW,
				orgKind: "operator" as const,
			});
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "acme-hr",
				clerkOrgId: testClerkOrgId("acme-hr"),
				allowedOrchestrators: [],
				scopes: [],
				displayName: "acme-hr",
				isActive: true,
				createdAt: NOW,
			});
			await ctx.db.insert("agents", {
				orgSlug: "fleet-org",
				clerkOrgId: testClerkOrgId("fleet-org"),
				name: "sigma",
				normalizedName: "sigma",
				isActive: true,
				createdAt: NOW,
			});
			await ctx.db.insert("githubRepoMapping", {
				repo: "fleet/repo",
				orchestrator: "sigma",
				project: "proj-fleet",
				active: true,
			});
			await ctx.db.insert("issues", {
				repo: "fleet/repo",
				issueNumber: 5,
				title: "fleet issue",
				body: "",
				htmlUrl: "https://example.test/fleet/5",
				labels: [],
				status: "open",
				priority: "medium",
				assignedOrchestrator: "sigma",
				project: "proj-fleet",
				githubCreatedAt: 1,
				githubUpdatedAt: 1,
			});
			return await ctx.db.insert("tasks", {
				title: "Fix flaky thing #5",
				assignedTo: "sigma",
				priority: "high" as const,
				status: "todo" as const,
				createdBy: "sigma",
				project: "proj-fleet",
				createdAt: NOW,
				updatedAt: NOW,
				...(taskOrgId === undefined ? {} : { orgId: taskOrgId }),
			});
		});
	}

	const issueStatus = (t: T) =>
		t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("issues")
						.withIndex("by_repo_number", (q) =>
							q.eq("repo", "fleet/repo").eq("issueNumber", 5),
						)
						.unique()
				)?.status,
		);

	const completeAsFleet = (
		t: T,
		taskId: Awaited<ReturnType<typeof seedFleetIssue>>,
	) =>
		t
			.withIdentity({ subject: "test-service-account-user-id" })
			.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: NOTE,
			});

	test("PRESENT (pre-backfill baseline): an unstamped fleet task fixes the issue", async () => {
		const t = createT();
		const taskId = await seedFleetIssue(t);
		await completeAsFleet(t, taskId);
		expect(await issueStatus(t)).toBe("fixed");
	});

	test("PRESENT: the same task, stamped through the migration (dryRun:false), fixes the issue", async () => {
		const t = createT();
		const taskId = await seedFleetIssue(t);
		const r = await t.mutation(run, { table: "tasks", dryRun: false });
		expect(r.stamped).toBe(1);
		const stamped = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(stamped?.orgId).toBe(FLEET_STAMP);
		await completeAsFleet(t, taskId);
		expect(await issueStatus(t)).toBe("fixed");
	});

	test("REFUSED: a client-org task is still refused the fleet's issue", async () => {
		const t = createT();
		const taskId = await seedFleetIssue(t, "acme-hr");
		await completeAsFleet(t, taskId);
		expect(await issueStatus(t)).toBe("open");
	});
});

// R-52 (task k17cncab6ymjkkwf7mbe72f9zh8fp0j2): diary and businessUnits carry
// an optional tenant stamp that their writers now require. The backfill is how
// legacy (unstamped) rows reach it, by rule A on the row's owner key.
describe("backfill_org_stamp — diary and businessUnits (R-52 stamp)", () => {
	test("stamps each row from its owner key's agent, leaves an unknown owner alone", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			const mapping = (slug: string, operator: boolean) =>
				ctx.db.insert("client_org_mapping", {
					clerkOrgSlug: slug,
					clerkOrgId: testClerkOrgId(slug),
					allowedOrchestrators: [],
					scopes: [],
					displayName: slug,
					isActive: true,
					createdAt: NOW,
					...(operator ? { orgKind: "operator" as const } : {}),
				});
			await mapping("fleet-org", true);
			await mapping("acme-hr", false);
			for (const [name, orgSlug] of [["sigma", "fleet-org"], ["nadia", "acme-hr"]]) {
				await ctx.db.insert("agents", {
					orgSlug,
					clerkOrgId: testClerkOrgId(orgSlug),
					name,
					normalizedName: name,
					isActive: true,
					createdAt: NOW,
				});
			}
			for (const orchestrator of ["nadia", "sigma", "stranger"]) {
				await ctx.db.insert("diary", {
					date: "2026-10-01",
					orchestrator,
					content: "c",
					createdAt: NOW,
				});
				await ctx.db.insert("businessUnits", {
					name: orchestrator,
					description: "d",
					purpose: "p",
					orchestratorId: orchestrator,
					status: "idea",
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
					createdAt: NOW,
					updatedAt: NOW,
				});
			}
		});
		for (const table of ["diary", "businessUnits"] as const) {
			const r = await t.mutation(run, { table, dryRun: false });
			expect(r).toMatchObject({ toStampOrg: 1, toStampFleet: 1, undecidable: 1, stamped: 2 });
		}
		const stamps = await t.run(async (ctx) => ({
			diary: (await ctx.db.query("diary").collect()).map((d) => [d.orchestrator, d.orgId ?? null]),
			bus: (await ctx.db.query("businessUnits").collect()).map((b) => [b.orchestratorId, b.orgId ?? null]),
		}));
		const expected = [["nadia", "acme-hr"], ["sigma", "fleet-org"], ["stranger", null]];
		expect(stamps.diary).toEqual(expected);
		expect(stamps.bus).toEqual(expected);
	});
});
