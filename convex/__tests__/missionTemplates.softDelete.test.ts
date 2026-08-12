/// <reference types="vite/client" />
// allow-missing-refs: new test file created for this task
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

// Exclude RAG/search/backfill modules — same exclusion as tests.test.ts
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
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

async function seedTemplate(t: ReturnType<typeof createTestConvex>, name: string) {
	return await t.mutation(api.missionTemplates.upsert, {
		name,
		steps: [{ title: "Step 1", description: "Do the thing" }],
		createdBy: "pi",
	});
}

describe("missionTemplates.softDelete", () => {
	test("soft-deleted template is invisible to getByName", async () => {
		const t = createTestConvex();
		const name = "_probe-1180-brief";
		await seedTemplate(t, name);

		// Sanity: template exists before delete.
		const before = await t.query(api.missionTemplates.getByName, { name });
		expect(before).not.toBeNull();

		await t.mutation(api.missionTemplates.softDelete, { name });

		const after = await t.query(api.missionTemplates.getByName, { name });
		expect(after).toBeNull();
	});

	test("non-deleted template remains visible after an unrelated soft-delete", async () => {
		const t = createTestConvex();
		await seedTemplate(t, "_probe-deleted");
		await seedTemplate(t, "issue-resolution-kept");

		await t.mutation(api.missionTemplates.softDelete, {
			name: "_probe-deleted",
		});

		const kept = await t.query(api.missionTemplates.getByName, {
			name: "issue-resolution-kept",
		});
		expect(kept).not.toBeNull();
		expect(kept?.name).toBe("issue-resolution-kept");

		const deleted = await t.query(api.missionTemplates.getByName, {
			name: "_probe-deleted",
		});
		expect(deleted).toBeNull();
	});

	test("softDelete throws when template not found", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.missionTemplates.softDelete, {
				name: "does-not-exist",
			}),
		).rejects.toThrow(/not found/i);
	});

	test("softDelete accepts templateId", async () => {
		const t = createTestConvex();
		const name = "_probe-by-id";
		await seedTemplate(t, name);
		const template = await t.query(api.missionTemplates.getByName, { name });
		expect(template).not.toBeNull();

		await t.mutation(api.missionTemplates.softDelete, {
			templateId: template!._id,
		});

		const after = await t.query(api.missionTemplates.getByName, { name });
		expect(after).toBeNull();
	});

	test("instantiateTemplateIntoMission refuses a soft-deleted template", async () => {
		const t = createTestConvex();
		const name = "_probe-instantiate";
		await seedTemplate(t, name);
		await t.mutation(api.missionTemplates.softDelete, { name });

		const missionId = await t.mutation(api.missions.create, {
			name: "Test Mission",
			project: "test-project",
			status: "execute",
			priority: "high",
			pilot: "pi",
			agents: [],
			createdBy: "pi",
		});

		await expect(
			t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: name,
				missionId,
			}),
		).rejects.toThrow(/not found/i);
	});
});
