/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Exclude RAG/search/backfill modules — same exclusion as tests.test.ts
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

// Helper: create a mission and return its ID
async function seedMission(
	t: ReturnType<typeof createTestConvex>,
	overrides: { pilot?: string; project?: string } = {},
) {
	return await t.mutation(api.missions.create, {
		name: "Test Mission",
		project: overrides.project ?? "test-project",
		status: "execute",
		priority: "high",
		pilot: overrides.pilot ?? "pi",
		agents: [],
		createdBy: "pi",
	});
}

// Helper: create a template with given steps and return its name
async function seedTemplate(
	t: ReturnType<typeof createTestConvex>,
	name: string,
	steps: Array<{
		title: string;
		description: string;
		tags?: string[];
		assignedTo?: string;
		assignedToInstance?: string;
		dependsOn?: number[];
	}>,
) {
	await t.mutation(api.missionTemplates.upsert, {
		name,
		steps,
		createdBy: "pi",
	});
	return name;
}

// =============================================================================
// instantiateTemplateIntoMission
// =============================================================================

describe("instantiateTemplateIntoMission", () => {
	// Case 1: assignedTo defined on every step → tasks assigned as declared
	test("uses step.assignedTo when declared on every step", async () => {
		const t = createTestConvex();
		const missionId = await seedMission(t, { pilot: "pi" });

		await seedTemplate(t, "all-assigned", [
			{ title: "Step A", description: "Do A", assignedTo: "proxima" },
			{ title: "Step B", description: "Do B", assignedTo: "verify" },
		]);

		const { taskIds, count } = await t.mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "all-assigned", missionId },
		);

		expect(count).toBe(2);
		expect(taskIds).toHaveLength(2);

		const taskA = await t.query(api.tasks.get, { taskId: taskIds[0] });
		const taskB = await t.query(api.tasks.get, { taskId: taskIds[1] });

		expect(taskA?.assignedTo).toBe("proxima");
		expect(taskB?.assignedTo).toBe("verify");
	});

	// Case 2: step missing assignedTo → task falls back to mission.pilot
	test("falls back to mission.pilot when step has no assignedTo", async () => {
		const t = createTestConvex();
		const missionId = await seedMission(t, { pilot: "sigma" });

		await seedTemplate(t, "no-assigned", [
			{ title: "Step A", description: "Do A", assignedTo: "proxima" },
			{ title: "Step B", description: "Do B" }, // no assignedTo
		]);

		const { taskIds } = await t.mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "no-assigned", missionId },
		);

		const taskA = await t.query(api.tasks.get, { taskId: taskIds[0] });
		const taskB = await t.query(api.tasks.get, { taskId: taskIds[1] });

		expect(taskA?.assignedTo).toBe("proxima");
		expect(taskB?.assignedTo).toBe("sigma"); // fallback to pilot
	});

	// Case 3: backward compat — template with only {title, description, tags}
	//         → instantiation succeeds, all tasks assigned to mission.pilot
	test("backward compat: legacy template without assignedTo assigns all to pilot", async () => {
		const t = createTestConvex();
		const missionId = await seedMission(t, { pilot: "tau" });

		await seedTemplate(t, "legacy-template", [
			{
				title: "T0 Acknowledge",
				description: "Post comment",
				tags: ["automated"],
			},
			{
				title: "T1 Investigate",
				description: "Look into it",
				tags: ["research"],
			},
			{ title: "T2 Fix", description: "Apply fix", tags: ["implementation"] },
		]);

		const { taskIds, count } = await t.mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "legacy-template", missionId },
		);

		expect(count).toBe(3);
		for (const taskId of taskIds) {
			const task = await t.query(api.tasks.get, { taskId });
			expect(task?.assignedTo).toBe("tau");
		}
	});

	// Case 4: dependsOn: [0, 1] on step 2 → resolves to first 2 created task ids
	test("resolves dependsOn step-indexes to task IDs", async () => {
		const t = createTestConvex();
		const missionId = await seedMission(t);

		await seedTemplate(t, "with-deps", [
			{ title: "Step 0", description: "First" },
			{ title: "Step 1", description: "Second" },
			{ title: "Step 2", description: "Third", dependsOn: [0, 1] },
		]);

		const { taskIds } = await t.mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "with-deps", missionId },
		);

		const task2 = await t.query(api.tasks.get, { taskId: taskIds[2] });
		expect(task2?.dependsOn).toEqual([taskIds[0], taskIds[1]]);
	});

	// Case 5: dependsOn: [99] (out of range) → throws
	test("throws when dependsOn index is out of range", async () => {
		const t = createTestConvex();
		const missionId = await seedMission(t);

		await seedTemplate(t, "bad-deps", [
			{ title: "Step 0", description: "First" },
			{ title: "Step 1", description: "Second", dependsOn: [99] },
		]);

		await expect(
			t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: "bad-deps",
				missionId,
			}),
		).rejects.toThrow(/out of range/);
	});
});
