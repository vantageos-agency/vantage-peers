/// <reference types="vite/client" />
/**
 * convex/__tests__/tenantBoundaryThirdSurfaceAndWrites.test.ts
 *
 * Task k175qbj053va08e11e6jy6fgy58fbndn (REVISE rework of PR #1354).
 *
 * The end criterion of the tenant-boundary delivery is "a caller of one
 * organisation sees NO row of another, and changes NO row of another". Two
 * surfaces the first delivery left open are pinned here, both DIRECTIONS at
 * each site:
 *
 *   THIRD READ SURFACE — three public readers that took no scope at all:
 *     tasks.listOverdue, tasks.listByMission, improvisationDigest.scanWindow
 *
 *   WRITE SURFACE — the task mutations compared a caller-supplied NAME and
 *     never the row's `orgId`:
 *       via assertTaskCallerAuthorized: update (incl. the dependsOn path),
 *         blockTask, complete, failTask, start, pause, resume, correctSegment
 *       with their own guards: deleteTask, checkout, attachReviewArtifact,
 *         bulkComplete
 *
 *   THE TYPED "system" WORD — `callerOrchestrator` is an ARGUMENT on the
 *     public mutations; `"system"` used to authorize on any task of any
 *     organisation for whoever typed it. A fleet-internal caller proves
 *     itself through the verified (master) scope, never by typing its name.
 *
 * LEAK pole    : an ordinary member of org-B is REFUSED on a row stamped org-A.
 * WITHHELD pole: an ordinary member of org-A still SUCCEEDS on its OWN row.
 *
 * EVERY POLE RUNS UNDER AN ORDINARY ORG MEMBER, except the poles explicitly
 * labelled "master regression". A proof run under the service account
 * exercises the bypass, not the control.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const MEMBER_A = "ordinary-member-of-org-a";
const MEMBER_B = "ordinary-member-of-org-b";
for (const subject of [MEMBER_A, MEMBER_B]) {
	if (subject === SERVICE_ACCOUNT_USER_ID) {
		throw new Error(
			`test-integrity: ${subject} must be ORDINARY, never the service account`,
		);
	}
}

const asMember = (t: T, subject: string, orgSlug: string) =>
	t.withIdentity({
		subject,
		organizationId: orgSlug,
		org_id: testClerkOrgId(orgSlug),
		organizationSlug: orgSlug,
	} as Parameters<T["withIdentity"]>[0]);

type Acting = ReturnType<typeof asMember>;

const asMaster = (t: T) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Parameters<
		T["withIdentity"]
	>[0]);

/**
 * Both orgs carry the SAME orchestrator name "sigma" in their roster — the
 * overlap the reviewer used to measure the write leak. Only the tenant stamp
 * separates them.
 */
async function seedOrg(t: T, slug: string, roster: string[] = ["sigma"]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedClosureConfig(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: Date.now(),
		});
	});
}

interface SeedOpts {
	orgId?: string;
	assignedTo?: string;
	createdBy?: string;
	title?: string;
	status?: "todo" | "in_progress" | "done";
	missionId?: Id<"missions">;
	dueDate?: number;
	completionNote?: string;
	openSegment?: boolean;
	paused?: boolean;
}

async function seedTask(t: Pick<T, "run">, o: SeedOpts = {}): Promise<Id<"tasks">> {
	const now = Date.now();
	return await t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title: o.title ?? "a task",
			assignedTo: o.assignedTo ?? "sigma",
			createdBy: o.createdBy ?? "sigma",
			priority: "low",
			status: o.status ?? "todo",
			...(o.orgId === undefined ? {} : { orgId: o.orgId, clerkOrgId: testClerkOrgId(o.orgId) }),
			...(o.missionId === undefined ? {} : { missionId: o.missionId }),
			...(o.dueDate === undefined ? {} : { dueDate: o.dueDate }),
			...(o.completionNote === undefined
				? {}
				: { completionNote: o.completionNote }),
			...(o.openSegment ? { workSegments: [{ start: now - 600_000 }] } : {}),
			...(o.paused
				? { pausedAt: now - 1000, workSegments: [{ start: now - 600_000, end: now - 1000 }] }
				: {}),
			createdAt: now,
			updatedAt: now,
		}),
	);
}

