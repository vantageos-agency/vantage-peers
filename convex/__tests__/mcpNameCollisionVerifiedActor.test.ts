/// <reference types="vite/client" />
/**
 * MEASUREMENT (companion of mcpNameCollisionExposure.test.ts): the same
 * org-a "eta" vs org-b "eta" collision, but with the STRICT-path proof the MCP
 * layer forwards for a non-master org caller: `verifiedActor` = the agents ROW
 * id of org-a's "eta" and the org it was verified in. Does that proof bind the
 * call to the target row's org?
 *
 * Each case asserts the CURRENT measured behaviour (`landed`), so a later fix
 * flips it deliberately.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

async function setup() {
	const t = createT();
	let taskId!: Id<"tasks">;
	let agentId!: Id<"agents">;
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: Date.now(),
		});
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["eta"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
		agentId = await ctx.db.insert("agents", {
			orgSlug: "org-a",
			name: "eta",
			normalizedName: "eta",
			isActive: true,
			createdAt: Date.now(),
		});
		const now = Date.now();
		taskId = await ctx.db.insert("tasks", {
			title: "org-b task",
			assignedTo: "eta",
			createdBy: "eta",
			priority: "low",
			status: "in_progress",
			orgId: "org-b",
			startedAt: now - 60_000,
			workSegments: [{ start: now - 60_000 }],
			createdAt: now,
			updatedAt: now,
		});
	});
	return { t, taskId, agentId, row: () => t.run((ctx) => ctx.db.get(taskId)) };
}

describe("MEASUREMENT: org-a 'eta' WITH verifiedActor vs an org-b 'eta' task", () => {
	test("EXPOSED: complete", async () => {
		const { t, taskId, agentId, row } = await setup();
		const err = await asService(t)
			.mutation(api.tasks.complete, {
				taskId,
				completionNote: "closing, evidence abc1234 and more words here",
				callerOrchestrator: "eta",
				verifiedActor: { agentId, orgSlug: "org-a" },
			})
			.then(() => null, (e: Error) => e.message.slice(0, 140));
		const landed = (await row())?.status === "done";
		expect({ landed, err }).toMatchObject({ landed: expect.any(Boolean) });
		expect(landed, `complete with verifiedActor: KNOWN EXPOSURE (unfixed), ${err ?? "no refusal"}`).toBe(true);
	});

	test("EXPOSED: update", async () => {
		const { t, taskId, agentId, row } = await setup();
		const err = await asService(t)
			.mutation(api.tasks.update, {
				taskId,
				title: "HIJACKED",
				callerOrchestrator: "eta",
				verifiedActor: { agentId, orgSlug: "org-a" },
			})
			.then(() => null, (e: Error) => e.message.slice(0, 140));
		const landed = (await row())?.title === "HIJACKED";
		expect(landed, `update with verifiedActor: KNOWN EXPOSURE (unfixed), ${err ?? "no refusal"}`).toBe(true);
	});

	test("EXPOSED: deleteTask", async () => {
		const { t, taskId, agentId, row } = await setup();
		const err = await asService(t)
			.mutation(api.tasks.deleteTask, {
				taskId,
				callerOrchestrator: "eta",
				verifiedActor: { agentId, orgSlug: "org-a" },
			})
			.then(() => null, (e: Error) => e.message.slice(0, 140));
		const landed = (await row()) === null;
		expect(landed, `deleteTask with verifiedActor: KNOWN EXPOSURE (unfixed), ${err ?? "no refusal"}`).toBe(true);
	});
});
