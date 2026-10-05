/// <reference types="vite/client" />
/**
 * MEASUREMENT, not a fix: which service-account-routed task mutations let an
 * org-a "eta" act on an org-b task that names an org-b "eta".
 *
 * Through MCP every call reaches Convex as the fleet service account (master
 * scope), so the row-level tenant gate (`isRowVisibleToScope`, master = every
 * tenant) does not narrow, and the creator/assignee check compares NAMES. Only
 * `bulkComplete` carries a verified org (`verifiedOrg`) and narrows by it.
 *
 * Each case below asserts the CURRENT behaviour of one mutation: `landed: true`
 * means the org-b row WAS changed by the org-a-eta call (an exposure),
 * `landed: false` means the call was refused or did nothing. When an exposed
 * mutation is fixed its case flips and this file is the place that says so.
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

async function setup(status: "todo" | "in_progress" | "paused" = "in_progress") {
	const t = createT();
	let id!: Id<"tasks">;
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
		const now = Date.now();
		id = await ctx.db.insert("tasks", {
			title: "org-b task",
			assignedTo: "eta",
			createdBy: "eta",
			priority: "low",
			status: status === "paused" ? "in_progress" : status,
			orgId: "org-b",
			...(status === "in_progress"
				? { startedAt: now - 60_000, workSegments: [{ start: now - 60_000 }] }
				: {}),
			...(status === "paused"
				? {
						startedAt: now - 60_000,
						pausedAt: now - 1000,
						workSegments: [{ start: now - 60_000, end: now - 1000 }],
					}
				: {}),
			createdAt: now,
			updatedAt: now,
		});
	});
	const row = () => t.run((ctx) => ctx.db.get(id));
	return { t, id, row };
}

const ETA = "eta"; // the asserted name: org-a's agent AND org-b's agent share it

interface Case {
	name: string;
	status: "todo" | "in_progress" | "paused";
	/** MEASURED current behaviour: true = the org-b row was changed (an exposure). */
	exposed: boolean;
	call: (t: T, taskId: Id<"tasks">) => Promise<unknown>;
	landed: (r: NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["row"]>>>) => boolean;
}

const cases: Case[] = [
	{
		name: "complete",
		exposed: true,
		status: "in_progress",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.complete, {
				taskId,
				completionNote: "closing, evidence abc1234 and more words here",
				callerOrchestrator: ETA,
			}),
		landed: (r) => r.status === "done",
	},
	{
		name: "update",
		exposed: true,
		status: "todo",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.update, {
				taskId,
				title: "HIJACKED",
				callerOrchestrator: ETA,
			}),
		landed: (r) => r.title === "HIJACKED",
	},
	{
		name: "start",
		exposed: true,
		status: "todo",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.start, { taskId, callerOrchestrator: ETA }),
		landed: (r) => r.status === "in_progress",
	},
	{
		name: "pause",
		exposed: true,
		status: "in_progress",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.pause, { taskId, callerOrchestrator: ETA }),
		landed: (r) => r.pausedAt !== undefined,
	},
	{
		name: "blockTask",
		exposed: true,
		status: "in_progress",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: ETA,
				reason: "# blocked-on-nobody: third-party outage typed by the colliding agent",
			}),
		landed: (r) => r.status === "blocked",
	},
	{
		name: "failTask",
		exposed: true,
		status: "in_progress",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.failTask, {
				taskId,
				callerOrchestrator: ETA,
				failureNote: "failing it, evidence abc1234 and more words here",
			}),
		landed: (r) => r.status === "failed",
	},
	{
		name: "deleteTask",
		exposed: true,
		status: "todo",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.deleteTask, { taskId, callerOrchestrator: ETA }),
		landed: () => false, // replaced below: a deleted row reads null
	},
	{
		name: "checkout",
		exposed: true,
		status: "todo",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.checkout, { taskId, callerOrchestrator: ETA }),
		landed: (r) => r.status === "in_progress",
	},
	{
		name: "resume",
		exposed: true,
		status: "paused",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.resume, { taskId, callerOrchestrator: ETA }),
		landed: (r) => r.pausedAt === undefined,
	},
	{
		name: "correctSegment",
		exposed: true,
		status: "in_progress",
		call: (t, taskId) =>
			asService(t).mutation(api.tasks.correctSegment, {
				taskId,
				segmentIndex: 0,
				start: Date.now() - 50_000,
				end: Date.now() - 30_000,
				reason: "# blocked-on-nobody: third-party outage typed by the colliding agent",
				callerOrchestrator: ETA,
			}),
		landed: (r) => (r.workSegments?.[0]?.correction ?? undefined) !== undefined,
	},
];

describe("MEASUREMENT: org-a 'eta' (service account, no verified org) vs an org-b 'eta' task", () => {
	for (const c of cases) {
		test(`${c.exposed ? "EXPOSED" : "SAFE"}: ${c.name}`, async () => {
			const { t, id, row } = await setup(c.status);
			let threw: string | null = null;
			try {
				await c.call(t, id);
			} catch (e) {
				threw = e instanceof Error ? e.message.slice(0, 120) : String(e);
			}
			const after = await row();
			const landed = c.name === "deleteTask" ? after === null : after !== null && c.landed(after);
			expect(
				landed,
				`${c.name}: ${c.exposed ? "KNOWN EXPOSURE (unfixed) — flip `exposed` when fixed" : "refused"}${threw ? ` — threw: ${threw}` : ""}`,
			).toBe(c.exposed);
		});
	}
});
