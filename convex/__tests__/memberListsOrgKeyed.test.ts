/// <reference types="vite/client" />
/**
 * THE OTHER MEMBER READS SERVE AN ORG MEMBER THROUGH ORG-KEYED INDEXES.
 *
 * Same defect class as #1430 (tasks.list): a read that serves a non-master
 * member through a FLEET-WIDE index and only then drops foreign rows
 * (filterByOrgScope) pages / caps the FLEET, not the member's org.
 *
 * Reads covered (dashboard call sites, vantage-peers-dashboard @34f6d22):
 *   tasks.listPaginated        components/tasks/task-board.tsx:77
 *   tasks.listByMission        (no dashboard call site; MCP list_tasks by mission)
 *   stats.orchestratorStats    app/[locale]/dashboard/stats/page.tsx:43
 *   dashboard.getDashboardSummary  app/[locale]/dashboard/page.tsx:366
 *   dashboard.getProjectSummary    components/projects/projects-overview.tsx:17
 *
 * Poles, scoped member identities only (never master):
 *   own stamped rows served | other org absent | unstamped absent |
 *   foreign rows beyond the fleet-wide window do not truncate the member.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";
import { TASK_LIST_SCAN_CAP } from "../tasks";

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
type Identity = Parameters<T["withIdentity"]>[0];

const FLEET = "fleet-org";
const OTHER = "other-org";

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		const base = {
			scopes: [
				"view-own-tasks",
				"view-own-missions",
				"view-stats-aggregated",
			],
			isActive: true,
			createdAt: Date.now(),
			allowedOrchestrators: ["sigma"],
		};
		await ctx.db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: FLEET,
			clerkOrgId: testClerkOrgId(FLEET),
			displayName: FLEET,
			orgKind: "operator",
		});
		await ctx.db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: OTHER,
			clerkOrgId: testClerkOrgId(OTHER),
			displayName: OTHER,
			orgKind: "client",
		});
	});
}

const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `${org}-member`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:editor",
	} as Identity);

type TaskSeed = {
	orgId?: string;
	status?: "todo" | "in_progress" | "done" | "blocked" | "review";
	project?: string;
	missionId?: string;
	assignedTo?: string;
};
async function seedTasks(t: T, seed: TaskSeed, count: number, tag: string) {
	const CHUNK = 500;
	for (let from = 0; from < count; from += CHUNK) {
		await t.run(async (ctx) => {
			for (let i = from; i < Math.min(from + CHUNK, count); i++) {
				await ctx.db.insert("tasks", {
					title: `${tag}-${i}`,
					assignedTo: seed.assignedTo ?? "sigma",
					priority: "medium",
					status: seed.status ?? "todo",
					createdBy: "sigma",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					...(seed.orgId !== undefined ? { orgId: seed.orgId, clerkOrgId: testClerkOrgId(seed.orgId) } : {}),
					...(seed.project !== undefined ? { project: seed.project } : {}),
					...(seed.missionId !== undefined ? { missionId: seed.missionId } : {}),
				} as never);
			}
		});
	}
}

async function seedMission(t: T, name: string, orgId?: string, project = "p") {
	return await t.run(async (ctx) =>
		ctx.db.insert("missions", {
			name,
			description: "d",
			status: "execute",
			priority: "medium",
			pilot: "sigma",
			project,
			agents: [],
			createdBy: "sigma",
			createdAt: 1,
			updatedAt: 1,
			...(orgId !== undefined ? { orgId, clerkOrgId: testClerkOrgId(orgId) } : {}),
		} as never),
	);
}

type Row = { title: string; orgId?: string; _creationTime: number };
const titles = (rows: unknown) => (rows as Row[]).map((r) => r.title).sort();

// ─────────────────────────────────────────────────────────────────────────────
// tasks.listPaginated
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.listPaginated — member of org A", () => {
	type Page = { page: Row[]; isDone: boolean; continueCursor: string };
	async function walk(
		m: ReturnType<typeof asMember>,
		filter: Record<string, unknown>,
		numItems: number,
	) {
		const pages: Page[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 40; i++) {
			const res = (await m.query(api.tasks.listPaginated, {
				paginationOpts: { numItems, cursor },
				...filter,
			})) as Page;
			pages.push(res);
			if (res.isDone) break;
			cursor = res.continueCursor;
		}
		return pages;
	}

	test.each([
		["no filter (by_orgId)", {}],
		["status (by_orgId_status)", { status: "todo" }],
		["assignedTo (by_orgId_assignee_status)", { assignedTo: "sigma" }],
		[
			"assignedTo+status (by_orgId_assignee_status)",
			{ assignedTo: "sigma", status: "todo" },
		],
	] as const)(
		"%s: walk all pages -> every own row once; no foreign, no unstamped, no short non-final page",
		async (_name, filter) => {
			const t = createT();
			await seedOrgs(t);
			// own rows OLDEST, then unstamped, then a wall of foreign rows newest:
			// a fleet-wide page of 5 holds only foreign rows.
			await seedTasks(t, { orgId: FLEET }, 7, "own");
			await seedTasks(t, {}, 5, "unstamped");
			await seedTasks(t, { orgId: OTHER }, 60, "foreign");
			const pages = await walk(asMember(t, FLEET), filter, 5);
			const seen = pages.flatMap((p) => p.page.map((r) => r.title));
			expect([...seen].sort()).toEqual(
				Array.from({ length: 7 }, (_, i) => `own-${i}`).sort(),
			);
			expect(new Set(seen).size).toBe(seen.length);
			// A short page that is not the last one is a refusal that looks like
			// "load more shows nothing": the board would stall.
			for (const p of pages.slice(0, -1)) expect(p.page).toHaveLength(5);
			expect(pages.length).toBeLessThanOrEqual(3);
		},
	);

	test("assignedTo only, own rows in two status buckets: every own row exactly once", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET, status: "todo" }, 4, "own-todo");
		await seedTasks(t, { orgId: FLEET, status: "in_progress" }, 4, "own-prog");
		await seedTasks(t, { orgId: OTHER, status: "todo" }, 30, "foreign");
		const pages = await walk(asMember(t, FLEET), { assignedTo: "sigma" }, 3);
		const seen = pages.flatMap((p) => p.page.map((r) => r.title));
		expect(seen).toHaveLength(8);
		expect(new Set(seen).size).toBe(8);
		expect(seen.every((s) => s.startsWith("own-"))).toBe(true);
	});

	test("cross-org pole: the other org's member sees only its own rows", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET }, 6, "fleet");
		await seedTasks(t, { orgId: OTHER }, 3, "other");
		const pages = await walk(asMember(t, OTHER), {}, 5);
		expect(titles(pages.flatMap((p) => p.page))).toEqual([
			"other-0",
			"other-1",
			"other-2",
		]);
	});

	test("return shape is the paginated result usePaginatedQuery expects", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET }, 2, "own");
		const res = await asMember(t, FLEET).query(api.tasks.listPaginated, {
			paginationOpts: { numItems: 5, cursor: null },
		});
		expect(Object.keys(res).sort()).toEqual(["continueCursor", "isDone", "page"]);
		expect(typeof res.continueCursor).toBe("string");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// tasks.listByMission
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.listByMission — member of org A", () => {
	test("a mission larger than the scan cap: no SCAN_CAP_EXCEEDED; own rows only (foreign-stamped + unstamped absent)", async () => {
		const t = createT();
		await seedOrgs(t);
		const mission = await seedMission(t, "big", FLEET);
		await seedTasks(
			t,
			{ orgId: FLEET, missionId: mission },
			TASK_LIST_SCAN_CAP + 5,
			"own",
		);
		await seedTasks(t, { orgId: OTHER, missionId: mission }, 3, "foreign");
		await seedTasks(t, { missionId: mission }, 3, "unstamped");
		const rows = (await asMember(t, FLEET).query(api.tasks.listByMission, {
			missionId: mission as never,
			limit: 5,
		})) as Row[];
		expect(rows).toHaveLength(5);
		expect(rows.every((r) => r.orgId === FLEET)).toBe(true);
	});

	test("cross-org pole: the other org's member is served none of org A's mission", async () => {
		const t = createT();
		await seedOrgs(t);
		const mission = await seedMission(t, "m", FLEET);
		await seedTasks(t, { orgId: FLEET, missionId: mission }, 3, "own");
		const rows = await asMember(t, OTHER).query(api.tasks.listByMission, {
			missionId: mission as never,
			limit: 50,
		});
		expect(rows).toEqual([]);
	});

	test("foreign-stamped and unstamped rows of the member's own mission are absent", async () => {
		const t = createT();
		await seedOrgs(t);
		const mission = await seedMission(t, "m", FLEET);
		await seedTasks(t, { orgId: FLEET, missionId: mission }, 2, "own");
		await seedTasks(t, { orgId: OTHER, missionId: mission }, 2, "foreign");
		await seedTasks(t, { missionId: mission }, 2, "unstamped");
		const rows = await asMember(t, FLEET).query(api.tasks.listByMission, {
			missionId: mission as never,
			limit: 50,
		});
		expect(titles(rows)).toEqual(["own-0", "own-1"]);
	});

	test("cursor walk across two status buckets (createdBefore): every row once, in order", async () => {
		const LIMIT = 4;
		const OWN = 3 * LIMIT;
		const t = createT();
		await seedOrgs(t);
		const mission = await seedMission(t, "m", FLEET);
		const statuses = ["todo", "in_progress"] as const;
		await t.run(async (ctx) => {
			for (let i = 0; i < OWN; i++) {
				const base = {
					assignedTo: "sigma",
					priority: "medium",
					createdBy: "sigma",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					missionId: mission,
				};
				await ctx.db.insert("tasks", {
					...base,
					title: `own-${i}`,
					status: statuses[i % 2],
					orgId: FLEET,
					clerkOrgId: testClerkOrgId(FLEET),
				} as never);
				await ctx.db.insert("tasks", {
					...base,
					title: `foreign-${i}`,
					status: statuses[i % 2],
					orgId: OTHER,
					clerkOrgId: testClerkOrgId(OTHER),
				} as never);
			}
		});
		const m = asMember(t, FLEET);
		const seen: string[] = [];
		let cursor: number | undefined;
		for (let page = 0; page < 6; page++) {
			const rows = (await m.query(api.tasks.listByMission, {
				missionId: mission as never,
				status: [...statuses],
				limit: LIMIT,
				...(cursor !== undefined ? { createdBefore: cursor } : {}),
			})) as Row[];
			if (rows.length === 0) break;
			seen.push(...rows.map((r) => r.title));
			cursor = rows[rows.length - 1]._creationTime;
		}
		expect(seen).toEqual(
			Array.from({ length: OWN }, (_, i) => `own-${OWN - 1 - i}`),
		);
	});

	test("no-status read of a small mission returns the newest `limit` of the status union", async () => {
		const t = createT();
		await seedOrgs(t);
		const mission = await seedMission(t, "m", FLEET);
		await seedTasks(t, { orgId: FLEET, missionId: mission, status: "todo" }, 3, "a");
		await seedTasks(t, { orgId: FLEET, missionId: mission, status: "done" }, 3, "b");
		const rows = (await asMember(t, FLEET).query(api.tasks.listByMission, {
			missionId: mission as never,
			limit: 4,
		})) as Row[];
		expect(rows.map((r) => r.title)).toEqual(["b-2", "b-1", "b-0", "a-2"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// stats.orchestratorStats
// ─────────────────────────────────────────────────────────────────────────────

describe("stats.orchestratorStats — member of org A", () => {
	test("own rows counted although > TASK_CAP older foreign rows exist; foreign + unstamped excluded", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: OTHER }, 5005, "foreign");
		await seedTasks(t, {}, 4, "unstamped");
		await seedTasks(t, { orgId: FLEET, status: "todo" }, 3, "own");
		const stats = await asMember(t, FLEET).query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stats.map((s) => s.orchestratorId)).toEqual(["sigma"]);
		expect(stats[0].queueSize).toBe(3);
	});

	test("cross-org pole: the other org's member counts only its own rows", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET, status: "todo" }, 5, "fleet");
		await seedTasks(t, { orgId: OTHER, status: "todo" }, 2, "other");
		const stats = await asMember(t, OTHER).query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stats).toHaveLength(1);
		expect(stats[0].queueSize).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// dashboard.getDashboardSummary / getProjectSummary
// ─────────────────────────────────────────────────────────────────────────────

describe("dashboard.getDashboardSummary — member of org A", () => {
	test("in-progress count and recent activity survive a fleet wall (> 500 in_progress older, > 100 newer rows)", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: OTHER, status: "in_progress" }, 505, "f-ip");
		await seedTasks(t, { orgId: FLEET, status: "in_progress" }, 2, "own-ip");
		await seedTasks(t, {}, 3, "unstamped-ip");
		await seedTasks(t, { orgId: OTHER, status: "todo" }, 105, "f-new");
		const summary = await asMember(t, FLEET).query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(summary.tasksInProgress).toBe(2);
		const own = summary.recentActivity.filter((e) => e.type === "task");
		expect(own.map((e) => e.excerpt).sort()).toEqual(["own-ip-0", "own-ip-1"]);
	});

	test("cross-org pole: the other org's member sees only its own tasks", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET, status: "in_progress" }, 4, "fleet");
		await seedTasks(t, { orgId: OTHER, status: "in_progress" }, 1, "other");
		const summary = await asMember(t, OTHER).query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(summary.tasksInProgress).toBe(1);
		expect(
			summary.recentActivity.filter((e) => e.type === "task").map((e) => e.excerpt),
		).toEqual(["other-0"]);
	});
});

describe("dashboard.getProjectSummary — member of org A", () => {
	test("own project served although > 1000 older foreign tasks and missions exist", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: OTHER, project: "fp" }, 1005, "foreign");
		await t.run(async (ctx) => {
			for (let i = 0; i < 1005; i++) {
				await ctx.db.insert("missions", {
					name: `fm-${i}`,
					description: "d",
					status: "execute",
					priority: "medium",
					pilot: "sigma",
					project: "fp",
					agents: [],
					createdBy: "sigma",
					createdAt: 1,
					updatedAt: 1,
					orgId: OTHER,
					clerkOrgId: testClerkOrgId(OTHER),
				} as never);
			}
		});
		await seedTasks(t, {}, 2, "unstamped");
		await seedTasks(t, { orgId: FLEET, project: "op", status: "done" }, 2, "own");
		await seedMission(t, "own-m", FLEET, "op");
		const res = await asMember(t, FLEET).query(
			api.dashboard.getProjectSummary,
			{},
		);
		expect(Array.isArray(res)).toBe(true);
		const rows = res as Array<{
			name: string;
			missionCount: number;
			tasksByStatus: { done: number };
		}>;
		expect(rows.map((r) => r.name)).toEqual(["op"]);
		expect(rows[0].missionCount).toBe(1);
		expect(rows[0].tasksByStatus.done).toBe(2);
	});

	test("cross-org pole: the other org's member sees only its own project", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET, project: "fp" }, 3, "fleet");
		await seedTasks(t, { orgId: OTHER, project: "op" }, 2, "other");
		const res = (await asMember(t, OTHER).query(
			api.dashboard.getProjectSummary,
			{},
		)) as Array<{ name: string }>;
		expect(res.map((r) => r.name)).toEqual(["op"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// tasks.list {} — the unfiltered member read the dashboard sends
// (critical-blockers-widget.tsx:194, unified-activity-feed.tsx:156)
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.list {} — unfiltered read of a member whose org holds more than the scan cap", () => {
	test("org with > TASK_LIST_SCAN_CAP own rows: served, newest-first, length = default limit; no SCAN_CAP_EXCEEDED", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: OTHER }, 5, "foreign");
		await seedTasks(t, {}, 3, "unstamped");
		await seedTasks(t, { orgId: FLEET }, TASK_LIST_SCAN_CAP + 5, "own");
		const m = asMember(t, FLEET);
		const full = (await m.query(api.tasks.list, {})) as Row[];
		expect(full).toHaveLength(30); // fields=full, no explicit limit -> clamp 30
		expect(full.every((r) => r.orgId === FLEET)).toBe(true);
		expect(full[0].title).toBe(`own-${TASK_LIST_SCAN_CAP + 4}`);
		const lite = (await m.query(api.tasks.list, {
			fields: "lite",
			limit: 7,
		})) as Row[];
		expect(lite).toHaveLength(7);
	});

	test("roster pole: an own-org row of an orchestrator NOT on the roster stays excluded", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET, assignedTo: "sigma" }, 2, "own");
		await seedTasks(t, { orgId: FLEET, assignedTo: "eta" }, 2, "offroster");
		const rows = await asMember(t, FLEET).query(api.tasks.list, { limit: 50 });
		expect(titles(rows)).toEqual(["own-0", "own-1"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Roster pole per member path: filterByOrgScope's SECOND layer.
// Member FLEET roster = ["sigma"]; a row stamped FLEET whose orchestrator is
// "eta" is the member's own org's row but not the member's to see.
// ─────────────────────────────────────────────────────────────────────────────

describe("roster narrowing stays pinned on every member path (own org, orchestrator off the roster)", () => {
	test("tasks.listPaginated", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET, assignedTo: "sigma" }, 2, "own");
		await seedTasks(t, { orgId: FLEET, assignedTo: "eta" }, 2, "offroster");
		const res = (await asMember(t, FLEET).query(api.tasks.listPaginated, {
			paginationOpts: { numItems: 10, cursor: null },
		})) as { page: Row[] };
		expect(titles(res.page)).toEqual(["own-0", "own-1"]);
	});

	test("tasks.listByMission", async () => {
		const t = createT();
		await seedOrgs(t);
		const mission = await seedMission(t, "m", FLEET);
		await seedTasks(t, { orgId: FLEET, missionId: mission, assignedTo: "sigma" }, 2, "own");
		await seedTasks(t, { orgId: FLEET, missionId: mission, assignedTo: "eta" }, 2, "offroster");
		const rows = await asMember(t, FLEET).query(api.tasks.listByMission, {
			missionId: mission as never,
			limit: 50,
		});
		expect(titles(rows)).toEqual(["own-0", "own-1"]);
	});

	test("stats.orchestratorStats", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET, assignedTo: "sigma" }, 2, "own");
		await seedTasks(t, { orgId: FLEET, assignedTo: "eta" }, 2, "offroster");
		const stats = await asMember(t, FLEET).query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stats.map((s) => s.orchestratorId)).toEqual(["sigma"]);
	});

	test("dashboard.getDashboardSummary", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET, assignedTo: "sigma", status: "in_progress" }, 2, "own");
		await seedTasks(t, { orgId: FLEET, assignedTo: "eta", status: "in_progress" }, 2, "offroster");
		const summary = await asMember(t, FLEET).query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(summary.tasksInProgress).toBe(2);
		expect(
			summary.recentActivity
				.filter((e) => e.type === "task")
				.map((e) => e.excerpt)
				.sort(),
		).toEqual(["own-0", "own-1"]);
	});

	test("dashboard.getProjectSummary", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET, assignedTo: "sigma", project: "mine" }, 1, "own");
		await seedTasks(t, { orgId: FLEET, assignedTo: "eta", project: "offroster" }, 1, "off");
		await t.run(async (ctx) => {
			await ctx.db.insert("missions", {
				name: "eta-mission",
				description: "d",
				status: "execute",
				priority: "medium",
				pilot: "eta",
				project: "offroster-m",
				agents: [],
				createdBy: "eta",
				createdAt: 1,
				updatedAt: 1,
				orgId: FLEET,
				clerkOrgId: testClerkOrgId(FLEET),
			} as never);
		});
		const res = (await asMember(t, FLEET).query(
			api.dashboard.getProjectSummary,
			{},
		)) as Array<{ name: string }>;
		expect(res.map((r) => r.name)).toEqual(["mine"]);
	});
});