async function seedMission(t: T, orgId: string): Promise<Id<"missions">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("missions", {
			name: "a mission",
			project: "p",
			status: "execute",
			priority: "low",
			pilot: "sigma",
			agents: [],
			createdBy: "sigma",
			orgId,
			clerkOrgId: testClerkOrgId(orgId),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

const getRow = (t: Pick<T, "run">, id: Id<"tasks">) =>
	t.run((ctx) => ctx.db.get(id));

// ─────────────────────────────────────────────────────────────────────────────
// THIRD READ SURFACE
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.listOverdue — scoped by the verified organisation", () => {
	const PAST = Date.now() - 86_400_000;

	test("LEAK — a member of org-B is served NO overdue row stamped org-A", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedTask(t, { orgId: "org-a", dueDate: PAST, title: "org-a overdue" });
		const rows = await asMember(t, MEMBER_B, "org-b").query(
			api.tasks.listOverdue,
			{},
		);
		expect(rows).toEqual([]);
	});

	test("LEAK — an anonymous caller (no credential) is served nothing", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedTask(t, { orgId: "org-a", dueDate: PAST });
		const rows = await t.query(api.tasks.listOverdue, {});
		expect(rows).toEqual([]);
	});

	test("WITHHELD — a member of org-a is served its OWN overdue row", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedTask(t, { orgId: "org-a", dueDate: PAST, title: "org-a overdue" });
		const rows = await asMember(t, MEMBER_A, "org-a").query(
			api.tasks.listOverdue,
			{},
		);
		expect(rows.map((r) => r.title)).toEqual(["org-a overdue"]);
	});

	test("LEAK — a row of the caller's OWN org assigned outside its roster is not served (roster narrows, as in tasks.list)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedTask(t, {
			orgId: "org-a",
			assignedTo: "eta",
			dueDate: PAST,
			title: "own org, outside roster",
		});
		const rows = await asMember(t, MEMBER_A, "org-a").query(
			api.tasks.listOverdue,
			{},
		);
		expect(rows).toEqual([]);
	});

	test("WITHHELD — another tenant's overdue rows do not crowd the caller's own out of a limit-1 page", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		// org-b's row is written FIRST, so an unindexed scan reaches it first.
		await seedTask(t, { orgId: "org-b", dueDate: PAST, title: "org-b overdue" });
		await seedTask(t, { orgId: "org-a", dueDate: PAST, title: "org-a overdue" });
		const rows = await asMember(t, MEMBER_A, "org-a").query(
			api.tasks.listOverdue,
			{ limit: 1 },
		);
		expect(rows.map((r) => r.title)).toEqual(["org-a overdue"]);
	});

	test("master regression — the fleet service account still reads every overdue row", async () => {
		const t = createT();
		await seedTask(t, { orgId: "org-a", dueDate: PAST, title: "one" });
		await seedTask(t, { orgId: "org-b", dueDate: PAST, title: "two" });
		const rows = await asMaster(t).query(api.tasks.listOverdue, {});
		expect(rows).toHaveLength(2);
	});
});

describe("tasks.listByMission — scoped by the verified organisation", () => {
	test("LEAK — a member of org-B is served NO task of org-A's mission", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const missionId = await seedMission(t, "org-a");
		await seedTask(t, { orgId: "org-a", missionId, title: "org-a in mission" });
		const rows = await asMember(t, MEMBER_B, "org-b").query(
			api.tasks.listByMission,
			{ missionId },
		);
		expect(rows).toEqual([]);
	});

	test("LEAK — an anonymous caller is served nothing", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const missionId = await seedMission(t, "org-a");
		await seedTask(t, { orgId: "org-a", missionId });
		const rows = await t.query(api.tasks.listByMission, { missionId });
		expect(rows).toEqual([]);
	});

	test("WITHHELD — a member of org-a is served its OWN mission tasks", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const missionId = await seedMission(t, "org-a");
		await seedTask(t, { orgId: "org-a", missionId, title: "org-a in mission" });
		const rows = await asMember(t, MEMBER_A, "org-a").query(
			api.tasks.listByMission,
			{ missionId },
		);
		expect(rows.map((r) => (r as { title: string }).title)).toEqual([
			"org-a in mission",
		]);
	});

	test("master regression — the fleet service account still reads the mission", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-a");
		await seedTask(t, { orgId: "org-a", missionId });
		const rows = await asMaster(t).query(api.tasks.listByMission, {
			missionId,
		});
		expect(rows).toHaveLength(1);
	});
});

