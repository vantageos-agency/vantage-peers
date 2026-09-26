/// <reference types="vite/client" />
/**
 * recurringTasks.create / recurringTasks.update / recurringTasks.pause /
 * recurringTasks.resume / recurringTasks.remove — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): all five mutations took NO caller-identity
 * check of any kind — any caller holding the deployment URL could create,
 * reassign, pause, resume or hard-delete ANY recurring-task template. This
 * is the class of defect
 * .claude/rules/authority-attached-to-anonymous-object.md describes: a
 * write surface must derive authority from the verified caller, never
 * nothing at all.
 *
 * `recurringTasks` carries no `orgId` column (a cron-config table, not a
 * per-org data table — see convex/schema.ts's doc comment), so the fix
 * reuses convex/tasks.ts's exported `requireAuthenticatedCaller` — the SAME
 * resolver tasks.ts's own nine public mutations already use — rather than
 * writing a second one. create/update additionally derive ownership from
 * the row's STORED `assignedTo` field against the caller's verified
 * `allowedOrchestrators` (mirroring `filterByOrgScope`'s read-time
 * membership test); pause/resume/remove require the verified MASTER scope,
 * mirroring the MCP server's own pre-existing master-only tool guards on
 * these three operations.
 *
 * This suite proves all five mutations now enforce that identity, both
 * poles, on an ordinary (non-master) identity plus the fleet's
 * master/service-account carve-out.
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
			scopes: ["view-own-tasks"],
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
			scopes: ["view-own-tasks"],
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

async function seedRecurringTask(
	t: ReturnType<typeof createT>,
	assignedTo: string,
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("recurringTasks", {
			title: "seed recurring task",
			assignedTo,
			priority: "medium",
			cronExpression: "0 9 * * *",
			nextRunAt: Date.now() + 60_000,
			active: true,
			createdBy: assignedTo,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe("recurringTasks.create — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();

		await expect(
			t.mutation(api.recurringTasks.create, {
				title: "anon recurring",
				assignedTo: "seat-x",
				priority: "medium",
				cronExpression: "0 9 * * *",
				createdBy: "seat-x",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const all = await t.run((ctx) => ctx.db.query("recurringTasks").collect());
		expect(all).toHaveLength(0);
	});

	test("org-a trying to create a recurring task assigned to org-b's seat is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.create, {
				title: "cross-org recurring",
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

		const id = await tA.mutation(api.recurringTasks.create, {
			title: "org-a recurring",
			assignedTo: "seat-a",
			priority: "medium",
			cronExpression: "0 9 * * *",
			createdBy: "seat-a",
		});

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.assignedTo).toBe("seat-a");
	});

	test("the master/service-account identity may create a recurring task for any assignee", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const id = await tMaster.mutation(api.recurringTasks.create, {
			title: "master recurring",
			assignedTo: "seat-x",
			priority: "medium",
			cronExpression: "0 9 * * *",
			createdBy: "alpha",
		});

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.assignedTo).toBe("seat-x");
	});
});

describe("recurringTasks.update — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const id = await seedRecurringTask(t, "seat-b");

		await expect(
			t.mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				title: "hijacked",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.title).toBe("seed recurring task");
	});

	test("org-a trying to update org-b's recurring task is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const id = await seedRecurringTask(t, "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				title: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.title).toBe("seed recurring task");
	});

	test("org-a trying to reassign its own recurring task to org-b's seat is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const id = await seedRecurringTask(t, "seat-a");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				assignedTo: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.assignedTo).toBe("seat-a");
	});

	test("org-a updating its own recurring task succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const id = await seedRecurringTask(t, "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.recurringTasks.update, {
			recurringTaskId: id,
			title: "updated by owner",
		});

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.title).toBe("updated by owner");
	});

	test("the master/service-account identity updates any org's recurring task", async () => {
		const t = createT();
		const id = await seedRecurringTask(t, "seat-b");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.recurringTasks.update, {
			recurringTaskId: id,
			title: "updated by master",
		});

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.title).toBe("updated by master");
	});

	// Anonymous-oracle proof: the identity check must run BEFORE requireId /
	// ctx.db.get, so an anonymous caller gets AUTH_REQUIRED even for a
	// non-existent recurringTaskId — never "Recurring task not found".
	test("an anonymous update on a non-existent recurringTaskId is refused with AUTH_REQUIRED, not 'not found'", async () => {
		const t = createT();
		const id = await seedRecurringTask(t, "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(id);
		});

		await expect(
			t.mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				title: "hijacked",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);
	});
});

describe("recurringTasks.pause — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const id = await seedRecurringTask(t, "seat-b");

		await expect(
			t.mutation(api.recurringTasks.pause, { taskId: id }),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.active).toBe(true);
	});

	// Master-only: an ordinary (non-master) org identity is refused even for
	// its OWN recurring task — pause/resume/remove are cron-infrastructure
	// operations, mirroring the MCP server's own master-only tool guard.
	test("an ordinary org-a identity (not master) is refused, even for its own recurring task", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const id = await seedRecurringTask(t, "seat-a");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.pause, { taskId: id }),
		).rejects.toThrow(/RBAC_DENIED/);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.active).toBe(true);
	});

	test("the master/service-account identity may pause any recurring task", async () => {
		const t = createT();
		const id = await seedRecurringTask(t, "seat-b");
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.recurringTasks.pause, {
			taskId: id,
		});
		expect(result.active).toBe(false);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.active).toBe(false);
	});
});

describe("recurringTasks.resume — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const id = await seedRecurringTask(t, "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { active: false });
		});

		await expect(
			t.mutation(api.recurringTasks.resume, { taskId: id }),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.active).toBe(false);
	});

	test("an ordinary org-a identity (not master) is refused, even for its own recurring task", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const id = await seedRecurringTask(t, "seat-a");
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { active: false });
		});
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.resume, { taskId: id }),
		).rejects.toThrow(/RBAC_DENIED/);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.active).toBe(false);
	});

	test("the master/service-account identity may resume any recurring task", async () => {
		const t = createT();
		const id = await seedRecurringTask(t, "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { active: false });
		});
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.recurringTasks.resume, {
			taskId: id,
		});
		expect(result.active).toBe(true);

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.active).toBe(true);
	});
});

describe("recurringTasks.remove — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const id = await seedRecurringTask(t, "seat-b");

		await expect(
			t.mutation(api.recurringTasks.remove, { taskId: id }),
		).rejects.toThrow(/AUTH_REQUIRED/);

		expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
	});

	test("an ordinary org-a identity (not master) is refused, even for its own recurring task", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const id = await seedRecurringTask(t, "seat-a");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.recurringTasks.remove, { taskId: id }),
		).rejects.toThrow(/RBAC_DENIED/);

		expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
	});

	test("the master/service-account identity may remove any recurring task", async () => {
		const t = createT();
		const id = await seedRecurringTask(t, "seat-b");
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.recurringTasks.remove, {
			taskId: id,
		});
		expect(result.deleted).toBe(true);

		expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
	});
});
