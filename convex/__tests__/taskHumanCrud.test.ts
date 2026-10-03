/// <reference types="vite/client" />
/**
 * convex/__tests__/taskHumanCrud.test.ts
 *
 * Task k1720hwydrrkteacm02ma78j5d8fkpe6 (Admin CRUD B1 — tasks). A human org
 * member creates / updates / pauses / resumes / fails / deletes tasks from the
 * dashboard in its OWN NAME (no callerOrchestrator): own org only, role from the
 * writer-role allowlist (data), actor recorded "user:<Clerk subject>".
 * Subjects are scoped NON-creator members carrying `org_role`, never master.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Caller = ReturnType<T["withIdentity"]>;

const as = (subject: string, role?: string) =>
	({
		subject,
		organizationSlug: "org-a",
		...(role !== undefined ? { org_role: role } : {}),
	}) as Parameters<T["withIdentity"]>[0];

type Seed = "todo" | "in_progress" | "paused";

async function setup() {
	const t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
	});
	return t;
}

async function seedTask(t: T, seed: Seed, orgId: string | null = "org-a") {
	const now = Date.now();
	return await t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title: "Human CRUD seed",
			assignedTo: "sigma",
			priority: "medium",
			status: seed === "in_progress" ? "in_progress" : "todo",
			createdBy: "sigma",
			createdAt: now,
			updatedAt: now,
			...(orgId !== null ? { orgId } : {}),
			...(seed === "in_progress"
				? { startedAt: now, workSegments: [{ start: now }] }
				: {}),
			...(seed === "paused"
				? {
						startedAt: now - 1000,
						pausedAt: now - 500,
						workSegments: [{ start: now - 1000, end: now - 500 }],
					}
				: {}),
		}),
	);
}

type Door = {
	name: string;
	seed: Seed;
	call: (c: Caller, id: Id<"tasks">) => Promise<unknown>;
};

const doors: Door[] = [
	{
		name: "update",
		seed: "todo",
		call: (c, taskId) => c.mutation(api.tasks.update, { taskId, title: "Renamed by the human" }),
	},
	{ name: "pause", seed: "in_progress", call: (c, taskId) => c.mutation(api.tasks.pause, { taskId }) },
	{ name: "resume", seed: "paused", call: (c, taskId) => c.mutation(api.tasks.resume, { taskId }) },
	{
		name: "failTask",
		seed: "in_progress",
		call: (c, taskId) =>
			c.mutation(api.tasks.failTask, { taskId, failureNote: "Abandoned by the human; see PR #1500" }),
	},
	{ name: "deleteTask", seed: "todo", call: (c, taskId) => c.mutation(api.tasks.deleteTask, { taskId }) },
];

async function row(t: T, id: Id<"tasks">) {
	return await t.run(async (ctx) => ctx.db.get(id));
}

describe.each(doors)("human CRUD — $name", (door) => {
	// deleteTask is admin-only; every other door serves any writer role.
	const writer = door.name === "deleteTask" ? "org:admin" : "org:editor";

	test(`${writer} own-org task -> served, actor user:<subject>`, async () => {
		const t = await setup();
		const id = await seedTask(t, door.seed);
		await door.call(t.withIdentity(as("user_m", writer)), id);
		const after = await row(t, id);
		if (door.name === "deleteTask") {
			expect(after).toBeNull();
		} else {
			expect(after?.lastActedBy).toBe("user:user_m");
		}
	});

	test("other-org task -> refused (tenant boundary), untouched", async () => {
		const t = await setup();
		const id = await seedTask(t, door.seed, "org-b");
		await expect(door.call(t.withIdentity(as("user_m", "org:admin")), id)).rejects.toThrow(
			/RBAC_DENIED.*organisation/,
		);
		const after = await row(t, id);
		expect(after).not.toBeNull();
		expect(after?.lastActedBy).toBeUndefined();
	});

	test("unstamped task -> refused, untouched", async () => {
		const t = await setup();
		const id = await seedTask(t, door.seed, null);
		await expect(door.call(t.withIdentity(as("user_m", "org:admin")), id)).rejects.toThrow(
			/RBAC_DENIED/,
		);
		const after = await row(t, id);
		expect(after).not.toBeNull();
		expect(after?.lastActedBy).toBeUndefined();
	});

	test("non-writer role -> refused (role-not-writer), untouched", async () => {
		const t = await setup();
		const id = await seedTask(t, door.seed);
		await expect(door.call(t.withIdentity(as("user_m", "org:viewer")), id)).rejects.toThrow(
			/RBAC_DENIED.*role-not-writer/,
		);
		const after = await row(t, id);
		expect(after).not.toBeNull();
		expect(after?.lastActedBy).toBeUndefined();
	});

	test("no identity -> refused (AUTH_REQUIRED), untouched", async () => {
		const t = await setup();
		const id = await seedTask(t, door.seed);
		await expect(door.call(t as unknown as Caller, id)).rejects.toThrow(/AUTH_REQUIRED/);
		const after = await row(t, id);
		expect(after).not.toBeNull();
		expect(after?.lastActedBy).toBeUndefined();
	});
});

describe("deleteTask — human rule: org:admin only", () => {
	test("org:editor (a writer) -> refused role-not-admin, row survives", async () => {
		const t = await setup();
		const id = await seedTask(t, "todo");
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.tasks.deleteTask, { taskId: id }),
		).rejects.toThrow(/RBAC_DENIED.*role-not-admin/);
		expect(await row(t, id)).not.toBeNull();
	});

	test("org:admin -> deleted, returns { deleted: true }", async () => {
		const t = await setup();
		const id = await seedTask(t, "todo");
		const res = await t
			.withIdentity(as("user_m", "org:admin"))
			.mutation(api.tasks.deleteTask, { taskId: id });
		expect(res).toEqual({ deleted: true });
		expect(await row(t, id)).toBeNull();
	});
});

describe("update — cancel by a human is admin-only and recorded", () => {
	const cancel = (c: Caller, taskId: Id<"tasks">) =>
		c.mutation(api.tasks.update, { taskId, status: "cancelled", cancelReason: "Scope dropped" });

	test("org:editor -> refused role-not-admin", async () => {
		const t = await setup();
		const id = await seedTask(t, "todo");
		await expect(cancel(t.withIdentity(as("user_m", "org:editor")), id)).rejects.toThrow(
			/RBAC_DENIED.*role-not-admin/,
		);
		expect((await row(t, id))?.status).toBe("todo");
	});

	test("org:admin -> cancelled, cancelledBy and lastActedBy user:<subject>", async () => {
		const t = await setup();
		const id = await seedTask(t, "todo");
		await cancel(t.withIdentity(as("user_m", "org:admin")), id);
		const after = await row(t, id);
		expect(after?.status).toBe("cancelled");
		expect(after?.cancelledBy).toBe("user:user_m");
		expect(after?.lastActedBy).toBe("user:user_m");
	});
});

describe("update — assignee must stay on the org roster", () => {
	test("human reassigning to an off-roster name -> refused", async () => {
		const t = await setup();
		const id = await seedTask(t, "todo");
		await expect(
			t
				.withIdentity(as("user_m", "org:editor"))
				.mutation(api.tasks.update, { taskId: id, assignedTo: "eta" }),
		).rejects.toThrow(/RBAC_DENIED|CALLER_IDENTITY_MISMATCH|roster/i);
		expect((await row(t, id))?.assignedTo).toBe("sigma");
	});
});

describe("create — human, no createdBy", () => {
	const args = { title: "Created from the dashboard", assignedTo: "sigma", priority: "medium" as const, status: "todo" as const };

	test("org:editor -> own org stamped from scope, human recorded as user:<subject>", async () => {
		const t = await setup();
		const id = await t.withIdentity(as("user_m", "org:editor")).mutation(api.tasks.create, args);
		const after = await row(t, id);
		expect(after?.orgId).toBe("org-a");
		expect(after?.createdBy).toBe("user:user_m");
		expect(after?.lastActedBy).toBe("user:user_m");
	});

	test("non-writer role -> refused, nothing inserted", async () => {
		const t = await setup();
		await expect(
			t.withIdentity(as("user_m", "org:viewer")).mutation(api.tasks.create, args),
		).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
		expect(await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).length)).toBe(0);
	});

	test("assignee off the org roster -> refused, nothing inserted", async () => {
		const t = await setup();
		await expect(
			t
				.withIdentity(as("user_m", "org:editor"))
				.mutation(api.tasks.create, { ...args, assignedTo: "eta" }),
		).rejects.toThrow(/RBAC_DENIED|CALLER_IDENTITY_MISMATCH|roster/i);
		expect(await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).length)).toBe(0);
	});

	test("no identity -> refused AUTH_REQUIRED", async () => {
		const t = await setup();
		await expect(t.mutation(api.tasks.create, args)).rejects.toThrow(/AUTH_REQUIRED/);
	});

	test("master/service scope without createdBy -> still refused (not the human path)", async () => {
		const t = await setup();
		await expect(
			t
				.withIdentity({ subject: "svc", organizationSlug: "vantage-fleet" } as Parameters<T["withIdentity"]>[0])
				.mutation(api.tasks.create, args),
		).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED/);
	});
});
