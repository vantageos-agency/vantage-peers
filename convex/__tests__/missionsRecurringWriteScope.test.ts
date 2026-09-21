/// <reference types="vite/client" />
// allow-missing-refs: new test file to be created
/**
 * missions.{create,update,updateStatus,updateProgress} /
 * recurringTasks.{create,update,pause,resume,remove} — write-scope
 * enforcement.
 *
 * DEFECT (pre-fix, on main): all nine mutations authorized on NOTHING (most
 * of them), or on a bare client-supplied `callerOrchestrator` string
 * argument (missions.update's cancel path) — never a verified identity. A
 * direct call to the public Convex deployment could create/mutate/delete
 * any org's mission or recurring task. This is the class of defect
 * .claude/rules/authority-attached-to-anonymous-object.md describes: a
 * write surface must derive authority from the verified caller
 * (withOrgScope), never trust a client-supplied argument alone.
 *
 * Owner keys:
 *   - missions: STORED `orgId` (Beta multi-tenant scope field, same shape
 *     as #1315 briefingNotes.orgId) — checked via isOrgAllowedForScope.
 *   - recurringTasks: STORED `assignedTo` (no orgId/org-scoping column
 *     exists on this table — see convex/schema.ts) — checked via
 *     isOrchestratorAllowedForScope against the caller's own
 *     client_org_mapping.allowedOrchestrators, the #1313 (messages.ts)
 *     shape.
 *
 * This suite proves all nine mutations now enforce org scope both poles,
 * refuse anonymous callers BEFORE any ctx.db.get (no existence oracle), and
 * resist the M1 (caller-supplied identity field bypass) and D1 (actor-field
 * substitution) mutant shapes. No batch/array-of-ids argument exists on any
 * of these nine mutations, so the M2 ("only the first item in a batch is
 * checked") mutant shape does not apply to this family — noted, not tested.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedOrgBMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-b",
			allowedOrchestrators: ["seat-b"],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: "org-b",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedMission(
	t: ReturnType<typeof createT>,
	orgId: string | undefined,
	pilot: string,
	overrides: { createdBy?: string; status?: "brainstorm" | "plan" | "execute" | "validate" | "complete" | "cancelled" } = {},
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("missions", {
			name: "seed mission",
			project: "vantage-peers",
			status: overrides.status ?? "plan",
			priority: "medium",
			pilot,
			agents: [pilot],
			createdBy: overrides.createdBy ?? pilot,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId,
		});
	});
}

async function seedRecurringTask(
	t: ReturnType<typeof createT>,
	assignedTo: string,
	overrides: { createdBy?: string; active?: boolean } = {},
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("recurringTasks", {
			title: "seed recurring task",
			assignedTo,
			priority: "medium",
			cronExpression: "0 9 * * *",
			nextRunAt: Date.now() + 60_000,
			active: overrides.active ?? true,
			createdBy: overrides.createdBy ?? assignedTo,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// missions.create
// ─────────────────────────────────────────────────────────────────────────────

describe("missions.create — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();

		await expect(
			t.mutation(api.missions.create, {
				name: "anon mission",
				project: "vantage-peers",
				status: "plan",
				priority: "medium",
				pilot: "seat-x",
				agents: ["seat-x"],
				createdBy: "seat-x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const all = await t.run((ctx) => ctx.db.query("missions").collect());
		expect(all).toHaveLength(0);
	});

	test("org-a creating a mission gets orgId forced to its own org", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const missionId = await tA.mutation(api.missions.create, {
			name: "org-a mission",
			project: "vantage-peers",
			status: "plan",
			priority: "medium",
			pilot: "seat-a",
			agents: ["seat-a"],
			createdBy: "seat-a",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.orgId).toBe("org-a");
	});

	test("the master/service-account identity creates a mission with no orgId (legacy/internal)", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const missionId = await tMaster.mutation(api.missions.create, {
			name: "master mission",
			project: "vantage-peers",
			status: "plan",
			priority: "medium",
			pilot: "seat-x",
			agents: ["seat-x"],
			createdBy: "seat-x",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.orgId).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// missions.update
// ─────────────────────────────────────────────────────────────────────────────

describe("missions.update — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused before ctx.db.get (no existence oracle)", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(missionId);
		});

		await expect(
			t.mutation(api.missions.update, {
				missionId,
				priority: "urgent",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to update org-b's mission is refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.update, {
				missionId,
				priority: "urgent",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.priority).toBe("medium");
	});

	// M1 shape: org-a asserts callerOrchestrator EQUAL to org-b's mission's
	// own createdBy value — the exact shape that would pass the OLD (cancel
	// path) `mission.createdBy === callerOrchestrator` check alone. The
	// org-scope check must independently refuse this regardless of what
	// callerOrchestrator equals, and BEFORE the cancel-specific narrowing
	// runs.
	test("org-a cancelling org-b's mission is refused even when callerOrchestrator matches the mission's own createdBy, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const missionId = await seedMission(t, "org-b", "seat-b", { createdBy: "seat-b" });
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.update, {
				missionId,
				status: "cancelled",
				cancelReason: "hijack attempt",
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.status).toBe("plan");
	});

	// D1 shape: the mission's ACTOR field (createdBy) differs from its
	// OWNER field (orgId) — a mutant that checks createdBy instead of the
	// stored orgId would wrongly ALLOW org-a here (createdBy="seat-a") even
	// though the mission's owning org is org-b.
	test("org-a is refused even when the mission's createdBy happens to be an org-a seat, because the owner is orgId not createdBy", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const missionId = await seedMission(t, "org-b", "seat-b", { createdBy: "seat-a" });
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.update, {
				missionId,
				priority: "urgent",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.priority).toBe("medium");
	});

	test("org-a updating its own (org-a-owned) mission succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const missionId = await seedMission(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.missions.update, {
			missionId,
			priority: "urgent",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.priority).toBe("urgent");
	});

	test("the master/service-account identity updates any org's mission", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.missions.update, {
			missionId,
			priority: "urgent",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.priority).toBe("urgent");
	});

	// update's args never include `orgId` — an org caller cannot move a
	// mission into another org's scope via the patch, by construction.
	test("org-a updating its own mission cannot move it into another org's scope — orgId is unaffected by the patch", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const missionId = await seedMission(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.missions.update, {
			missionId,
			name: "retitled",
			description: "rewritten",
			priority: "low",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.orgId).toBe("org-a");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// missions.updateStatus
// ─────────────────────────────────────────────────────────────────────────────

describe("missions.updateStatus — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused before ctx.db.get (no existence oracle)", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(missionId);
		});

		await expect(
			t.mutation(api.missions.updateStatus, {
				missionId,
				status: "execute",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to update org-b's mission status is refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.updateStatus, {
				missionId,
				status: "execute",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.status).toBe("plan");
	});

	test("org-a updating its own mission's status succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const missionId = await seedMission(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.missions.updateStatus, {
			missionId,
			status: "execute",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.status).toBe("execute");
	});

	test("the master/service-account identity updates any org's mission status", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.missions.updateStatus, {
			missionId,
			status: "execute",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.status).toBe("execute");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// missions.updateProgress
// ─────────────────────────────────────────────────────────────────────────────

describe("missions.updateProgress — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused before ctx.db.get (no existence oracle)", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(missionId);
		});

		await expect(
			t.mutation(api.missions.updateProgress, {
				missionId,
				progress: 50,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to update org-b's mission progress is refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.updateProgress, {
				missionId,
				progress: 50,
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.progress).toBeUndefined();
	});

	test("org-a updating its own mission's progress succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const missionId = await seedMission(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.missions.updateProgress, {
			missionId,
			progress: 75,
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.progress).toBe(75);
	});

	test("the master/service-account identity updates any org's mission progress", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.missions.updateProgress, {
			missionId,
			progress: 90,
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.progress).toBe(90);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// recurringTasks.create
// ─────────────────────────────────────────────────────────────────────────────

describe("recurringTasks.create — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();

		await expect(
			t.mutation(api.recurringTasks.create, {
				title: "anon recurring task",
				assignedTo: "seat-x",
				priority: "medium",
				cronExpression: "0 9 * * *",
				createdBy: "seat-x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const all = await t.run((ctx) => ctx.db.query("recurringTasks").collect());
		expect(all).toHaveLength(0);
	});

	test("org-a creating a recurring task assigned OUTSIDE its own org is refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.create, {
				title: "cross-org recurring task",
				assignedTo: "seat-b",
				priority: "medium",
				cronExpression: "0 9 * * *",
				createdBy: "seat-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const all = await t.run((ctx) => ctx.db.query("recurringTasks").collect());
		expect(all).toHaveLength(0);
	});

	test("org-a creating a recurring task assigned to its own seat succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const taskId = await tA.mutation(api.recurringTasks.create, {
			title: "org-a recurring task",
			assignedTo: "seat-a",
			priority: "medium",
			cronExpression: "0 9 * * *",
			createdBy: "seat-a",
		});

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.assignedTo).toBe("seat-a");
	});

	test("the master/service-account identity creates a recurring task for any assignee", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const taskId = await tMaster.mutation(api.recurringTasks.create, {
			title: "master recurring task",
			assignedTo: "seat-x",
			priority: "medium",
			cronExpression: "0 9 * * *",
			createdBy: "seat-x",
		});

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.assignedTo).toBe("seat-x");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// recurringTasks.update
// ─────────────────────────────────────────────────────────────────────────────

describe("recurringTasks.update — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused before ctx.db.get (no existence oracle)", async () => {
		const t = createT();
		const taskId = await seedRecurringTask(t, "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(taskId);
		});

		await expect(
			t.mutation(api.recurringTasks.update, {
				recurringTaskId: taskId,
				priority: "high",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to update org-b's recurring task is refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const taskId = await seedRecurringTask(t, "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.update, {
				recurringTaskId: taskId,
				priority: "high",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.priority).toBe("medium");
	});

	// M1 shape: org-a submits a patch that does NOT touch assignedTo (so the
	// only caller-supplied "identity field" in this mutation is absent) —
	// the stored existing.assignedTo (never anything caller-supplied) must
	// still be what is checked. A mutant that fell back to trusting an
	// absent/undefined args.assignedTo as "no owner to check" would wrongly
	// allow this.
	test("org-a trying to update org-b's recurring task without touching assignedTo is still refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const taskId = await seedRecurringTask(t, "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.update, {
				recurringTaskId: taskId,
				title: "hijacked title",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.title).toBe("seed recurring task");
	});

	// D1 shape: the task's ACTOR field (createdBy) differs from its OWNER
	// field (assignedTo) — a mutant that checked createdBy instead of the
	// stored assignedTo would wrongly ALLOW org-a here (createdBy="seat-a")
	// even though the task is assigned to org-b's seat.
	test("org-a is refused even when the task's createdBy happens to be an org-a seat, because the owner is assignedTo not createdBy", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const taskId = await seedRecurringTask(t, "seat-b", { createdBy: "seat-a" });
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.update, {
				recurringTaskId: taskId,
				priority: "high",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.priority).toBe("medium");
	});

	// A patch REASSIGNING the task must never move it into another org's
	// scope: even though org-a owns the task, reassigning it to seat-b
	// (outside org-a's own allowedOrchestrators) is refused.
	test("org-a reassigning its own recurring task to a seat outside its scope is refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const taskId = await seedRecurringTask(t, "seat-a");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.update, {
				recurringTaskId: taskId,
				assignedTo: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.assignedTo).toBe("seat-a");
	});

	test("org-a updating its own recurring task succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const taskId = await seedRecurringTask(t, "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.recurringTasks.update, {
			recurringTaskId: taskId,
			priority: "high",
		});

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.priority).toBe("high");
	});

	test("the master/service-account identity updates any org's recurring task", async () => {
		const t = createT();
		const taskId = await seedRecurringTask(t, "seat-b");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.recurringTasks.update, {
			recurringTaskId: taskId,
			priority: "high",
		});

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.priority).toBe("high");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// recurringTasks.pause
// ─────────────────────────────────────────────────────────────────────────────

describe("recurringTasks.pause — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused before ctx.db.get (no existence oracle)", async () => {
		const t = createT();
		const taskId = await seedRecurringTask(t, "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(taskId);
		});

		await expect(
			t.mutation(api.recurringTasks.pause, { taskId }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to pause org-b's recurring task is refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const taskId = await seedRecurringTask(t, "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.pause, { taskId }),
		).rejects.toThrow(/RBAC_DENIED/);

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.active).toBe(true);
	});

	test("org-a pausing its own recurring task succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const taskId = await seedRecurringTask(t, "seat-a");
		const tA = asOrgA(t);

		const result = await tA.mutation(api.recurringTasks.pause, { taskId });
		expect(result.active).toBe(false);
	});

	test("the master/service-account identity pauses any org's recurring task", async () => {
		const t = createT();
		const taskId = await seedRecurringTask(t, "seat-b");
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.recurringTasks.pause, { taskId });
		expect(result.active).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// recurringTasks.resume
// ─────────────────────────────────────────────────────────────────────────────

describe("recurringTasks.resume — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused before ctx.db.get (no existence oracle)", async () => {
		const t = createT();
		const taskId = await seedRecurringTask(t, "seat-b", { active: false });
		await t.run(async (ctx) => {
			await ctx.db.delete(taskId);
		});

		await expect(
			t.mutation(api.recurringTasks.resume, { taskId }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to resume org-b's recurring task is refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const taskId = await seedRecurringTask(t, "seat-b", { active: false });
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.resume, { taskId }),
		).rejects.toThrow(/RBAC_DENIED/);

		const task = await t.run((ctx) => ctx.db.get(taskId));
		expect(task?.active).toBe(false);
	});

	test("org-a resuming its own recurring task succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const taskId = await seedRecurringTask(t, "seat-a", { active: false });
		const tA = asOrgA(t);

		const result = await tA.mutation(api.recurringTasks.resume, { taskId });
		expect(result.active).toBe(true);
	});

	test("the master/service-account identity resumes any org's recurring task", async () => {
		const t = createT();
		const taskId = await seedRecurringTask(t, "seat-b", { active: false });
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.recurringTasks.resume, { taskId });
		expect(result.active).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// recurringTasks.remove
// ─────────────────────────────────────────────────────────────────────────────

describe("recurringTasks.remove — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused before ctx.db.get (no existence oracle)", async () => {
		const t = createT();
		const taskId = await seedRecurringTask(t, "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(taskId);
		});

		await expect(
			t.mutation(api.recurringTasks.remove, { taskId }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to delete org-b's recurring task is refused, database unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const taskId = await seedRecurringTask(t, "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.remove, { taskId }),
		).rejects.toThrow(/RBAC_DENIED/);

		expect(await t.run((ctx) => ctx.db.get(taskId))).not.toBeNull();
	});

	test("org-a deleting its own recurring task succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const taskId = await seedRecurringTask(t, "seat-a");
		const tA = asOrgA(t);

		const result = await tA.mutation(api.recurringTasks.remove, { taskId });
		expect(result.deleted).toBe(true);
		expect(await t.run((ctx) => ctx.db.get(taskId))).toBeNull();
	});

	test("the master/service-account identity deletes any org's recurring task", async () => {
		const t = createT();
		const taskId = await seedRecurringTask(t, "seat-b");
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.recurringTasks.remove, { taskId });
		expect(result.deleted).toBe(true);
	});
});
