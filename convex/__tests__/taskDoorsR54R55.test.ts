/// <reference types="vite/client" />
/**
 * convex/__tests__/taskDoorsR54R55.test.ts
 *
 * Task k17er5a6yyccvxdh6gjcm5cand8fztkv (module M7, slice R-54 + R-55 of
 * convex/tasks.ts).
 *
 * R-54 -- a door the service account can reach acts inside a transport-verified
 * organisation; a claimless call is refused, never served as master. Five task
 * doors that no MCP tool calls: listPaginated, listUnlinkedBlocked, listOverdue,
 * taskDurationDistribution, attachReviewArtifact. Poles, per door:
 *   REFUSED   the service account with no claim -> RBAC_DENIED
 *             `claimless-service-account`, naming the door
 *   SCOPED    the service account with `verifiedOrg` -> that org's rows ONLY
 *   MEMBER    an ordinary member of an org -> served, unchanged
 *   FLEET     the service account with an operator-org `verifiedActor` -> served
 *
 * R-55 -- a read narrows by every caller predicate BEFORE it bounds the result.
 * Each pole builds a window the caller's own rows sit OUTSIDE of when the
 * bound is cut first: rows the caller may not see (outside the roster, or of
 * another tenant) are newer / earlier than the caller's own, and the page asked
 * for is no larger than the number of the caller's rows. Cut first, the page
 * comes back short or empty; narrowed first, it comes back full.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedAgents } from "../../tests/lib/agentIdOf";
import {
	actingWith,
	insertTaskRow,
	mintAgentSecret,
	seedFleetAgents,
} from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { fleetActorClaim } from "../../tests/lib/withFleetClaim";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const SERVICE_ACCOUNT = "test-service-account-user-id";
const asService = (t: T) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT } as Parameters<T["withIdentity"]>[0]);
const asMember = (t: T, orgSlug: string, subject = `member-of-${orgSlug}`) =>
	t.withIdentity({
		subject,
		organizationId: orgSlug,
		org_id: testClerkOrgId(orgSlug),
		organizationSlug: orgSlug,
	} as Parameters<T["withIdentity"]>[0]);

async function seedOrg(t: T, slug: string, roster: string[]) {
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
	await seedAgents(t, roster.map((name) => [slug, name] as [string, string]));
}

type Row = {
	title?: string;
	assignedTo?: string;
	status?: "todo" | "in_progress" | "blocked" | "done";
	priority?: "urgent" | "high" | "medium" | "low";
	orgId?: string;
	dueDate?: number;
	completedAt?: number;
	actualMinutes?: number;
	project?: string;
	createdAt?: number;
};

async function seedRow(t: Pick<T, "run">, o: Row = {}): Promise<Id<"tasks">> {
	const now = Date.now();
	return await t.run(async (ctx) =>
		insertTaskRow(ctx, {
			title: o.title ?? "a task",
			assignedTo: o.assignedTo ?? "sigma",
			createdBy: o.assignedTo ?? "sigma",
			priority: o.priority ?? "medium",
			status: o.status ?? "todo",
			...(o.orgId === undefined
				? {}
				: { orgId: o.orgId, clerkOrgId: testClerkOrgId(o.orgId) }),
			...(o.dueDate === undefined ? {} : { dueDate: o.dueDate }),
			...(o.completedAt === undefined ? {} : { completedAt: o.completedAt }),
			...(o.actualMinutes === undefined ? {} : { actualMinutes: o.actualMinutes }),
			...(o.project === undefined ? {} : { project: o.project }),
			createdAt: o.createdAt ?? now,
			updatedAt: o.createdAt ?? now,
		}),
	);
}

const REFUSED = /RBAC_DENIED[\s\S]*claimless-service-account/;
const PAST = Date.now() - 86_400_000;
const PAGE = (numItems: number) => ({ numItems, cursor: null });

// ─────────────────────────────────────────────────────────────────────────────
// R-54
// ─────────────────────────────────────────────────────────────────────────────

describe("R-54 -- the claimless service account is refused at five task doors", () => {
	async function twoOrgs(t: T) {
		await seedOrg(t, "org-a", ["sigma"]);
		await seedOrg(t, "org-b", ["sigma"]);
	}

	test("listPaginated -- REFUSED / SCOPED / MEMBER", async () => {
		const t = createT();
		await twoOrgs(t);
		await seedRow(t, { title: "a-1", orgId: "org-a" });
		await seedRow(t, { title: "b-1", orgId: "org-b" });
		await expect(
			asService(t).query(api.tasks.listPaginated, { paginationOpts: PAGE(10) }),
		).rejects.toThrow(REFUSED);
		const scoped = await asService(t).query(api.tasks.listPaginated, {
			paginationOpts: PAGE(10),
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect(scoped.page.map((r) => r.title)).toEqual(["a-1"]);
		const member = await asMember(t, "org-a").query(api.tasks.listPaginated, {
			paginationOpts: PAGE(10),
		});
		expect(member.page.map((r) => r.title)).toEqual(["a-1"]);
	});

	test("listUnlinkedBlocked -- REFUSED / SCOPED / MEMBER", async () => {
		const t = createT();
		await twoOrgs(t);
		await seedRow(t, { title: "a-blocked", orgId: "org-a", status: "blocked" });
		await seedRow(t, { title: "b-blocked", orgId: "org-b", status: "blocked" });
		await expect(asService(t).query(api.tasks.listUnlinkedBlocked, {})).rejects.toThrow(
			REFUSED,
		);
		const scoped = await asService(t).query(api.tasks.listUnlinkedBlocked, {
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect(scoped.map((r) => r.title)).toEqual(["a-blocked"]);
		const member = await asMember(t, "org-a").query(api.tasks.listUnlinkedBlocked, {});
		expect(member.map((r) => r.title)).toEqual(["a-blocked"]);
	});

	test("listOverdue -- REFUSED / SCOPED / MEMBER", async () => {
		const t = createT();
		await twoOrgs(t);
		await seedRow(t, { title: "a-late", orgId: "org-a", dueDate: PAST });
		await seedRow(t, { title: "b-late", orgId: "org-b", dueDate: PAST });
		await expect(asService(t).query(api.tasks.listOverdue, {})).rejects.toThrow(REFUSED);
		const scoped = await asService(t).query(api.tasks.listOverdue, {
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect(scoped.map((r) => r.title)).toEqual(["a-late"]);
		const member = await asMember(t, "org-a").query(api.tasks.listOverdue, {});
		expect(member.map((r) => r.title)).toEqual(["a-late"]);
	});

	test("taskDurationDistribution -- REFUSED / SCOPED / MEMBER", async () => {
		const t = createT();
		await twoOrgs(t);
		const at = Date.now() - 1000;
		await seedRow(t, { orgId: "org-a", status: "done", completedAt: at, actualMinutes: 10 });
		await seedRow(t, { orgId: "org-b", status: "done", completedAt: at, actualMinutes: 99 });
		await expect(
			asService(t).query(api.tasks.taskDurationDistribution, {}),
		).rejects.toThrow(REFUSED);
		const scoped = await asService(t).query(api.tasks.taskDurationDistribution, {
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect(scoped.count).toBe(1);
		expect(scoped.percentiles.max).toBe(10);
		const member = await asMember(t, "org-a").query(api.tasks.taskDurationDistribution, {});
		expect(member.count).toBe(1);
		expect(member.percentiles.max).toBe(10);
	});

	test("FLEET -- an operator-org verifiedActor is served the fleet's rows", async () => {
		const t = createT();
		const ids = await seedFleetAgents(t, ["sigma"]);
		const operator = await t.run(async (ctx) => {
			const rows = await ctx.db.query("client_org_mapping").collect();
			return rows.find((m) => m.orgKind === "operator")?.clerkOrgSlug as string;
		});
		await seedRow(t, { title: "fleet-late", dueDate: PAST });
		const served = await asService(t).query(api.tasks.listOverdue, {
			verifiedActor: { agentId: ids.sigma, orgSlug: operator },
		});
		expect(served.map((r) => r.title)).toEqual(["fleet-late"]);
	});

	test("verifiedActor from a CLIENT org, no verifiedOrg -- REFUSED at listPaginated and listOverdue; the operator agent is served", async () => {
		const t = createT();
		await twoOrgs(t);
		const fleet = await seedFleetAgents(t, ["sigma"]);
		const operator = await t.run(async (ctx) => {
			const rows = await ctx.db.query("client_org_mapping").collect();
			return rows.find((m) => m.orgKind === "operator")?.clerkOrgSlug as string;
		});
		const clientAgentId = await t.run(async (ctx) => {
			const rows = await ctx.db.query("agents").collect();
			return rows.find((a) => a.orgSlug === "org-a" && a.name === "sigma")
				?._id as Id<"agents">;
		});
		await seedRow(t, { title: "a-1", orgId: "org-a", dueDate: PAST });
		await seedRow(t, { title: "b-1", orgId: "org-b", dueDate: PAST });
		await seedRow(t, { title: "fleet-1", dueDate: PAST });
		const clientActor = { agentId: clientAgentId, orgSlug: "org-a" };
		const operatorActor = { agentId: fleet.sigma, orgSlug: operator };
		const DENIED = /RBAC_DENIED/;

		let leaked: unknown;
		await expect(
			asService(t)
				.query(api.tasks.listPaginated, {
					paginationOpts: PAGE(10),
					verifiedActor: clientActor,
				})
				.then((r) => {
					leaked = r;
					return r;
				}),
		).rejects.toThrow(DENIED);
		expect(leaked).toBeUndefined();
		await expect(
			asService(t)
				.query(api.tasks.listOverdue, { verifiedActor: clientActor })
				.then((r) => {
					leaked = r;
					return r;
				}),
		).rejects.toThrow(DENIED);
		expect(leaked).toBeUndefined();

		// control: the operator-org agent, same call shape, is served
		const page = await asService(t).query(api.tasks.listPaginated, {
			paginationOpts: PAGE(10),
			verifiedActor: operatorActor,
		});
		expect(page.page.map((r) => r.title).sort()).toEqual(["a-1", "b-1", "fleet-1"]);
		const overdue = await asService(t).query(api.tasks.listOverdue, {
			verifiedActor: operatorActor,
		});
		expect(overdue.map((r) => r.title).sort()).toEqual(["a-1", "b-1", "fleet-1"]);
	});

	test("attachReviewArtifact -- a verified agent attaches inside its own organisation only", async () => {
		const t = createT();
		await twoOrgs(t);
		const fleetIds = await seedFleetAgents(t, ["sigma"]);
		const operator = await t.run(async (ctx) => {
			const rows = await ctx.db.query("client_org_mapping").collect();
			return rows.find((m) => m.orgKind === "operator")?.clerkOrgSlug as string;
		});
		const fleetRow = await seedRow(t, { title: "[REVIEW] fleet" });
		const aRow = await seedRow(t, { title: "[REVIEW] a", orgId: "org-a" });
		const args = (taskId: Id<"tasks">) => ({
			taskId,
			callerOrchestrator: "sigma",
			artifactRef: "https://example.test/pr/2",
		});
		const operatorActor = { agentId: fleetIds.sigma, orgSlug: operator };
		// FLEET: the operator-org agent attaches to the fleet's own (unstamped) row ...
		await asService(t).mutation(api.tasks.attachReviewArtifact, {
			...args(fleetRow),
			verifiedActor: operatorActor,
		});
		expect((await t.run((ctx) => ctx.db.get(fleetRow)))?.reviewArtifactRef).toBe(
			"https://example.test/pr/2",
		);
		// ... and is REFUSED on a client org's row.
		await expect(
			asService(t).mutation(api.tasks.attachReviewArtifact, {
				...args(aRow),
				verifiedActor: operatorActor,
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*row-outside-actor-org/);
		expect((await t.run((ctx) => ctx.db.get(aRow)))?.reviewArtifactRef).toBeUndefined();
		// A client org's agent attaches to its OWN row, and is refused on the fleet's.
		const aActor = {
			agentId: (await t.run(async (ctx) => {
				const rows = await ctx.db.query("agents").collect();
				return rows.find((r) => r.orgSlug === "org-a")?._id;
			})) as Id<"agents">,
			orgSlug: "org-a",
		};
		await asService(t).mutation(api.tasks.attachReviewArtifact, {
			...args(aRow),
			verifiedActor: aActor,
		});
		expect((await t.run((ctx) => ctx.db.get(aRow)))?.reviewArtifactRef).toBe(
			"https://example.test/pr/2",
		);
		const fleetRow2 = await seedRow(t, { title: "[REVIEW] fleet 2" });
		await expect(
			asService(t).mutation(api.tasks.attachReviewArtifact, {
				...args(fleetRow2),
				verifiedActor: aActor,
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*row-outside-actor-org/);
	});

	test("attachReviewArtifact -- REFUSED / SCOPED (own org) / SCOPED (foreign org refused) / MEMBER", async () => {
		const t = createT();
		await twoOrgs(t);
		const a = await seedRow(t, { title: "[REVIEW] a", orgId: "org-a" });
		const b = await seedRow(t, { title: "[REVIEW] b", orgId: "org-b" });
		const args = (taskId: Id<"tasks">) => ({
			taskId,
			callerOrchestrator: "sigma",
			artifactRef: "https://example.test/pr/1",
		});
		await expect(
			asService(t).mutation(api.tasks.attachReviewArtifact, args(a)),
		).rejects.toThrow(REFUSED);
		expect((await t.run((ctx) => ctx.db.get(a)))?.reviewArtifactRef).toBeUndefined();

		await asService(t).mutation(api.tasks.attachReviewArtifact, {
			...args(a),
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect((await t.run((ctx) => ctx.db.get(a)))?.reviewArtifactRef).toBe(
			"https://example.test/pr/1",
		);
		await expect(
			asService(t).mutation(api.tasks.attachReviewArtifact, {
				...args(b),
				verifiedOrg: { orgSlug: "org-a" },
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*row-outside-verified-org/);
		expect((await t.run((ctx) => ctx.db.get(b)))?.reviewArtifactRef).toBeUndefined();

		const secret = await mintAgentSecret(t, "org-b", "sigma");
		await actingWith(asMember(t, "org-b"), secret).mutation(
			api.tasks.attachReviewArtifact,
			args(b),
		);
		expect((await t.run((ctx) => ctx.db.get(b)))?.reviewArtifactRef).toBe(
			"https://example.test/pr/1",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R-55
// ─────────────────────────────────────────────────────────────────────────────

describe("R-55 -- the caller's predicates are inside the read, before the bound", () => {
	test("tasks.list -- roster: newest rows outside the roster do not starve the page", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		for (let i = 0; i < 5; i++) {
			await seedRow(t, { title: `own-${i}`, orgId: "org-a", assignedTo: "sigma" });
		}
		for (let i = 0; i < 5; i++) {
			await seedRow(t, { title: `ghost-${i}`, orgId: "org-a", assignedTo: "ghost" });
		}
		const page = await asMember(t, "org-a").query(api.tasks.list, {
			limit: 5,
			fields: "lite",
		});
		expect(page).toHaveLength(5);
		expect(page.every((r) => r.title.startsWith("own-"))).toBe(true);
	});

	test("tasks.list -- priority: newest rows of another priority do not starve the page (member and fleet)", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		await seedFleetAgents(t, ["sigma"]);
		for (const orgId of ["org-a", undefined]) {
			for (let i = 0; i < 5; i++) {
				await seedRow(t, { title: `high-${i}`, orgId, priority: "high" });
			}
			for (let i = 0; i < 5; i++) {
				await seedRow(t, { title: `low-${i}`, orgId, priority: "low" });
			}
		}
		const args = { status: "todo", priority: "high", limit: 5, fields: "lite" } as const;
		const member = await asMember(t, "org-a").query(api.tasks.list, args);
		expect(member).toHaveLength(5);
		expect(member.every((r) => r.title.startsWith("high-"))).toBe(true);
		const fleet = await asService(t).query(api.tasks.list, args);
		expect(fleet).toHaveLength(5);
		expect(fleet.every((r) => r.priority === "high")).toBe(true);
	});

	test("tasks.listPaginated -- priority and roster narrow inside the page", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		for (let i = 0; i < 5; i++) {
			await seedRow(t, { title: `high-${i}`, orgId: "org-a", priority: "high" });
		}
		for (let i = 0; i < 5; i++) {
			await seedRow(t, { title: `low-${i}`, orgId: "org-a", priority: "low" });
		}
		const byPriority = await asMember(t, "org-a").query(api.tasks.listPaginated, {
			paginationOpts: PAGE(5),
			priority: "high",
		});
		expect(byPriority.page).toHaveLength(5);
		expect(byPriority.page.every((r) => r.priority === "high")).toBe(true);

		const t2 = createT();
		await seedOrg(t2, "org-a", ["sigma"]);
		for (let i = 0; i < 5; i++) {
			await seedRow(t2, { title: `own-${i}`, orgId: "org-a", assignedTo: "sigma" });
		}
		for (let i = 0; i < 5; i++) {
			await seedRow(t2, { title: `ghost-${i}`, orgId: "org-a", assignedTo: "ghost" });
		}
		const byRoster = await asMember(t2, "org-a").query(api.tasks.listPaginated, {
			paginationOpts: PAGE(5),
		});
		expect(byRoster.page).toHaveLength(5);
		expect(byRoster.page.every((r) => r.title.startsWith("own-"))).toBe(true);
	});

	test("tasks.listOverdue -- roster and assignee narrow before the limit", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma", "pi"]);
		// ascending creation order: the oldest rows are the ones `take(limit)` reads.
		for (let i = 0; i < 3; i++) {
			await seedRow(t, { title: `ghost-${i}`, orgId: "org-a", assignedTo: "ghost", dueDate: PAST });
		}
		for (let i = 0; i < 3; i++) {
			await seedRow(t, { title: `pi-${i}`, orgId: "org-a", assignedTo: "pi", dueDate: PAST });
		}
		for (let i = 0; i < 3; i++) {
			await seedRow(t, { title: `sigma-${i}`, orgId: "org-a", assignedTo: "sigma", dueDate: PAST });
		}
		const member = asMember(t, "org-a");
		const roster = await member.query(api.tasks.listOverdue, { limit: 3 });
		expect(roster).toHaveLength(3);
		expect(roster.every((r) => r.assignedTo !== "ghost")).toBe(true);
		const mine = await member.query(api.tasks.listOverdue, { limit: 3, assignedTo: "sigma" });
		expect(mine.map((r) => r.title).sort()).toEqual(["sigma-0", "sigma-1", "sigma-2"]);
	});

	test("tenant gate inside the read -- a row that names the slug but not the org ID, and a row of another stamp under this org's agent ID, are not served", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		const aSigma = await t.run(async (ctx) => {
			const rows = await ctx.db.query("agents").collect();
			return rows.find((r) => r.orgSlug === "org-a")?._id as Id<"agents">;
		});
		// served: stamped with the slug AND the permanent org ID
		await seedRow(t, { title: "own", orgId: "org-a", dueDate: PAST });
		// not served: the slug alone (no org ID), which `sameOrg` never matches
		await t.run(async (ctx) => {
			await ctx.db.insert("tasks", {
				title: "slug-only",
				assignedTo: "sigma",
				assignedToId: aSigma,
				createdBy: "sigma",
				priority: "medium",
				status: "todo",
				dueDate: PAST,
				orgId: "org-a",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			// not served: an unstamped (fleet) row assigned to this org's agent ID
			await ctx.db.insert("tasks", {
				title: "fleet-under-agent",
				assignedTo: "sigma",
				assignedToId: aSigma,
				createdBy: "sigma",
				priority: "medium",
				status: "todo",
				dueDate: PAST,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const member = asMember(t, "org-a");
		const overdue = await member.query(api.tasks.listOverdue, {});
		expect(overdue.map((r) => r.title)).toEqual(["own"]);
		const paged = await member.query(api.tasks.listPaginated, {
			paginationOpts: PAGE(10),
			assignedTo: "sigma",
		});
		expect(paged.page.map((r) => r.title)).toEqual(["own"]);
		const listed = await member.query(api.tasks.list, { assignedTo: "sigma", fields: "lite" });
		expect(listed.map((r) => r.title)).toEqual(["own"]);
	});

	test("tasks.billingSummaryByProject -- a tenant's own rows are not crowded out of the scan window", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		await seedOrg(t, "org-b", ["sigma"]);
		const now = Date.now();
		const CAP = 5000;
		await t.run(async (ctx) => {
			for (let i = 0; i < CAP + 1; i++) {
				await ctx.db.insert("tasks", {
					title: `foreign-${i}`,
					assignedTo: "sigma",
					createdBy: "sigma",
					priority: "low",
					status: "done",
					project: "p-foreign",
					actualMinutes: 1,
					completedAt: now - 5000 + i,
					orgId: "org-b",
					clerkOrgId: testClerkOrgId("org-b"),
					createdAt: now,
					updatedAt: now,
				});
			}
		});
		await seedRow(t, {
			orgId: "org-a",
			status: "done",
			project: "p-own",
			actualMinutes: 60,
			completedAt: now - 100,
		});
		const summary = await asMember(t, "org-a").query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
		});
		expect(summary.byProject.map((p) => [p.project, p.totalMinutes])).toEqual([["p-own", 60]]);
		expect(summary.truncated).toBe(false);
	});

	test("billingSummaryByProject and taskDurationDistribution -- a member's read keeps the period, the project and the roster", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		const now = Date.now();
		const done = { orgId: "org-a", status: "done" as const };
		await seedRow(t, { ...done, project: "p1", actualMinutes: 60, completedAt: now - 100 });
		await seedRow(t, { ...done, project: "p2", actualMinutes: 30, completedAt: now - 200 });
		// outside the period
		await seedRow(t, { ...done, project: "p1", actualMinutes: 999, completedAt: now - 5_000_000 });
		// an assignee the org's roster does not admit
		await seedRow(t, { ...done, assignedTo: "ghost", project: "p1", actualMinutes: 500, completedAt: now - 300 });
		const member = asMember(t, "org-a");
		const period = { startDate: now - 10_000, endDate: now };
		const all = await member.query(api.tasks.billingSummaryByProject, period);
		expect(all.byProject.map((p) => [p.project, p.totalMinutes])).toEqual([
			["p1", 60],
			["p2", 30],
		]);
		const one = await member.query(api.tasks.billingSummaryByProject, { ...period, project: "p2" });
		expect(one.byProject.map((p) => [p.project, p.totalMinutes])).toEqual([["p2", 30]]);
		const dist = await member.query(api.tasks.taskDurationDistribution, {
			from: period.startDate,
			to: period.endDate,
		});
		expect(dist.count).toBe(2);
		expect(dist.percentiles.max).toBe(60);
		const distOne = await member.query(api.tasks.taskDurationDistribution, {
			from: period.startDate,
			to: period.endDate,
			project: "p2",
		});
		expect(distOne.count).toBe(1);
		expect(distOne.percentiles.max).toBe(30);
	});

	test("tasks.taskDurationDistribution -- a tenant's own rows are not crowded out of the scan window", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		await seedOrg(t, "org-b", ["sigma"]);
		const now = Date.now();
		const CAP = 5000;
		await t.run(async (ctx) => {
			for (let i = 0; i < CAP + 1; i++) {
				await ctx.db.insert("tasks", {
					title: `foreign-${i}`,
					assignedTo: "sigma",
					createdBy: "sigma",
					priority: "low",
					status: "done",
					actualMinutes: 1,
					completedAt: now - 5000 + i,
					orgId: "org-b",
					clerkOrgId: testClerkOrgId("org-b"),
					createdAt: now,
					updatedAt: now,
				});
			}
		});
		await seedRow(t, {
			orgId: "org-a",
			status: "done",
			actualMinutes: 42,
			completedAt: now - 100,
		});
		const dist = await asMember(t, "org-a").query(api.tasks.taskDurationDistribution, {
			from: now - 10_000,
			to: now,
		});
		expect(dist.count).toBe(1);
		expect(dist.percentiles.max).toBe(42);
		expect(dist.truncated).toBe(false);
	});

	test("tasks.searchTasksByKeyword -- rows outside the roster do not starve the result", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		for (let i = 0; i < 3; i++) {
			await seedRow(t, { title: `deploy ghost ${i}`, orgId: "org-a", assignedTo: "ghost" });
		}
		for (let i = 0; i < 3; i++) {
			await seedRow(t, { title: `deploy own ${i}`, orgId: "org-a", assignedTo: "sigma" });
		}
		const found = await asMember(t, "org-a").query(api.tasks.searchTasksByKeyword, {
			query: "deploy",
			limit: 3,
		});
		expect(found).toHaveLength(3);
		expect(found.every((r) => r.assignedTo === "sigma")).toBe(true);
	});

	test("resume -- the paused task itself does not count against the caller's concurrent in_progress cap", async () => {
		// assertNoConcurrentInProgress excludes the target INSIDE the read: a paused
		// task is still in_progress, so without the exclusion it would be its own
		// blocker and a lone paused task could never be resumed.
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: Date.now(),
			});
		});
		const now = Date.now();
		const paused = await t.run(async (ctx) =>
			insertTaskRow(ctx, {
				title: "paused",
				assignedTo: "sigma",
				createdBy: "sigma",
				priority: "low",
				status: "in_progress",
				pausedAt: now - 1000,
				workSegments: [{ start: now - 600_000, end: now - 1000 }],
				createdAt: now,
				updatedAt: now,
			}),
		);
		await asService(t).mutation(api.tasks.resume, {
			taskId: paused,
			callerOrchestrator: "sigma",
			...(await fleetActorClaim(t, "sigma")),
		});
		expect((await t.run((ctx) => ctx.db.get(paused)))?.pausedAt).toBeUndefined();
	});
});
