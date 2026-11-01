/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * The blocker notice carries its waiter's organisation (task
 * k1783fk8r6p795x9fxrzyt9evd8hcxm7, PR (2b), Pi receipt k9768tz43k6dvy6bgvgz9p4x2x8hcw85).
 *
 * `unblockWaitersOn` writes a system message and a receipt to the assignee of every
 * task waiting on a blocker that closes. Before this, both rows were unstamped, so
 * for a waiter that belongs to a client org they were fleet-shaped and invisible to
 * that org's own readers once the reads key on `tenantOrgId`.
 *
 *   tenant waiter  -> notice and receipt stamped tenantId = waiter.orgId,
 *                     tenantOrgId = waiter.clerkOrgId, readable by that org
 *   fleet waiter   -> notice and receipt stay unstamped (the fleet decision)
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { insertTaskRow, seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const CLIENT = "client-w";
const CLIENT_ID = testClerkOrgId(CLIENT) as string;
const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;

type Closing = "complete" | "fail";

async function scenario(
	waiterOrg: "client" | "fleet" | "operator",
	closing: Closing,
) {
	const t = convexTest(schema, modules);
	await seedFleetAgents(t, ["eta", "sigma"]);
	const { blockerId, waiterId } = await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: CLIENT,
			clerkOrgId: CLIENT_ID,
			allowedOrchestrators: ["cw-agent"],
			scopes: ["view-own-tasks"],
			displayName: CLIENT,
			isActive: true,
			createdAt: 5,
		});
		const blockerId = await insertTaskRow(ctx, {
			title: "blocker",
			assignedTo: "eta",
			createdBy: "eta",
			priority: "medium",
			status: "in_progress",
			createdAt: 1,
			updatedAt: 1,
		});
		const waiterId = await insertTaskRow(ctx, {
			title: "waiter",
			assignedTo: waiterOrg === "client" ? "cw-agent" : "sigma",
			createdBy: waiterOrg === "client" ? "cw-agent" : "sigma",
			priority: "medium",
			status: "blocked",
			blockedOnTaskId: blockerId,
			...(waiterOrg === "client" ? { orgId: CLIENT, clerkOrgId: CLIENT_ID } : {}),
			// A task created before 2026-10-29 carries the operator org stamp: still the fleet's.
			...(waiterOrg === "operator"
				? {
						orgId: "fleet-operator",
						clerkOrgId: testClerkOrgId("fleet-operator"),
					}
				: {}),
			createdAt: 2,
			updatedAt: 2,
		});
		return { blockerId, waiterId };
	});
	const svc = t.withIdentity({ subject: SERVICE });
	if (closing === "complete") {
		await svc.mutation(api.tasks.complete, {
			taskId: blockerId,
			callerOrchestrator: "eta",
			completionNote: "Merged PR #667, all tests pass 18/18",
		});
	} else {
		await svc.mutation(api.tasks.failTask, {
			taskId: blockerId,
			callerOrchestrator: "eta",
			failureNote: "The prerequisite could not be built, 0/3 gates pass",
		});
	}
	const rows = await t.run(async (ctx) => ({
		notices: (await ctx.db.query("messages").collect()).filter(
			(m) => m.content.includes(waiterId),
		),
		receipts: await ctx.db.query("messageReceipts").collect(),
	}));
	return { t, rows };
}

describe("unblockWaitersOn stamps the notice with the waiter's organisation", () => {
	for (const closing of ["complete", "fail"] as const) {
		test(`TENANT waiter (${closing}): notice and receipt carry the waiter's org and its own org reads them`, async () => {
			const { t, rows } = await scenario("client", closing);
			expect(rows.notices).toHaveLength(1);
			expect(rows.notices[0].tenantId).toBe(CLIENT);
			expect(rows.notices[0].tenantOrgId).toBe(CLIENT_ID);
			expect(rows.receipts).toHaveLength(1);
			expect(rows.receipts[0].tenantId).toBe(CLIENT);
			expect(rows.receipts[0].tenantOrgId).toBe(CLIENT_ID);
			const member = t.withIdentity({
				subject: "user-w",
				org_slug: CLIENT,
				org_id: CLIENT_ID,
				org_role: "org:admin",
			} as Parameters<typeof t.withIdentity>[0]);
			const seen = await member.query(api.messages.checkNewMessages, {
				recipient: "cw-agent",
			});
			expect(seen.map((m) => m.from)).toEqual(["system"]);
		});

		test.each(["fleet", "operator"] as const)(`FLEET waiter (%s, ${closing}): notice and receipt stay unstamped`, async (shape) => {
			const { rows } = await scenario(shape, closing);
			expect(rows.notices).toHaveLength(1);
			expect(rows.notices[0].tenantId).toBeUndefined();
			expect(rows.notices[0].tenantOrgId).toBeUndefined();
			expect(rows.receipts).toHaveLength(1);
			expect(rows.receipts[0].tenantId).toBeUndefined();
			expect(rows.receipts[0].tenantOrgId).toBeUndefined();
		});
	}
});
