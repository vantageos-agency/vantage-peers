/// <reference types="vite/client" />
/**
 * org-a "eta" vs an org-b task that names an org-b "eta", through the ten
 * single-task service-account doors (complete, update, start, pause, resume,
 * blockTask, failTask, deleteTask, checkout, correctSegment).
 *
 * Through MCP every call reaches Convex as the fleet service account (master
 * scope), so the row-level tenant gate does not narrow and the creator/assignee
 * check compares NAMES, which collide across organisations. The door therefore
 * takes `verifiedOrg` (the org the MCP transport verified for the bearer,
 * convex/lib/verifiedOrg.ts) and refuses a target row whose org differs.
 *
 * POLES (per door)
 *   REFUSED   verifiedOrg org-a, org-b row    -> RBAC_DENIED, the row byte-unchanged
 *   PRESENT   verifiedOrg org-a, org-a row    -> the write lands
 *   MASTER    no verifiedOrg (fleet master)   -> today's behaviour, unchanged
 *   UNTRUSTED an org member passing verifiedOrg -> RBAC_DENIED, never ignored
 *   UNKNOWN   an unmapped / deactivated org   -> RBAC_DENIED, nothing written
 *   UNSTAMPED a row stating no org            -> refused (never equals an org)
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
type Caller = ReturnType<T["withIdentity"]>;
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

async function setup(
	status: "todo" | "in_progress" | "paused" = "in_progress",
) {
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
	call: (
		t: Caller,
		taskId: Id<"tasks">,
		extra: Record<string, unknown>,
	) => Promise<unknown>;
	landed: (
		r: NonNullable<
			Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["row"]>>
		>,
	) => boolean;
}

const cases: Case[] = [
	{
		name: "complete",
		status: "in_progress",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.complete, {
				taskId,
				...extra,
				completionNote: "closing, evidence abc1234 and more words here",
				callerOrchestrator: ETA,
			}),
		landed: (r) => r.status === "done",
	},
	{
		name: "update",
		status: "todo",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.update, {
				taskId,
				...extra,
				title: "HIJACKED",
				callerOrchestrator: ETA,
			}),
		landed: (r) => r.title === "HIJACKED",
	},
	{
		name: "start",
		status: "todo",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.start, {
				taskId,
				callerOrchestrator: ETA,
				...extra,
			}),
		landed: (r) => r.status === "in_progress",
	},
	{
		name: "pause",
		status: "in_progress",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.pause, {
				taskId,
				callerOrchestrator: ETA,
				...extra,
			}),
		landed: (r) => r.pausedAt !== undefined,
	},
	{
		name: "blockTask",
		status: "in_progress",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.blockTask, {
				taskId,
				...extra,
				callerOrchestrator: ETA,
				reason:
					"# blocked-on-nobody: third-party outage typed by the colliding agent",
			}),
		landed: (r) => r.status === "blocked",
	},
	{
		name: "failTask",
		status: "in_progress",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.failTask, {
				taskId,
				...extra,
				callerOrchestrator: ETA,
				failureNote: "failing it, evidence abc1234 and more words here",
			}),
		landed: (r) => r.status === "failed",
	},
	{
		name: "deleteTask",
		status: "todo",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.deleteTask, {
				taskId,
				callerOrchestrator: ETA,
				...extra,
			}),
		landed: () => false, // replaced below: a deleted row reads null
	},
	{
		name: "checkout",
		status: "todo",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.checkout, {
				taskId,
				callerOrchestrator: ETA,
				...extra,
			}),
		landed: (r) => r.status === "in_progress",
	},
	{
		name: "resume",
		status: "paused",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.resume, {
				taskId,
				callerOrchestrator: ETA,
				...extra,
			}),
		landed: (r) => r.pausedAt === undefined,
	},
	{
		name: "correctSegment",
		status: "in_progress",
		call: (t, taskId, extra) =>
			t.mutation(api.tasks.correctSegment, {
				taskId,
				...extra,
				segmentIndex: 0,
				start: Date.now() - 50_000,
				end: Date.now() - 30_000,
				reason:
					"# blocked-on-nobody: third-party outage typed by the colliding agent",
				callerOrchestrator: ETA,
			}),
		landed: (r) => (r.workSegments?.[0]?.correction ?? undefined) !== undefined,
	},
];

const A = { verifiedOrg: { orgSlug: "org-a" } };

type Row = NonNullable<
	Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["row"]>>
>;
const didLand = (c: Case, after: Row | null): boolean =>
	c.name === "deleteTask" ? after === null : after !== null && c.landed(after);

async function setupOwn(status: Case["status"]) {
	const s = await setup(status);
	await s.t.run((ctx) => ctx.db.patch(s.id, { orgId: "org-a" }));
	return s;
}

describe("org-a 'eta' vs an org-b 'eta' task, per door", () => {
	for (const c of cases) {
		describe(c.name, () => {
			test("REFUSED: verifiedOrg org-a on an org-b row is RBAC_DENIED and the row is untouched", async () => {
				const { t, id, row } = await setup(c.status);
				const before = JSON.stringify(await row());
				const err = await c.call(asService(t), id, A).then(
					() => null,
					(e: Error) => e,
				);
				expect(err, `${c.name} must refuse`).not.toBeNull();
				expect(
					`${(err as Error).message} ${JSON.stringify((err as { data?: unknown }).data ?? "")}`,
				).toContain("RBAC_DENIED");
				expect(JSON.stringify(await row())).toBe(before);
				expect(didLand(c, await row())).toBe(false);
			});

			test("PRESENT: verifiedOrg org-a on an org-a row lands", async () => {
				const { t, id, row } = await setupOwn(c.status);
				await c.call(asService(t), id, A);
				expect(didLand(c, await row())).toBe(true);
			});

			test("MASTER: no verifiedOrg keeps today's behaviour (service account reaches any tenant)", async () => {
				const { t, id, row } = await setup(c.status);
				await c.call(asService(t), id, {});
				expect(didLand(c, await row())).toBe(true);
			});

			test("UNTRUSTED: an org member passing verifiedOrg is refused, not ignored", async () => {
				const { t, id, row } = await setupOwn(c.status);
				const before = JSON.stringify(await row());
				const member = t.withIdentity({
					subject: "member-a",
					org_slug: "org-a",
					org_role: "org:admin",
				} as Identity);
				const err = await c.call(member as unknown as T, id, A).then(
					() => null,
					(e: Error) => e,
				);
				expect(err).not.toBeNull();
				expect(
					`${(err as Error).message} ${JSON.stringify((err as { data?: unknown }).data ?? "")}`,
				).toContain("verified-org-not-trusted");
				expect(JSON.stringify(await row())).toBe(before);
			});

			test("UNKNOWN: an unmapped org and a deactivated org are refused, nothing written", async () => {
				const { t, id, row } = await setupOwn(c.status);
				const before = JSON.stringify(await row());
				const ghost = await c
					.call(t, id, { verifiedOrg: { orgSlug: "org-nowhere" } })
					.then(
						() => null,
						(e: Error) => e,
					);
				expect(ghost).not.toBeNull();
				await t.run(async (ctx) => {
					const m = await ctx.db
						.query("client_org_mapping")
						.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-a"))
						.unique();
					if (m) await ctx.db.patch(m._id, { isActive: false });
				});
				const off = await c.call(asService(t), id, A).then(
					() => null,
					(e: Error) => e,
				);
				expect(off).not.toBeNull();
				expect(JSON.stringify(await row())).toBe(before);
			});

			test("UNSTAMPED: a row stating no org is refused for a verified org", async () => {
				const { t, id, row } = await setupOwn(c.status);
				await t.run(async (ctx) => {
					await ctx.db.patch(id, { orgId: undefined });
				});
				const before = JSON.stringify(await row());
				const err = await c.call(asService(t), id, A).then(
					() => null,
					(e: Error) => e,
				);
				expect(err).not.toBeNull();
				expect(JSON.stringify(await row())).toBe(before);
			});
		});
	}
});
