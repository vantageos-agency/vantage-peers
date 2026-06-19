/// <reference types="vite/client" />
//
// GAP-T1 (D90 ship-blocker) — direct behavioral tests for mission-template
// and deployment-infrastructure tools (4 of the 19):
//
//   16. instantiate_template_into_mission → convex/missionTemplates.ts ::
//          instantiateTemplateIntoMission (mutation)
//   17. add_deployment      → convex/errorMonitor.ts :: addDeployment (mutation)
//   18. remove_deployment   → convex/errorMonitor.ts :: removeDeployment (mutation)
//   19. get_mission_template → convex/missionTemplates.ts :: getByName (query)
//          [the 19th tool — paired with instantiate_template_into_mission,
//           covers the read-side of the template-management surface]
//
// Orchestrator: Sigma — VantagePeers | 2026-06-19

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

// ─────────────────────────────────────────────────────────────────────────────
// get_mission_template (the 19th tool)
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 get_mission_template — missionTemplates.getByName query", () => {
	test("happy path — returns the seeded template by name", async () => {
		const t = createTestConvex();
		await t.mutation(api.missionTemplates.upsert, {
			name: "gap-t1-test-template",
			description: "fixture",
			steps: [
				{ title: "S1", description: "step 1" },
				{ title: "S2", description: "step 2", dependsOn: [0] },
			],
			createdBy: "sigma",
		});

		const tpl = await t.query(api.missionTemplates.getByName, {
			name: "gap-t1-test-template",
		});
		expect(tpl).not.toBeNull();
		expect(tpl?.steps.length).toBe(2);
		expect(tpl?.steps[1].dependsOn).toEqual([0]);
	});

	test("edge case — unknown template name returns null", async () => {
		const t = createTestConvex();
		const tpl = await t.query(api.missionTemplates.getByName, {
			name: "no-such-template",
		});
		expect(tpl).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// instantiate_template_into_mission
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 instantiate_template_into_mission — missionTemplates.instantiateTemplateIntoMission mutation", () => {
	test("happy path — creates one task per step + resolves dependsOn task ids", async () => {
		const t = createTestConvex();

		await t.mutation(api.missionTemplates.upsert, {
			name: "gap-t1-three-step",
			steps: [
				{ title: "Plan", description: "plan {{topic}}" },
				{ title: "Build", description: "build", dependsOn: [0] },
				{ title: "Ship", description: "ship", dependsOn: [1] },
			],
			createdBy: "sigma",
		});

		const missionId = await t.run(async (ctx) => {
			return await ctx.db.insert("missions", {
				name: "GAP-T1 mission",
				project: "vantage-memory",
				status: "execute",
				priority: "high",
				pilot: "sigma",
				agents: ["sigma"],
				createdBy: "sigma",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const result = await t.mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{
				templateName: "gap-t1-three-step",
				missionId,
				context: { topic: "GAP-T1 coverage" },
				callerOrchestrator: "sigma",
			},
		);

		expect(result.count).toBe(3);
		expect(result.taskIds.length).toBe(3);

		await t.run(async (ctx) => {
			const t0 = await ctx.db.get(result.taskIds[0]);
			const t1 = await ctx.db.get(result.taskIds[1]);
			const t2 = await ctx.db.get(result.taskIds[2]);
			expect(t0?.description).toBe("plan GAP-T1 coverage"); // interpolated
			expect(t1?.dependsOn).toEqual([result.taskIds[0]]);
			expect(t2?.dependsOn).toEqual([result.taskIds[1]]);
		});
	});

	test("edge case — unknown templateName throws", async () => {
		const t = createTestConvex();
		const missionId = await t.run(async (ctx) => {
			return await ctx.db.insert("missions", {
				name: "x",
				project: "p",
				status: "execute",
				priority: "low",
				pilot: "sigma",
				agents: [],
				createdBy: "sigma",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: "ghost-template",
				missionId,
			}),
		).rejects.toThrow(/Template not found/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// add_deployment
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 add_deployment — errorMonitor.addDeployment mutation", () => {
	test("happy path — inserts a new deployment with active=true", async () => {
		const t = createTestConvex();

		const depId = await t.mutation(api.errorMonitor.addDeployment, {
			name: "vantage-memory-prod",
			deploymentUrl: "https://example.convex.cloud",
			deployKeyEnvVar: "CONVEX_DEPLOY_KEY_PROD",
			githubRepo: "elpiarthera/vantage-memory",
			orchestrator: "sigma",
		});

		expect(depId).toBeTruthy();
		await t.run(async (ctx) => {
			const row = await ctx.db.get(depId);
			expect(row?.active).toBe(true);
			expect(row?.name).toBe("vantage-memory-prod");
		});
	});

	test("edge case — re-adding same name upserts (no duplicate row, re-activates)", async () => {
		const t = createTestConvex();

		const first = await t.mutation(api.errorMonitor.addDeployment, {
			name: "duplicate-name",
			deploymentUrl: "https://a.convex.cloud",
			deployKeyEnvVar: "KEY_A",
			githubRepo: "x/a",
			orchestrator: "sigma",
		});

		// Deactivate it first to verify re-add re-activates.
		await t.mutation(api.errorMonitor.removeDeployment, {
			name: "duplicate-name",
		});

		const second = await t.mutation(api.errorMonitor.addDeployment, {
			name: "duplicate-name",
			deploymentUrl: "https://b.convex.cloud",
			deployKeyEnvVar: "KEY_B",
			githubRepo: "x/b",
			orchestrator: "tau",
		});

		expect(second).toBe(first); // same id (upsert by name)
		await t.run(async (ctx) => {
			const row = await ctx.db.get(first);
			expect(row?.active).toBe(true);
			expect(row?.orchestrator).toBe("tau");
			expect(row?.deploymentUrl).toBe("https://b.convex.cloud");
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// remove_deployment
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 remove_deployment — errorMonitor.removeDeployment mutation", () => {
	test("happy path — sets active=false on a known deployment", async () => {
		const t = createTestConvex();
		const depId = await t.mutation(api.errorMonitor.addDeployment, {
			name: "to-remove",
			deploymentUrl: "https://x.convex.cloud",
			deployKeyEnvVar: "KEY_X",
			githubRepo: "x/x",
			orchestrator: "sigma",
		});

		await t.mutation(api.errorMonitor.removeDeployment, {
			name: "to-remove",
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(depId);
			expect(row?.active).toBe(false);
		});
	});

	test("edge case — removing an unknown name is a silent no-op (returns null)", async () => {
		const t = createTestConvex();
		const res = await t.mutation(api.errorMonitor.removeDeployment, {
			name: "never-existed",
		});
		expect(res).toBeNull();
	});
});