describe("improvisationDigest.scanWindow — scoped by the verified organisation", () => {
	const NOTE = "merged and deployed, sha abcdef1234567 shipped";

	async function seedDone(t: T, orgId: string, title: string) {
		return await seedTask(t, {
			orgId,
			status: "done",
			completionNote: NOTE,
			title,
		});
	}

	const totalFlagged = (r: {
		countsByCategory: { complete_task: number; send_message: number; store_memory: number };
	}) =>
		r.countsByCategory.complete_task +
		r.countsByCategory.send_message +
		r.countsByCategory.store_memory;

	test("LEAK — a member of org-B is served NO digest entry from org-A's task", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedDone(t, "org-a", "org-a done");
		const r = await asMember(t, MEMBER_B, "org-b").query(
			api.improvisationDigest.scanWindow,
			{ windowDays: 7 },
		);
		expect(r.countsByCategory.complete_task).toBe(0);
		expect(r.samples).toEqual([]);
	});

	test("LEAK — a member of org-B is served NO message stamped org-A", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await t.run(async (ctx) => {
			await ctx.db.insert("messages", {
				from: "sigma",
				tenantId: "org-a",
				tenantOrgId: testClerkOrgId("org-a"),
				channel: "c",
				content: NOTE,
				createdAt: Date.now(),
			});
		});
		const r = await asMember(t, MEMBER_B, "org-b").query(
			api.improvisationDigest.scanWindow,
			{ windowDays: 7 },
		);
		expect(r.countsByCategory.send_message).toBe(0);
	});

	test("LEAK — an ordinary org member is served NO memory (memories carry no tenant stamp)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await t.run(async (ctx) => {
			await ctx.db.insert("memories", {
				namespace: "global",
				type: "project",
				content: NOTE,
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never);
		});
		const r = await asMember(t, MEMBER_A, "org-a").query(
			api.improvisationDigest.scanWindow,
			{ windowDays: 7 },
		);
		expect(r.countsByCategory.store_memory).toBe(0);
	});

	test("LEAK — an anonymous caller is served nothing", async () => {
		const t = createT();
		await seedDone(t, "org-a", "org-a done");
		const r = await t.query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});
		expect(totalFlagged(r)).toBe(0);
	});

	test("WITHHELD — a member of org-a is served its OWN task and message", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedDone(t, "org-a", "org-a done");
		await t.run(async (ctx) => {
			await ctx.db.insert("messages", {
				from: "sigma",
				tenantId: "org-a",
				tenantOrgId: testClerkOrgId("org-a"),
				channel: "c",
				content: NOTE,
				createdAt: Date.now(),
			});
		});
		const r = await asMember(t, MEMBER_A, "org-a").query(
			api.improvisationDigest.scanWindow,
			{ windowDays: 7 },
		);
		expect(r.countsByCategory.complete_task).toBe(1);
		expect(r.countsByCategory.send_message).toBe(1);
	});

	test("LEAK — an own-org done task assigned outside the caller's roster is not digested (roster narrows)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedTask(t, {
			orgId: "org-a",
			assignedTo: "eta",
			status: "done",
			completionNote: NOTE,
			title: "own org, outside roster",
		});
		const r = await asMember(t, MEMBER_A, "org-a").query(
			api.improvisationDigest.scanWindow,
			{ windowDays: 7 },
		);
		expect(r.countsByCategory.complete_task).toBe(0);
	});

	test("master regression — the fleet service account still digests every tenant", async () => {
		const t = createT();
		await seedDone(t, "org-a", "one");
		await seedDone(t, "org-b", "two");
		const r = await asMaster(t).query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});
		expect(r.countsByCategory.complete_task).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// WRITE SURFACE — one leak + one withheld pole per mutation site
// ─────────────────────────────────────────────────────────────────────────────

