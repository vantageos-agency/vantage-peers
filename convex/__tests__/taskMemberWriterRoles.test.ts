/// <reference types="vite/client" />
/**
 * convex/__tests__/taskMemberWriterRoles.test.ts
 *
 * Task k170hs77p7me28wr7xfqgntm0x8fkzxc — Pi ruling: on the member-acting path
 * (tasks.start / complete / blockTask with no callerOrchestrator) write access
 * is granted by an ALLOWLIST OF WRITER ROLES HELD AS DATA (`memberWriterRoles`).
 * Subjects are scoped NON-creator members carrying `org_role`, never master.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
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

const NOTE =
	"Closed by the member from the dashboard; evidence: 3 files, see qa/report.md and PR #1500";
const NOBODY = "# blocked-on-nobody: waiting on the operator's decision";

type Door = {
	name: "start" | "complete" | "blockTask";
	seedStatus: "todo" | "in_progress";
	call: (c: Caller, taskId: Id<"tasks">) => Promise<unknown>;
};

const doors: Door[] = [
	{
		name: "start",
		seedStatus: "todo",
		call: (c, taskId) => c.mutation(api.tasks.start, { taskId }),
	},
	{
		name: "complete",
		seedStatus: "in_progress",
		call: (c, taskId) =>
			c.mutation(api.tasks.complete, { taskId, completionNote: NOTE }),
	},
	{
		name: "blockTask",
		seedStatus: "in_progress",
		call: (c, taskId) =>
			c.mutation(api.tasks.blockTask, { taskId, reason: NOBODY }),
	},
];

async function setup(defaultRoles: string[] | null = ["org:admin", "org:editor"]) {
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
		if (defaultRoles !== null) {
			await ctx.db.insert("memberWriterRoles", {
				roles: defaultRoles,
				updatedAt: Date.now(),
			});
		}
	});
	return t;
}

async function seedTask(t: T, status: "todo" | "in_progress") {
	return await t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title: "Writer-role seed",
			assignedTo: "sigma",
			priority: "medium",
			status,
			createdBy: "sigma",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId: "org-a",
			...(status === "in_progress"
				? { startedAt: Date.now(), workSegments: [{ start: Date.now() }] }
				: {}),
		}),
	);
}

async function untouched(t: T, id: Id<"tasks">, door: Door) {
	const row = await t.run(async (ctx) => ctx.db.get(id));
	expect(row?.lastActedBy).toBeUndefined();
	expect(row?.status).toBe(door.seedStatus);
}

describe.each(doors)("writer roles — $name", (door) => {
	test.each(["org:admin", "org:editor"])("%s (listed) -> allowed", async (role) => {
		const t = await setup();
		const id = await seedTask(t, door.seedStatus);
		await door.call(t.withIdentity(as("user_m", role)), id);
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.lastActedBy).toBe("user:user_m");
	});

	test("org:viewer (unknown role) -> refused, coded, names the role", async () => {
		const t = await setup();
		const id = await seedTask(t, door.seedStatus);
		await expect(
			door.call(t.withIdentity(as("user_m", "org:viewer")), id),
		).rejects.toThrow(/RBAC_DENIED.*role-not-writer.*org:viewer/);
		await untouched(t, id, door);
	});

	test("no role claim -> refused", async () => {
		const t = await setup();
		const id = await seedTask(t, door.seedStatus);
		await expect(
			door.call(t.withIdentity(as("user_m")), id),
		).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
		await untouched(t, id, door);
	});

	test("list changed in DATA (editor removed) -> editor refused, admin still served", async () => {
		const t = await setup();
		await t.mutation(internal.memberWriterRoles.setMemberWriterRoles, {
			roles: ["org:admin"],
		});
		const id = await seedTask(t, door.seedStatus);
		await expect(
			door.call(t.withIdentity(as("user_m", "org:editor")), id),
		).rejects.toThrow(/role-not-writer.*org:editor/);
		await untouched(t, id, door);
		await door.call(t.withIdentity(as("user_m", "org:admin")), id);
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.lastActedBy).toBe("user:user_m");
	});

	test("per-org row overrides the fleet default (viewer added for org-a only)", async () => {
		const t = await setup();
		await t.mutation(internal.memberWriterRoles.setMemberWriterRoles, {
			orgSlug: "org-a",
			roles: ["org:viewer"],
		});
		const id = await seedTask(t, door.seedStatus);
		await expect(
			door.call(t.withIdentity(as("user_m", "org:editor")), id),
		).rejects.toThrow(/role-not-writer/);
		await door.call(t.withIdentity(as("user_m", "org:viewer")), id);
	});

	test("empty fleet list -> refused (fail closed, not allow-all)", async () => {
		const t = await setup([]);
		const id = await seedTask(t, door.seedStatus);
		await expect(
			door.call(t.withIdentity(as("user_m", "org:admin")), id),
		).rejects.toThrow(/role-not-writer/);
		await untouched(t, id, door);
	});

	test("empty per-org list wins over a populated default -> refused", async () => {
		const t = await setup();
		await t.mutation(internal.memberWriterRoles.setMemberWriterRoles, {
			orgSlug: "org-a",
			roles: [],
		});
		const id = await seedTask(t, door.seedStatus);
		await expect(
			door.call(t.withIdentity(as("user_m", "org:admin")), id),
		).rejects.toThrow(/role-not-writer/);
	});

	test("no list anywhere (table empty) -> refused", async () => {
		const t = await setup(null);
		const id = await seedTask(t, door.seedStatus);
		await expect(
			door.call(t.withIdentity(as("user_m", "org:admin")), id),
		).rejects.toThrow(/role-not-writer/);
		await untouched(t, id, door);
	});

	test("agent path unchanged: no role needed when callerOrchestrator is named", async () => {
		const t = await setup(null);
		const id = await seedTask(t, door.seedStatus);
		const c = t.withIdentity(as("user_proxy"));
		if (door.name === "start")
			await c.mutation(api.tasks.start, { taskId: id, callerOrchestrator: "sigma" });
		else if (door.name === "complete")
			await c.mutation(api.tasks.complete, {
				taskId: id,
				callerOrchestrator: "sigma",
				completionNote: NOTE,
			});
		else
			await c.mutation(api.tasks.blockTask, {
				taskId: id,
				callerOrchestrator: "sigma",
				reason: NOBODY,
			});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.lastActedBy).toBeUndefined();
	});
});

describe("setMemberWriterRoles", () => {
	test("rejects a blank role key", async () => {
		const t = await setup(null);
		await expect(
			t.mutation(internal.memberWriterRoles.setMemberWriterRoles, {
				roles: [" "],
			}),
		).rejects.toThrow(/INVALID_ROLE/);
	});
});
