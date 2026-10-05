/// <reference types="vite/client" />
/**
 * backend-doctor R-6 (boundary field taken from a caller argument) at three
 * sites: missions:create, recurringTasks:create, tasks:complete.
 *
 * Every caller below is an ORDINARY MEMBER of org-a (never the master or the
 * service account). Each site is pinned both ways: REFUSED (the member steers
 * the boundary toward org-b / another orchestrator and no row is written or
 * changed) and PRESENT (an own-org write succeeds and carries org-a).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const [slug, seats] of [
			["org-a", ["seat-a", "seat-a2"]],
			["org-b", ["seat-b"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [...seats],
				scopes: ["view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

const asOrgA = (t: T) =>
	t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
		org_role: "org:editor",
	} as Parameters<T["withIdentity"]>[0]);

const seedTask = (t: T, orgId: string, createdBy: string, assignedTo: string) =>
	t.run((ctx) =>
		ctx.db.insert("tasks", {
			title: "seed task",
			assignedTo,
			priority: "medium",
			status: "in_progress",
			createdBy,
			isReviewTask: false,
			orgId,
			createdAt: 1,
			updatedAt: 1,
		}),
	);

const NOTE =
	"closed with proof: 12 tests green, commit 0f1bc0240d37e88678424f2d99241055f6d0cd56";

describe("missions:create — orgId and createdBy derive from the verified identity", () => {
	const base = {
		name: "m",
		project: "p",
		status: "plan" as const,
		priority: "medium" as const,
		agents: [] as string[],
	};

	test("REFUSED: a member cannot borrow another org through verifiedPerson", async () => {
		const t = createT();
		await seed(t);
		await expect(
			asOrgA(t).mutation(api.missions.create, {
				...base,
				pilot: "seat-a",
				createdBy: "seat-a",
				verifiedPerson: { accessTokenHash: "token-of-an-org-b-person" },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.query("missions").collect())).toHaveLength(0);
	});

	test("REFUSED: a member cannot author as, or pilot to, org-b's orchestrator", async () => {
		const t = createT();
		await seed(t);
		await expect(
			asOrgA(t).mutation(api.missions.create, { ...base, pilot: "seat-a", createdBy: "seat-b" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			asOrgA(t).mutation(api.missions.create, { ...base, pilot: "seat-b", createdBy: "seat-a" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.query("missions").collect())).toHaveLength(0);
	});

	test("PRESENT: an own-org write succeeds and is stamped org-a", async () => {
		const t = createT();
		await seed(t);
		const id = await asOrgA(t).mutation(api.missions.create, {
			...base,
			pilot: "seat-a",
			createdBy: "seat-a2",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orgId).toBe("org-a");
		expect(row?.createdBy).toBe("seat-a2");
	});
});

describe("recurringTasks:create — orgId derives from the verified identity", () => {
	const base = {
		title: "r",
		priority: "medium" as const,
		cronExpression: "0 9 * * *",
	};

	test("REFUSED: a member cannot author as, or assign to, org-b's orchestrator", async () => {
		const t = createT();
		await seed(t);
		await expect(
			asOrgA(t).mutation(api.recurringTasks.create, {
				...base,
				assignedTo: "seat-a",
				createdBy: "seat-b",
			}),
		).rejects.toThrow(/CALLER_IDENTITY_MISMATCH|RBAC_DENIED/);
		await expect(
			asOrgA(t).mutation(api.recurringTasks.create, {
				...base,
				assignedTo: "seat-b",
				createdBy: "seat-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.query("recurringTasks").collect())).toHaveLength(0);
	});

	test("REFUSED: there is no orgId argument to steer with", async () => {
		const t = createT();
		await seed(t);
		await expect(
			asOrgA(t).mutation(api.recurringTasks.create, {
				...base,
				assignedTo: "seat-a",
				createdBy: "seat-a",
				orgId: "org-b",
			} as never),
		).rejects.toThrow(/orgId|extra field|ArgumentValidation/i);
		expect(await t.run((ctx) => ctx.db.query("recurringTasks").collect())).toHaveLength(0);
	});

	test("PRESENT: an own-org write succeeds and is stamped org-a", async () => {
		const t = createT();
		await seed(t);
		const id = await asOrgA(t).mutation(api.recurringTasks.create, {
			...base,
			assignedTo: "seat-a2",
			createdBy: "seat-a",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orgId).toBe("org-a");
		expect(row?.createdBy).toBe("seat-a");
	});
});

describe("tasks:complete — the target row's own org and creator/assignee decide", () => {
	const unchanged = async (t: T, id: Id<"tasks">) => {
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.status).toBe("in_progress");
		expect(row?.completedAt).toBeUndefined();
	};

	test("REFUSED: org-a member cannot complete an org-b task, even under a colliding seat name", async () => {
		const t = createT();
		await seed(t);
		const id = await seedTask(t, "org-b", "seat-a", "seat-a");
		await expect(
			asOrgA(t).mutation(api.tasks.complete, {
				taskId: id,
				callerOrchestrator: "seat-a",
				completionNote: NOTE,
			}),
		).rejects.toThrow(/RBAC_DENIED|TASK_NOT_FOUND|not found/i);
		await unchanged(t, id);
	});

	test("REFUSED: org-a member cannot assert org-b's orchestrator", async () => {
		const t = createT();
		await seed(t);
		const id = await seedTask(t, "org-b", "seat-b", "seat-b");
		await expect(
			asOrgA(t).mutation(api.tasks.complete, {
				taskId: id,
				callerOrchestrator: "seat-b",
				completionNote: NOTE,
			}),
		).rejects.toThrow(/CALLER_IDENTITY_MISMATCH|RBAC_DENIED/);
		await unchanged(t, id);
	});

	test("REFUSED: a non-creator, non-assignee seat of the same org cannot complete", async () => {
		const t = createT();
		await seed(t);
		const id = await seedTask(t, "org-a", "seat-a", "seat-a");
		await expect(
			asOrgA(t).mutation(api.tasks.complete, {
				taskId: id,
				callerOrchestrator: "seat-a2",
				completionNote: NOTE,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		await unchanged(t, id);
	});

	test("PRESENT: the assignee completes an own-org task; the boundary fields are untouched", async () => {
		const t = createT();
		await seed(t);
		const id = await seedTask(t, "org-a", "seat-a2", "seat-a");
		await asOrgA(t).mutation(api.tasks.complete, {
			taskId: id,
			callerOrchestrator: "seat-a",
			completionNote: NOTE,
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.status).toBe("done");
		expect(row?.orgId).toBe("org-a");
		expect(row?.createdBy).toBe("seat-a2");
		expect(row?.assignedTo).toBe("seat-a");
	});
});
