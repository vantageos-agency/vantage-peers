/// <reference types="vite/client" />
/**
 * Companion of mcpNameCollisionExposure.test.ts: the same org-a "eta" vs org-b
 * "eta" collision, but with the STRICT-path proof `verifiedActor` = the agents
 * ROW id of org-a's "eta" and the org it was verified in.
 *
 * `verifiedActor` proves WHICH AGENT is acting (the name lock); it does not by
 * itself bind the call to the target row's org, because the transport scope is
 * the master service account. What binds the row is `verifiedOrg`, the same
 * helper every task door takes. So:
 *   REFUSED  verifiedActor + verifiedOrg org-a on an org-b row -> RBAC_DENIED, row untouched
 *   PRESENT  the same pair on an org-a row                     -> lands
 *   ALONE    verifiedActor without verifiedOrg                 -> NOT bound (pinned: no
 *            transport forwards verifiedActor alone; the MCP layer forwards verifiedOrg)
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
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

type Door = "complete" | "update" | "deleteTask";
const DOORS: Door[] = ["complete", "update", "deleteTask"];

async function run(
	door: Door,
	t: Awaited<ReturnType<typeof setup>>["t"],
	taskId: Id<"tasks">,
	agentId: Id<"agents">,
	withOrg: boolean,
): Promise<string | null> {
	const proof = {
		callerOrchestrator: "eta",
		verifiedActor: { agentId, orgSlug: "org-a" },
		...(withOrg ? { verifiedOrg: { orgSlug: "org-a" } } : {}),
	};
	const as = asService(t);
	const p =
		door === "complete"
			? as.mutation(api.tasks.complete, {
					taskId,
					completionNote: "closing, evidence abc1234 and more words here",
					...proof,
				})
			: door === "update"
				? as.mutation(api.tasks.update, { taskId, title: "HIJACKED", ...proof })
				: as.mutation(api.tasks.deleteTask, { taskId, ...proof });
	return await p.then(
		() => null,
		(e: Error) =>
			`${e.message} ${JSON.stringify((e as { data?: unknown }).data ?? "")}`,
	);
}

const landedOf = (
	door: Door,
	r: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["row"]>>,
) =>
	door === "complete"
		? r?.status === "done"
		: door === "update"
			? r?.title === "HIJACKED"
			: r === null;

describe("org-a 'eta' WITH verifiedActor vs an org-b 'eta' task", () => {
	for (const door of DOORS) {
		test(`REFUSED: ${door} with verifiedActor + verifiedOrg org-a on an org-b row`, async () => {
			const { t, taskId, agentId, row } = await setup();
			const before = JSON.stringify(await row());
			const err = await run(door, t, taskId, agentId, true);
			expect(err, `${door} must refuse`).toContain("RBAC_DENIED");
			expect(JSON.stringify(await row())).toBe(before);
		});

		test(`PRESENT: ${door} with verifiedActor + verifiedOrg org-a on an org-a row`, async () => {
			const { t, taskId, agentId, row } = await setup();
			await t.run((ctx) => ctx.db.patch(taskId, { orgId: "org-a" }));
			const err = await run(door, t, taskId, agentId, true);
			expect(err).toBeNull();
			expect(landedOf(door, await row())).toBe(true);
		});

		test(`ALONE (pinned, not bound): ${door} with verifiedActor and no verifiedOrg still reaches the org-b row`, async () => {
			const { t, taskId, agentId, row } = await setup();
			await run(door, t, taskId, agentId, false);
			expect(landedOf(door, await row())).toBe(true);
		});
	}
});
