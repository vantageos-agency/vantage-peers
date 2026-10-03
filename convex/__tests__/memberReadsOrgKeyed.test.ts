/// <reference types="vite/client" />
/**
 * AN ORG MEMBER IS SERVED ITS OWN ORG'S ROWS THROUGH AN ORG-KEYED INDEX.
 *
 * Measured on prod (org:editor member of the fleet org):
 *   tasks:list {assignedTo:"sigma", limit:5} -> SCAN_CAP_EXCEEDED
 * Cause: convex/tasks.ts read the fleet-wide by_assignee index (no tenant
 * field), widened to TASK_LIST_SCAN_CAP+1 rows, and only then dropped foreign
 * rows via filterByOrgScope. The cap bounded the FLEET, not the member's org.
 *
 * Poles (scoped identities only, never master):
 *   own stamped rows           -> served                         [RED before]
 *   other org's rows           -> absent
 *   unstamped rows             -> absent (master-only until stamped)
 *   > cap foreign rows seeded  -> no SCAN_CAP_EXCEEDED           [RED before]
 *   missions / messages        -> same three poles (already org-keyed; pinned)
 *   fleetOrgStamp backfill     -> dry-run counts, apply stamps provable only,
 *                                 re-run idempotent, ambiguous names refused
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { TASK_LIST_SCAN_CAP } from "../tasks";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const FLEET = "fleet-org";
const OTHER = "other-org";
const FOREIGN_ROWS = TASK_LIST_SCAN_CAP + 5;

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		const base = {
			scopes: ["view-own-tasks", "view-own-missions", "view-own-messages"],
			isActive: true,
			createdAt: Date.now(),
		};
		await ctx.db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: FLEET,
			displayName: FLEET,
			orgKind: "operator",
			allowedOrchestrators: ["sigma", "eta", "shared", "ghost"],
		});
		await ctx.db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: OTHER,
			displayName: OTHER,
			orgKind: "client",
			allowedOrchestrators: ["sigma", "shared", "victor"],
		});
	});
}

const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `${org}-member`,
		org_slug: org,
		org_role: "org:editor",
	} as Identity);

type TaskSeed = {
	orgId?: string;
	assignedTo?: string;
	status?: "todo" | "in_progress" | "done";
	project?: string;
	missionId?: never;
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
					...(seed.orgId !== undefined ? { orgId: seed.orgId } : {}),
					...(seed.project !== undefined ? { project: seed.project } : {}),
				} as never);
			}
		});
	}
}

type Row = { title: string; orgId?: string };
const titles = (rows: unknown) => (rows as Row[]).map((r) => r.title).sort();

describe("tasks.list — member of org A", () => {
	test("assignedTo over > cap foreign rows -> own stamped rows, no SCAN_CAP_EXCEEDED, no foreign, no unstamped", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: OTHER }, FOREIGN_ROWS, "foreign");
		await seedTasks(t, {}, 4, "unstamped");
		await seedTasks(t, { orgId: FLEET }, 3, "own");
		const rows = await asMember(t, FLEET).query(api.tasks.list, {
			assignedTo: "sigma",
			limit: 5,
		});
		expect(titles(rows)).toEqual(["own-0", "own-1", "own-2"]);
	});

	test("multi-status, project, instance-free combos, and cursor all stay org-keyed", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: OTHER, project: "p" }, FOREIGN_ROWS, "foreign");
		await seedTasks(t, { orgId: FLEET, project: "p", status: "todo" }, 2, "todo");
		await seedTasks(t, { orgId: FLEET, project: "p", status: "in_progress" }, 2, "prog");
		await seedTasks(t, { orgId: FLEET, project: "q", status: "todo" }, 1, "otherproj");
		const m = asMember(t, FLEET);
		const multi = await m.query(api.tasks.list, {
			assignedTo: "sigma",
			status: ["todo", "in_progress"],
			limit: 50,
		});
		expect(multi).toHaveLength(5);
		const proj = await m.query(api.tasks.list, {
			assignedTo: "sigma",
			project: "p",
			limit: 50,
		});
		expect(titles(proj)).toEqual(["prog-0", "prog-1", "todo-0", "todo-1"]);
		const projOnly = await m.query(api.tasks.list, { project: "p", limit: 50 });
		expect(projOnly).toHaveLength(4);
		const cursorAnchor = (proj as Array<{ _creationTime: number }>)
			.map((r) => r._creationTime)
			.sort((a, b) => b - a)[1];
		const older = await m.query(api.tasks.list, {
			assignedTo: "sigma",
			project: "p",
			createdBefore: cursorAnchor,
			limit: 50,
		});
		expect(older).toHaveLength(2);
		// the page is the true newest `limit` of the status UNION
		const newest2 = await m.query(api.tasks.list, {
			assignedTo: "sigma",
			project: "p",
			limit: 2,
		});
		expect(newest2).toHaveLength(2);
	});

	test("the other org's member sees only the other org's rows (cross-org pole)", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: FLEET }, 3, "fleet");
		await seedTasks(t, { orgId: OTHER }, 2, "other");
		const rows = await asMember(t, OTHER).query(api.tasks.list, {
			assignedTo: "sigma",
			limit: 50,
		});
		expect(titles(rows)).toEqual(["other-0", "other-1"]);
	});

	test("createdBy widening is bounded by the member's own org, not the fleet's", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, { orgId: OTHER }, FOREIGN_ROWS, "foreign");
		await seedTasks(t, { orgId: FLEET }, 2, "own");
		const rows = await asMember(t, FLEET).query(api.tasks.list, {
			createdBy: "sigma",
			limit: 50,
		});
		expect(titles(rows)).toEqual(["own-0", "own-1"]);
	});
});

describe("tasks.list — member cursor walk (Eta #1430 mutant C1)", () => {
	// Own rows interleaved across two status buckets (each holding MORE than
	// `limit` rows, else take(limit) swallows the bucket whole and hides the
	// defect) and with foreign rows, so a bucket that loses its `.lt("_creationTime", before)` bound returns
	// rows at/after the cursor, which the post-merge cursor filter then drops:
	// page 2 comes back short or empty while older rows exist.
	test.each([
		["by_orgId_assignee_status", { assignedTo: "sigma" }],
		["by_orgId_status", {}],
		["by_orgId_project_status", { project: "p" }],
		["by_orgId_assignee_project_status", { assignedTo: "sigma", project: "p" }],
		["by_orgId_instance_status", { assignedToInstance: "i1" }],
		["by_orgId_instance_project_status", { assignedToInstance: "i1", project: "p" }],
	] as const)("a member walks 3x limit own rows across status buckets by createdBefore (%s): every row once, in order", async (_index, filter) => {
		const LIMIT = 4;
		const OWN = 3 * LIMIT;
		const t = createT();
		await seedOrgs(t);
		const statuses = ["todo", "in_progress"] as const;
		await t.run(async (ctx) => {
			for (let i = 0; i < OWN; i++) {
				const base = {
					assignedTo: "sigma",
					assignedToInstance: "i1",
					project: "p",
					priority: "medium",
					createdBy: "sigma",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				await ctx.db.insert("tasks", {
					...base,
					title: `own-${i}`,
					status: statuses[i % 2],
					orgId: FLEET,
				} as never);
				await ctx.db.insert("tasks", {
					...base,
					title: `foreign-${i}`,
					status: statuses[i % 2],
					orgId: OTHER,
				} as never);
			}
		});
		const m = asMember(t, FLEET);
		const seen: string[] = [];
		let cursor: number | undefined;
		for (let page = 0; page < 6; page++) {
			const rows = (await m.query(api.tasks.list, {
				...filter,
				status: [...statuses],
				limit: LIMIT,
				...(cursor !== undefined ? { createdBefore: cursor } : {}),
			})) as Array<{ title: string; _creationTime: number }>;
			if (rows.length === 0) break;
			seen.push(...rows.map((r) => r.title));
			cursor = rows[rows.length - 1]._creationTime;
		}
		// newest first == reverse insertion order
		expect(seen).toEqual(
			Array.from({ length: OWN }, (_, i) => `own-${OWN - 1 - i}`),
		);
	});
});

describe("missions.list / messages.listByChannel — member poles (already org-keyed, pinned)", () => {
	test("missions: own stamped only", async () => {
		const t = createT();
		await seedOrgs(t);
		await t.run(async (ctx) => {
			const base = {
				description: "d",
				status: "execute" as const,
				priority: "medium" as const,
				pilot: "sigma",
				project: "p",
				agents: [],
				createdBy: "sigma",
				createdAt: 1,
				updatedAt: 1,
			};
			await ctx.db.insert("missions", { ...base, name: "own", orgId: FLEET } as never);
			await ctx.db.insert("missions", { ...base, name: "foreign", orgId: OTHER } as never);
			await ctx.db.insert("missions", { ...base, name: "unstamped" } as never);
		});
		const rows = (await asMember(t, FLEET).query(api.missions.list, {})) as Array<{
			name: string;
		}>;
		expect(rows.map((r) => r.name)).toEqual(["own"]);
	});

	test("messages: own tenant only", async () => {
		const t = createT();
		await seedOrgs(t);
		await t.run(async (ctx) => {
			const base = { from: "sigma", channel: "broadcast", createdAt: 1 };
			await ctx.db.insert("messages", { ...base, content: "own", tenantId: FLEET } as never);
			await ctx.db.insert("messages", { ...base, content: "foreign", tenantId: OTHER } as never);
			await ctx.db.insert("messages", { ...base, content: "unstamped" } as never);
		});
		const rows = (await asMember(t, FLEET).query(api.messages.listByChannel, {
			channel: "broadcast",
		})) as Array<{ content: string }>;
		expect(rows.map((r) => r.content)).toEqual(["own"]);
	});
});

describe("migrations/fleetOrgStamp:run — a name is a label, never an identity", () => {
	// Agent rows decide identity, NOT the roster:
	//   eta    -> one agent, in FLEET            => stamp
	//   sigma  -> agents in FLEET and OTHER      => ambiguous
	//   ghost  -> on the FLEET roster, NO agent  => unknown
	//   victor -> one agent, in OTHER            => otherOrg
	//   nobody -> no agent anywhere              => unknown
	async function seedMixed(t: T) {
		await seedOrgs(t);
		await t.run(async (ctx) => {
			const agent = (orgSlug: string, name: string) =>
				ctx.db.insert("agents", {
					orgSlug,
					name,
					normalizedName: name.toLowerCase(),
					isActive: true,
					createdAt: 1,
				});
			await agent(FLEET, "eta");
			await agent(FLEET, "sigma");
			await agent(OTHER, "sigma");
			await agent(OTHER, "victor");
			const task = (title: string, assignedTo: string, extra: object = {}) =>
				ctx.db.insert("tasks", {
					title,
					assignedTo,
					priority: "medium",
					status: "todo",
					createdBy: "x",
					createdAt: 1,
					updatedAt: 1,
					...extra,
				} as never);
			await task("stamp-eta", "eta");
			await task("ambiguous-sigma", "sigma");
			await task("unknown-ghost", "ghost");
			await task("otherorg-victor", "victor");
			await task("unknown-nobody", "nobody");
			await task("already", "eta", { orgId: OTHER });
			const mission = (name: string, extra: object = {}) =>
				ctx.db.insert("missions", {
					name,
					description: "d",
					status: "execute",
					priority: "medium",
					pilot: "eta",
					project: "p",
					agents: [],
					createdBy: "eta",
					createdAt: 1,
					updatedAt: 1,
					...extra,
				} as never);
			const m = await mission("m-other", { orgId: OTHER });
			await task("parent-other-org", "eta", { missionId: m });
			await mission("m-eta");
			await ctx.db.insert("messages", {
				from: "eta",
				channel: "broadcast",
				content: "hi",
				createdAt: 1,
			} as never);
		});
	}
	const orgIds = (t: T) =>
		t.run(async (ctx) => {
			const rows = await ctx.db.query("tasks").collect();
			return Object.fromEntries(rows.map((r) => [r.title, r.orgId ?? null]));
		});
	const titleOf = (t: T, ids: string[]) =>
		t.run(async (ctx) => {
			const out: string[] = [];
			for (const id of ids) {
				const row = await ctx.db.get(id as never);
				out.push((row as { title: string }).title);
			}
			return out.sort();
		});

	test("dry run: counts, lists each unstamped id by bucket, writes nothing", async () => {
		const t = createT();
		await seedMixed(t);
		const before = await orgIds(t);
		const r = await t.mutation(internal.migrations.fleetOrgStamp.run, {
			table: "tasks",
		});
		expect(r).toMatchObject({
			apply: false,
			examined: 6,
			stampable: 1,
			stamped: 0,
			ambiguous: 1,
			unknown: 2,
			otherOrg: 1,
			parentOtherOrg: 1,
			isDone: true,
		});
		expect(await titleOf(t, r.unstampedIds.ambiguous)).toEqual(["ambiguous-sigma"]);
		expect(await titleOf(t, r.unstampedIds.unknown)).toEqual([
			"unknown-ghost",
			"unknown-nobody",
		]);
		expect(await titleOf(t, r.unstampedIds.otherOrg)).toEqual(["otherorg-victor"]);
		expect(await titleOf(t, r.unstampedIds.parentOtherOrg)).toEqual(["parent-other-org"]);
		expect(await orgIds(t)).toEqual(before);
	});

	test("apply stamps only the single-agent operator-org name; re-run is idempotent", async () => {
		const t = createT();
		await seedMixed(t);
		const r = await t.mutation(internal.migrations.fleetOrgStamp.run, {
			table: "tasks",
			apply: true,
		});
		expect(r.stamped).toBe(1);
		const after = await orgIds(t);
		expect(after).toEqual({
			"stamp-eta": FLEET,
			"ambiguous-sigma": null,
			"unknown-ghost": null,
			"otherorg-victor": null,
			"unknown-nobody": null,
			already: OTHER,
			"parent-other-org": null,
		});
		const again = await t.mutation(internal.migrations.fleetOrgStamp.run, {
			table: "tasks",
			apply: true,
		});
		expect(again).toMatchObject({ examined: 5, stamped: 0, stampable: 0 });
		expect(await orgIds(t)).toEqual(after);
	});

	test("cursor paging walks every unstamped row across pages", async () => {
		const t = createT();
		await seedMixed(t);
		let cursor: string | null = null;
		let examined = 0;
		let stamped = 0;
		for (let i = 0; i < 10; i++) {
			const r: {
				examined: number;
				stamped: number;
				isDone: boolean;
				nextCursor: string | null;
			} = await t.mutation(internal.migrations.fleetOrgStamp.run, {
				table: "tasks",
				apply: true,
				pageSize: 2,
				cursor,
			});
			examined += r.examined;
			stamped += r.stamped;
			if (r.isDone) break;
			cursor = r.nextCursor;
		}
		expect(examined).toBe(6);
		expect(stamped).toBe(1);
	});

	test("missions and messages stamp by the same rule; then the member is served them", async () => {
		const t = createT();
		await seedMixed(t);
		for (const table of ["missions", "messages"] as const) {
			await t.mutation(internal.migrations.fleetOrgStamp.run, {
				table,
				apply: true,
			});
		}
		const missions = (await asMember(t, FLEET).query(api.missions.list, {})) as Array<{
			name: string;
		}>;
		expect(missions.map((m) => m.name)).toEqual(["m-eta"]);
		const msgs = (await asMember(t, FLEET).query(api.messages.listByChannel, {
			channel: "broadcast",
		})) as Array<{ content: string }>;
		expect(msgs.map((m) => m.content)).toEqual(["hi"]);
	});

	test("refuses an out-of-range page size and a non-operator org", async () => {
		const t = createT();
		await seedOrgs(t);
		await expect(
			t.mutation(internal.migrations.fleetOrgStamp.run, { table: "tasks", pageSize: 0 }),
		).rejects.toThrow(/out of expected range/);
		await expect(
			t.mutation(internal.migrations.fleetOrgStamp.run, { table: "tasks", orgSlug: OTHER }),
		).rejects.toThrow(/not an active orgKind="operator"/);
	});
});
