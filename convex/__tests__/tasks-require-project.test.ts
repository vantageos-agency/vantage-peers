/// <reference types="vite/client" />
/**
 * convex/__tests__/tasks-require-project.test.ts
 *
 * Task k17c7mz2n765wacn6qxcgy00vn8hsa58. A task is created WITH a project, or not at all.
 * Poles:
 *   REFUSED   create with the project missing / empty / whitespace -> TASK_PROJECT_REQUIRED
 *   ACCEPTED  create with a project -> the row carries it
 *   UPDATE    update that omits project on a legacy row without one still works;
 *             update that sets project to empty/whitespace is refused;
 *             update that sets a real project works
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { insertTaskRow, seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const SERVICE_ACCOUNT = "test-service-account-user-id";

async function world() {
	const t = convexTest(schema, modules);
	await seedFleetAgents(t, ["sigma", "pi"]);
	return t.withIdentity({ subject: SERVICE_ACCOUNT });
}

const base = {
	title: "Needs a project",
	assignedTo: "pi" as const,
	priority: "medium" as const,
	status: "todo" as const,
	createdBy: "sigma" as const,
};

describe("tasks:create requires a project", () => {
	test("REFUSED: project omitted", async () => {
		const t = await world();
		await expect(t.mutation(api.tasks.create, base)).rejects.toThrow(
			/TASK_PROJECT_REQUIRED/,
		);
	});

	test("REFUSED: project empty string", async () => {
		const t = await world();
		await expect(
			t.mutation(api.tasks.create, { ...base, project: "" }),
		).rejects.toThrow(/TASK_PROJECT_REQUIRED/);
	});

	test("REFUSED: project whitespace only", async () => {
		const t = await world();
		await expect(
			t.mutation(api.tasks.create, { ...base, project: "   \t " }),
		).rejects.toThrow(/TASK_PROJECT_REQUIRED/);
	});

	test("REFUSED: the refusal names the field and writes no row", async () => {
		const t = await world();
		await expect(t.mutation(api.tasks.create, base)).rejects.toThrow(/project/);
		const rows = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(rows).toHaveLength(0);
	});

	test("ACCEPTED: a real project is stored", async () => {
		const t = await world();
		const id = await t.mutation(api.tasks.create, { ...base, project: "vantage-peers" });
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.project).toBe("vantage-peers");
	});
});

describe("tasks:update and a project", () => {
	async function legacyRow(t: Awaited<ReturnType<typeof world>>) {
		return await t.run(async (ctx) =>
			insertTaskRow(ctx, {
				title: "Legacy, no project",
				assignedTo: "pi",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
	}

	test("an update that omits project leaves a legacy row without one working", async () => {
		const t = await world();
		const taskId = await legacyRow(t);
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			description: "edited",
		});
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.description).toBe("edited");
		expect(row?.project).toBeUndefined();
	});

	test("REFUSED: an update that sets project to empty", async () => {
		const t = await world();
		const taskId = await legacyRow(t);
		await expect(
			t.mutation(api.tasks.update, { taskId, callerOrchestrator: "sigma", project: "" }),
		).rejects.toThrow(/TASK_PROJECT_REQUIRED/);
		await expect(
			t.mutation(api.tasks.update, { taskId, callerOrchestrator: "sigma", project: "  " }),
		).rejects.toThrow(/TASK_PROJECT_REQUIRED/);
	});

	test("an update that sets a real project is stored", async () => {
		const t = await world();
		const taskId = await legacyRow(t);
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			project: "vantage-peers",
		});
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.project).toBe("vantage-peers");
	});
});
