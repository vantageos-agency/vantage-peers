/// <reference types="vite/client" />
/**
 * convex/__tests__/addDependencies.test.ts
 *
 * MCP add_task_dependency used to call tasks:update with the new ids, which
 * REPLACES dependsOn: a task holding [A] that was given [B, C] ended with
 * [B, C] and lost A's ordering with no signal. tasks:update `addDependsOn` APPENDS (the existing `dependsOn` stays the REPLACE path).
 *
 * Poles: APPEND (the defect), IDEMPOTENT repeat, DEDUP inside one call,
 * ORDER (existing first), and REFUSED for self / missing / other-org / cycle.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { insertTaskRow, seedFleetAgents } from "../../tests/lib/seedFleetAgents";
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

function createT(): ReturnType<typeof convexTest> {
	return convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	}) as unknown as ReturnType<typeof convexTest>;
}

type T = ReturnType<typeof createT>;

async function makeTask(t: T, title: string, dependsOn?: Id<"tasks">[]): Promise<Id<"tasks">> {
	return await t.mutation(api.tasks.create, {
		title,
		assignedTo: "sigma",
		priority: "medium",
		status: "todo",
		createdBy: "sigma",
		...(dependsOn === undefined ? {} : { dependsOn }),
	});
}

async function depsOf(t: T, id: Id<"tasks">): Promise<Id<"tasks">[]> {
	const row = await t.run(async (ctx) => await ctx.db.get(id));
	return (row?.dependsOn ?? []) as Id<"tasks">[];
}

/** Appends through tasks:update `addDependsOn`; resolves to the stored list. */
async function add(t: T, taskId: Id<"tasks">, addDependsOn: Id<"tasks">[]): Promise<Id<"tasks">[]> {
	await t.mutation(api.tasks.update, {
		taskId,
		addDependsOn,
		callerOrchestrator: "sigma",
	});
	return await depsOf(t, taskId);
}

function message(error: unknown): string {
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<string>).message;
}

describe("tasks:update addDependsOn appends", () => {
	test("PRESENT: [A] + add [B,C] -> [A,B,C], returned and stored", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const a = await makeTask(t, "A");
		const b = await makeTask(t, "B");
		const c = await makeTask(t, "C");
		const task = await makeTask(t, "T", [a]);

		const result = await add(t, task, [b, c]);

		expect(result).toEqual([a, b, c]);
		expect(await depsOf(t, task)).toEqual([a, b, c]);
	});

	test("IDEMPOTENT: adding [B] again leaves the list unchanged", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const a = await makeTask(t, "A");
		const b = await makeTask(t, "B");
		const task = await makeTask(t, "T", [a]);

		await add(t, task, [b]);
		const again = await add(t, task, [b]);

		expect(again).toEqual([a, b]);
		expect(await depsOf(t, task)).toEqual([a, b]);
	});

	test("DEDUP: a repeated id inside one call, and an id already present, enter once", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const a = await makeTask(t, "A");
		const b = await makeTask(t, "B");
		const task = await makeTask(t, "T", [a]);

		expect(await add(t, task, [b, a, b])).toEqual([a, b]);
	});

	test("ABSENT: a task with no dependsOn gets exactly the new ids, in order", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const a = await makeTask(t, "A");
		const b = await makeTask(t, "B");
		const task = await makeTask(t, "T");

		expect(await add(t, task, [b, a])).toEqual([b, a]);
	});
});

describe("tasks:update addDependsOn refuses", () => {
	test("self dependency", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const task = await makeTask(t, "T");
		const error = await add(t, task, [task]).catch((e) => e);
		expect(message(error)).toContain("DEPENDENCY_SELF");
		expect(await depsOf(t, task)).toEqual([]);
	});

	test("a task that does not exist", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const ghost = await makeTask(t, "ghost");
		await t.run(async (ctx) => await ctx.db.delete(ghost));
		const task = await makeTask(t, "T");
		const error = await add(t, task, [ghost]).catch((e) => e);
		expect(message(error)).toContain("DEPENDENCY_NOT_FOUND");
		expect(await depsOf(t, task)).toEqual([]);
	});

	test("a task of another organisation, worded exactly as a missing one", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const task = await makeTask(t, "T");
		const foreign = await t.run(async (ctx) =>
			insertTaskRow(ctx, {
				title: "foreign",
				assignedTo: "sigma",
				createdBy: "sigma",
				priority: "medium",
				status: "todo",
				orgId: "org-foreign",
				clerkOrgId: testClerkOrgId("org-foreign"),
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		const error = await add(t, task, [foreign]).catch((e) => e);
		expect(message(error)).toContain("DEPENDENCY_NOT_FOUND");
		expect(await depsOf(t, task)).toEqual([]);
	});

	test("addDependsOn and dependsOn together (ambiguous)", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const a = await makeTask(t, "A");
		const task = await makeTask(t, "T");
		const error = await t
			.mutation(api.tasks.update, { taskId: task, dependsOn: [a], addDependsOn: [a], callerOrchestrator: "sigma" })
			.catch((e) => e);
		expect(message(error)).toContain("DEPENDENCY_MODE_AMBIGUOUS");
		expect(await depsOf(t, task)).toEqual([]);
	});

	test("dependsOn still REPLACES (the explicit replace path is unchanged)", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const a = await makeTask(t, "A");
		const b = await makeTask(t, "B");
		const task = await makeTask(t, "T", [a]);
		await t.mutation(api.tasks.update, { taskId: task, dependsOn: [b], callerOrchestrator: "sigma" });
		expect(await depsOf(t, task)).toEqual([b]);
	});

	test("a cycle (A depends on T; adding A to T)", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const task = await makeTask(t, "T");
		const a = await makeTask(t, "A", [task]);
		const error = await add(t, task, [a]).catch((e) => e);
		expect(message(error)).toContain("DEPENDENCY_CYCLE");
		expect(await depsOf(t, task)).toEqual([]);
	});

	test("one bad id in a batch changes nothing (all-or-nothing)", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		const a = await makeTask(t, "A");
		const b = await makeTask(t, "B");
		const task = await makeTask(t, "T", [a]);
		const error = await add(t, task, [b, task]).catch((e) => e);
		expect(message(error)).toContain("DEPENDENCY_SELF");
		expect(await depsOf(t, task)).toEqual([a]);
	});
});
