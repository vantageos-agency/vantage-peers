/// <reference types="vite/client" />
// allow-missing-refs: new test file for the missionTemplates.brief feature
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

// Helper: create a mission and return its ID
async function seedMission(
	t: ReturnType<typeof createTestConvex>,
	overrides: { pilot?: string; project?: string; brief?: string } = {},
) {
	return await t.mutation(api.missions.create, {
		name: "Test Mission",
		project: overrides.project ?? "test-project",
		status: "execute",
		priority: "high",
		pilot: overrides.pilot ?? "pi",
		agents: [],
		brief: overrides.brief,
		createdBy: "pi",
	});
}

// Helper: seed the real "daily-passation-v1" template fixture with a brief.
async function seedDailyPassationTemplate(
	t: ReturnType<typeof createTestConvex>,
	brief: string,
) {
	await t.mutation(api.missionTemplates.upsert, {
		name: "daily-passation-v1",
		description: "Daily passation between orchestrators",
		brief,
		steps: [
			{ title: "Handoff", description: "Write the handoff note" },
			{ title: "Verify", description: "Verify prior day's closeout" },
		],
		createdBy: "pi",
	});
	return "daily-passation-v1";
}

describe("missionTemplates.brief — instantiation carries the template brief", () => {
	// RED #1: instantiating a mission from a template WITHOUT a brief on the
	// mission must result in the mission carrying the TEMPLATE's brief.
	test("mission instantiated without a brief inherits the template's brief", async () => {
		const t = createTestConvex();
		const missionId = await seedMission(t, { pilot: "pi" }); // no brief supplied

		const templateName = await seedDailyPassationTemplate(
			t,
			"Daily passation cadrage: hand off open threads, blockers, and state.",
		);

		await t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
			templateName,
			missionId,
		});

		const mission = await t.query(api.missions.get, {
			missionId: missionId as unknown as string,
		});
		expect(mission?.brief).toBe(
			"Daily passation cadrage: hand off open threads, blockers, and state.",
		);
	});

	// RED #2: instance-specific fields (pilot, project) supplied by the caller
	// at mission creation must NOT be overwritten by the template.
	test("instance-specific fields (pilot, project) are not overwritten by the template", async () => {
		const t = createTestConvex();
		const missionId = await seedMission(t, {
			pilot: "sigma",
			project: "vantage-peers-cloud",
		});

		const templateName = await seedDailyPassationTemplate(
			t,
			"Template brief — should not affect pilot/project.",
		);

		await t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
			templateName,
			missionId,
		});

		const mission = await t.query(api.missions.get, {
			missionId: missionId as unknown as string,
		});
		expect(mission?.pilot).toBe("sigma");
		expect(mission?.project).toBe("vantage-peers-cloud");
		expect(mission?.brief).toBe(
			"Template brief — should not affect pilot/project.",
		);
	});

	// A mission that already has its own brief keeps it — the template never
	// overwrites a brief the caller already supplied.
	test("mission's own brief is not overwritten when it already has one", async () => {
		const t = createTestConvex();
		const missionId = await seedMission(t, {
			brief: "Caller-supplied brief for this specific instance.",
		});

		const templateName = await seedDailyPassationTemplate(
			t,
			"Template brief that must be ignored here.",
		);

		await t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
			templateName,
			missionId,
		});

		const mission = await t.query(api.missions.get, {
			missionId: missionId as unknown as string,
		});
		expect(mission?.brief).toBe(
			"Caller-supplied brief for this specific instance.",
		);
	});

	// A template with no brief leaves the mission's brief untouched (undefined).
	test("template without a brief leaves the mission's brief unset", async () => {
		const t = createTestConvex();
		const missionId = await seedMission(t); // no brief

		await t.mutation(api.missionTemplates.upsert, {
			name: "no-brief-template",
			steps: [{ title: "Step A", description: "Do A" }],
			createdBy: "pi",
		});

		await t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
			templateName: "no-brief-template",
			missionId,
		});

		const mission = await t.query(api.missions.get, {
			missionId: missionId as unknown as string,
		});
		expect(mission?.brief).toBeUndefined();
	});
});