interface WriteSite {
	name: string;
	seed: SeedOpts;
	call: (t: Acting, id: Id<"tasks">) => Promise<unknown>;
	/** True when the row shows the write LANDED. */
	landed: (row: NonNullable<Awaited<ReturnType<typeof getRow>>>) => boolean;
	needsClosureConfig?: boolean;
}

const C = "sigma";

const WRITE_SITES: WriteSite[] = [
	{
		name: "update",
		seed: {},
		call: (t, taskId) =>
			t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: C,
				title: "REWRITTEN",
			}),
		landed: (r) => r.title === "REWRITTEN",
	},
	{
		name: "update (add-dependency path)",
		seed: {},
		call: async (t, taskId) => {
			const dep = await seedTask(t, { orgId: "org-a", title: "dep" });
			return await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: C,
				dependsOn: [dep],
			});
		},
		landed: (r) => (r.dependsOn?.length ?? 0) > 0,
	},
	{
		name: "blockTask",
		seed: {},
		call: (t, taskId) =>
			t.mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: C,
				reason: "# blocked-on-nobody: waiting on a human decision here",
			}),
		landed: (r) => r.status === "blocked",
	},
	{
		name: "complete",
		seed: {},
		needsClosureConfig: true,
		call: (t, taskId) =>
			t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: C,
				completionNote: "Done — internal chore, no billing line needed",
			}),
		landed: (r) => r.status === "done",
	},
	{
		name: "failTask",
		seed: {},
		call: (t, taskId) =>
			t.mutation(api.tasks.failTask, {
				taskId,
				callerOrchestrator: C,
				failureNote: "the work ended in failure for a stated reason",
			}),
		landed: (r) => r.status === "failed",
	},
	{
		name: "start",
		seed: {},
		call: (t, taskId) =>
			t.mutation(api.tasks.start, { taskId, callerOrchestrator: C }),
		landed: (r) => r.status === "in_progress",
	},
	{
		name: "pause",
		seed: { status: "in_progress", openSegment: true },
		call: (t, taskId) =>
			t.mutation(api.tasks.pause, { taskId, callerOrchestrator: C }),
		landed: (r) => r.pausedAt !== undefined,
	},
	{
		name: "resume",
		seed: { paused: true },
		call: (t, taskId) =>
			t.mutation(api.tasks.resume, { taskId, callerOrchestrator: C }),
		landed: (r) => r.status === "in_progress",
	},
	{
		name: "correctSegment",
		seed: { status: "in_progress", openSegment: true },
		call: async (t, taskId) => {
			const row = await getRow(t, taskId);
			const seg = row?.workSegments?.[0];
			const start = (seg?.start ?? 0) + 1000;
			return await t.mutation(api.tasks.correctSegment, {
				taskId,
				callerOrchestrator: C,
				segmentIndex: 0,
				start,
				end: start + 60_000,
				reason: "the station session ended without a pause call",
			});
		},
		landed: (r) => r.workSegments?.[0]?.correction !== undefined,
	},
	{
		name: "checkout",
		seed: {},
		call: async (t, taskId) => {
			const res = await t.mutation(api.tasks.checkout, {
				taskId,
				callerOrchestrator: C,
				callerInstance: "inst-1",
			});
			return res;
		},
		landed: (r) => r.claimedByInstance === "inst-1",
	},
	{
		name: "attachReviewArtifact",
		seed: {},
		call: (t, taskId) =>
			t.mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: C,
				artifactRef: "https://github.com/example/repo/pull/1",
			}),
		landed: (r) => r.reviewArtifactRef !== undefined,
	},
];

