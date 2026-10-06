/// <reference types="vite/client" />
//
// RULING 4 (task k174d95s5qqy8t2r5rdrz3pr3d8fqv82): once backfill_org_stamp has
// stamped fleet rows with the OPERATOR org's slug, the fleet OKF bundle must
// still export them, and a re-import must dedupe instead of duplicating.
// The operator slug is seeded as an orgKind "operator" mapping row; the code
// derives it, the test never passes it to the code.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { PHASE1_NAMESPACE } from "../okfBundle";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);
const createT = () => convexTest({ schema, modules });
type T = ReturnType<typeof createT>;
const NOW = 1_700_000_000_000;
const OP = "operator-org";
const PAGE = { numItems: 1, cursor: null as string | null };

async function seed(t: T) {
	return await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: OP,
			allowedOrchestrators: [],
			scopes: [],
			displayName: OP,
			isActive: true,
			createdAt: NOW,
			orgKind: "operator" as const,
		});
		await ctx.db.insert("agents", {
			orgSlug: OP,
			name: "sigma",
			normalizedName: "sigma",
			isActive: true,
			createdAt: NOW,
		});
		const note = (title: string, extra: Record<string, unknown> = {}) =>
			ctx.db.insert("briefingNotes", {
				title,
				topic: "t",
				participants: [],
				content: `body ${title}`,
				createdBy: "sigma",
				createdAt: NOW,
				...extra,
			});
		const task = (title: string, extra: Record<string, unknown> = {}) =>
			ctx.db.insert("tasks", {
				title,
				description: `desc ${title}`,
				assignedTo: "sigma",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "sigma",
				createdAt: NOW,
				updatedAt: NOW,
				...extra,
			});
		return {
			noteStamped: await note("stamped-note"),
			noteUnstamped: await note("unstamped-note", { createdBy: "stranger" }),
			noteClient: await note("client-note", { orgId: "acme-hr" }),
			taskStamped: await task("stamped-task"),
			taskUnstamped: await task("unstamped-task", { createdBy: "stranger" }),
			taskClient: await task("client-task", { orgId: "acme-hr" }),
		};
	});
}

async function stampThroughMigration(t: T) {
	for (const table of ["briefingNotes", "tasks"] as const) {
		await t.mutation(internal.migrations.backfill_org_stamp.run, {
			table,
			dryRun: false,
		});
	}
}

async function drain(
	t: T,
	fn: "_fetchBriefingNotesForBundle" | "_fetchTasksForBundle",
) {
	const titles: string[] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 20; i++) {
		const r: {
			page: { title: string }[];
			isDone: boolean;
			continueCursor: string;
		} = await t.query(internal.okfBundle[fn], {
			namespace: PHASE1_NAMESPACE,
			paginationOpts: { ...PAGE, cursor },
		});
		titles.push(...r.page.map((p) => p.title));
		if (r.isDone) return titles.sort();
		cursor = r.continueCursor;
	}
	throw new Error("export did not terminate");
}

describe("fleet OKF bundle after the operator-slug stamp", () => {
	test("the migration really stamped the fleet rows with the operator slug", async () => {
		const t = createT();
		const s = await seed(t);
		await stampThroughMigration(t);
		const n = await t.run((ctx) => ctx.db.get(s.noteStamped));
		const k = await t.run((ctx) => ctx.db.get(s.taskStamped));
		expect(n?.orgId).toBe(OP);
		expect(k?.orgId).toBe(OP);
	});

	test("PRESENT: export returns operator-stamped AND unstamped rows, never a client org's", async () => {
		const t = createT();
		await seed(t);
		await stampThroughMigration(t);
		expect(await drain(t, "_fetchBriefingNotesForBundle")).toEqual([
			"stamped-note",
			"unstamped-note",
		]);
		expect(await drain(t, "_fetchTasksForBundle")).toEqual([
			"stamped-task",
			"unstamped-task",
		]);
	});

	test("a re-import dedupes an operator-stamped row instead of duplicating it", async () => {
		const t = createT();
		const s = await seed(t);
		await stampThroughMigration(t);
		const hashN = "hash-note";
		const hashT = "hash-task";
		await t.run(async (ctx) => {
			await ctx.db.patch(s.noteStamped, { contentHash: hashN });
			await ctx.db.patch(s.taskStamped, { contentHash: hashT });
		});
		const noteId = await t.mutation(
			internal.okfBundle._insertImportedBriefing,
			{
				namespace: PHASE1_NAMESPACE,
				title: "stamped-note",
				topic: "t",
				participants: [],
				content: "body stamped-note",
				createdBy: "sigma",
				contentHash: hashN,
				now: NOW,
			},
		);
		const taskId = await t.mutation(internal.okfBundle._insertImportedTask, {
			namespace: PHASE1_NAMESPACE,
			title: "stamped-task",
			description: "desc stamped-task",
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
			contentHash: hashT,
			now: NOW,
		});
		expect(noteId).toBe(s.noteStamped);
		expect(taskId).toBe(s.taskStamped);
		const found = await t.query(
			internal.okfBundle._findBriefingByTitleAndContent,
			{
				namespace: PHASE1_NAMESPACE,
				title: "stamped-note",
				content: "body stamped-note",
				paginationOpts: { numItems: 256, cursor: null },
			},
		);
		let cursor: string | null = found.continueCursor;
		let id: string | null = found.id;
		for (let i = 0; i < 5 && id === null && cursor !== null; i++) {
			const r: { id: string | null; isDone: boolean; continueCursor: string } =
				await t.query(internal.okfBundle._findBriefingByTitleAndContent, {
					namespace: PHASE1_NAMESPACE,
					title: "stamped-note",
					content: "body stamped-note",
					paginationOpts: { numItems: 256, cursor },
				});
			id = r.id;
			cursor = r.isDone ? null : r.continueCursor;
		}
		expect(id).toBe(s.noteStamped);
		const task = await t.query(
			internal.okfBundle._findTaskByTitleAndDescription,
			{
				namespace: PHASE1_NAMESPACE,
				title: "stamped-task",
				description: "desc stamped-task",
				paginationOpts: { numItems: 256, cursor: null },
			},
		);
		let tid: string | null = task.id;
		let tc: string | null = task.isDone ? null : task.continueCursor;
		for (let i = 0; i < 5 && tid === null && tc !== null; i++) {
			const r: { id: string | null; isDone: boolean; continueCursor: string } =
				await t.query(internal.okfBundle._findTaskByTitleAndDescription, {
					namespace: PHASE1_NAMESPACE,
					title: "stamped-task",
					description: "desc stamped-task",
					paginationOpts: { numItems: 256, cursor: tc },
				});
			tid = r.id;
			tc = r.isDone ? null : r.continueCursor;
		}
		expect(tid).toBe(s.taskStamped);
		const counts = await t.run(async (ctx) => ({
			notes: (await ctx.db.query("briefingNotes").collect()).length,
			tasks: (await ctx.db.query("tasks").collect()).length,
		}));
		expect(counts).toEqual({ notes: 3, tasks: 3 });
	});

	test("ABSENT: with no operator org, only unstamped rows are exported (nothing widened)", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("tasks", {
				title: "legacy",
				assignedTo: "x",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "x",
				createdAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert("tasks", {
				title: "someone-else",
				assignedTo: "x",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "x",
				createdAt: NOW,
				updatedAt: NOW,
				orgId: "some-slug",
			});
		});
		expect(await drain(t, "_fetchTasksForBundle")).toEqual(["legacy"]);
	});
});