describe("task write surface — the tenant compare a reader performs is the one a writer performs", () => {
	for (const site of WRITE_SITES) {
		test(`LEAK — ${site.name}: a member of org-B is REFUSED on a row stamped org-A`, async () => {
			const t = createT();
			await seedOrg(t, "org-a");
			await seedOrg(t, "org-b");
			if (site.needsClosureConfig) await seedClosureConfig(t);
			const taskId = await seedTask(t, { orgId: "org-a", ...site.seed });

			let refused = false;
			let claimedFalse = false;
			try {
				const res = await site.call(asMember(t, MEMBER_B, "org-b"), taskId);
				if (
					res !== null &&
					typeof res === "object" &&
					"claimed" in res &&
					(res as { claimed: boolean }).claimed === false
				) {
					claimedFalse = true;
				}
			} catch (e) {
				refused = /RBAC_DENIED/.test(String((e as Error).message));
			}
			const row = await getRow(t, taskId);
			expect(row).not.toBeNull();
			expect(site.landed(row as NonNullable<typeof row>)).toBe(false);
			expect(refused || claimedFalse).toBe(true);
		});

		test(`WITHHELD — ${site.name}: a member of org-a SUCCEEDS on its OWN row`, async () => {
			const t = createT();
			await seedOrg(t, "org-a");
			await seedOrg(t, "org-b");
			if (site.needsClosureConfig) await seedClosureConfig(t);
			const taskId = await seedTask(t, { orgId: "org-a", ...site.seed });

			await site.call(asMember(t, MEMBER_A, "org-a"), taskId);

			const row = await getRow(t, taskId);
			expect(row).not.toBeNull();
			expect(site.landed(row as NonNullable<typeof row>)).toBe(true);
		});
	}

	test("LEAK — deleteTask: a member of org-B does NOT delete a row stamped org-A", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const taskId = await seedTask(t, { orgId: "org-a" });
		await expect(
			asMember(t, MEMBER_B, "org-b").mutation(api.tasks.deleteTask, {
				taskId,
				callerOrchestrator: C,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await getRow(t, taskId)).not.toBeNull();
	});

	test("WITHHELD — deleteTask: a member of org-a DELETES its own row", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const taskId = await seedTask(t, { orgId: "org-a" });
		const res = await asMember(t, MEMBER_A, "org-a").mutation(
			api.tasks.deleteTask,
			{ taskId, callerOrchestrator: C },
		);
		expect(res).toEqual({ deleted: true });
		expect(await getRow(t, taskId)).toBeNull();
	});

	test("LEAK — bulkComplete: a member of org-B closes NOTHING of org-A (live and dry-run)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedClosureConfig(t);
		const taskId = await seedTask(t, { orgId: "org-a" });
		const b = asMember(t, MEMBER_B, "org-b");

		const dry = await b.mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: "sigma" },
			callerOrchestrator: C,
		});
		expect(dry.count).toBe(0);

		const live = await b.mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: "sigma" },
			dryRun: false,
			callerOrchestrator: C,
		});
		expect(live.count).toBe(0);
		expect((await getRow(t, taskId))?.status).toBe("todo");
	});

	test("WITHHELD — bulkComplete: a member of org-a closes its OWN row", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedClosureConfig(t);
		const own = await seedTask(t, { orgId: "org-a" });
		const res = await asMember(t, MEMBER_A, "org-a").mutation(
			api.tasks.bulkComplete,
			{ filter: { assignedTo: "sigma" }, dryRun: false, callerOrchestrator: C },
		);
		expect(res.count).toBe(1);
		expect((await getRow(t, own))?.status).toBe("done");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TYPED "system" WORD
// ─────────────────────────────────────────────────────────────────────────────

describe('the typed "system" word is not a credential', () => {
	// A roster that ADMITS the name "system", so the caller reaches the
	// authorisation predicate itself instead of stopping at the roster check.
	// The row is created by "eta" and assigned to "sigma": the ONLY branch
	// that can authorise a caller typing "system" is the "system" branch.
	const ROSTER = ["sigma", "system"];

	async function setup() {
		const t = createT();
		await seedOrg(t, "org-a", ROSTER);
		await seedOrg(t, "org-b", ROSTER);
		await seedClosureConfig(t);
		const taskId = await seedTask(t, {
			orgId: "org-a",
			createdBy: "eta",
			assignedTo: "sigma",
		});
		return { t, taskId };
	}

	test('LEAK (other org) — a member of org-B typing "system" is REFUSED on org-A\'s row', async () => {
		const { t, taskId } = await setup();
		await expect(
			asMember(t, MEMBER_B, "org-b").mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "system",
				title: "FORGED",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await getRow(t, taskId))?.title).toBe("a task");
	});

	test('LEAK (own org) — an ordinary member typing "system" is REFUSED on a row it neither created nor holds', async () => {
		const { t, taskId } = await setup();
		await expect(
			asMember(t, MEMBER_A, "org-a").mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "system",
				title: "FORGED",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await getRow(t, taskId))?.title).toBe("a task");
	});

	test('LEAK — every assertTaskCallerAuthorized site refuses a typed "system" from an ordinary member', async () => {
		const attempts: Array<[string, (m: Acting, id: Id<"tasks">) => Promise<unknown>]> = [
			["blockTask", (m, taskId) =>
				m.mutation(api.tasks.blockTask, {
					taskId,
					callerOrchestrator: "system",
					reason: "# blocked-on-nobody: waiting on a human decision here",
				})],
			["complete", (m, taskId) =>
				m.mutation(api.tasks.complete, {
					taskId,
					callerOrchestrator: "system",
					completionNote: "Done — internal chore, no billing line needed",
				})],
			["failTask", (m, taskId) =>
				m.mutation(api.tasks.failTask, {
					taskId,
					callerOrchestrator: "system",
					failureNote: "the work ended in failure for a stated reason",
				})],
			["start", (m, taskId) =>
				m.mutation(api.tasks.start, { taskId, callerOrchestrator: "system" })],
			["pause", (m, taskId) =>
				m.mutation(api.tasks.pause, { taskId, callerOrchestrator: "system" })],
			["resume", (m, taskId) =>
				m.mutation(api.tasks.resume, { taskId, callerOrchestrator: "system" })],
		];
		for (const [name, attempt] of attempts) {
			const { t, taskId } = await setup();
			await expect(
				attempt(asMember(t, MEMBER_A, "org-a"), taskId),
				`${name} must refuse a typed "system"`,
			).rejects.toThrow(/RBAC_DENIED/);
			const row = await getRow(t, taskId);
			expect(row?.status, `${name} must not mutate`).toBe("todo");
		}
	});

	test('LEAK — deleteTask refuses a typed "system" from an ordinary member (own org, not the creator)', async () => {
		const { t, taskId } = await setup();
		await expect(
			asMember(t, MEMBER_A, "org-a").mutation(api.tasks.deleteTask, {
				taskId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await getRow(t, taskId)).not.toBeNull();
	});

	test('LEAK — update status=cancelled refuses a typed "system" from an ordinary member', async () => {
		const { t, taskId } = await setup();
		await expect(
			asMember(t, MEMBER_A, "org-a").mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "system",
				status: "cancelled",
				cancelReason: "forged cancellation through a typed word",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await getRow(t, taskId))?.status).toBe("todo");
	});

	test('LEAK — bulkComplete: a typed "system" from an ordinary member is REFUSED and closes nothing', async () => {
		const { t, taskId } = await setup();
		const foreign = await seedTask(t, {
			orgId: "org-b",
			createdBy: "eta",
			assignedTo: "sigma",
		});
		await expect(
			asMember(t, MEMBER_A, "org-a").mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "sigma" },
				dryRun: false,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		// The typed word must not authorise a row the caller did not create or
		// hold, and the org-b row is never reached.
		expect((await getRow(t, taskId))?.status).toBe("todo");
		expect((await getRow(t, foreign))?.status).toBe("todo");
	});

	test("WITHHELD — the same ordinary member acting as its real roster name still succeeds", async () => {
		const { t, taskId } = await setup();
		await asMember(t, MEMBER_A, "org-a").mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			title: "LEGIT",
		});
		expect((await getRow(t, taskId))?.title).toBe("LEGIT");
	});

	test('master regression — the fleet service account, verified by scope, may still act as "system" on any org\'s row', async () => {
		const { t, taskId } = await setup();
		await asMaster(t).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "system",
			title: "FLEET-ACTION",
		});
		expect((await getRow(t, taskId))?.title).toBe("FLEET-ACTION");
		await asMaster(t).mutation(api.tasks.deleteTask, {
			taskId,
			callerOrchestrator: "system",
		});
		expect(await getRow(t, taskId)).toBeNull();
	});

	test("master regression — the service account bulk-closes every tenant when it types system", async () => {
		const { t, taskId } = await setup();
		const res = await asMaster(t).mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: "sigma" },
			dryRun: false,
			callerOrchestrator: "system",
		});
		expect(res.count).toBe(1);
		expect((await getRow(t, taskId))?.status).toBe("done");
	});
});
