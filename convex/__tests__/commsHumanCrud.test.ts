/// <reference types="vite/client" />
/**
 * convex/__tests__/commsHumanCrud.test.ts
 *
 * Task k17d5k5bw741p3681bc0pq76ah8fk4sn (Admin CRUD B2, slice B — messages,
 * diary, business units, recurring tasks). A human org member acts on its OWN
 * organisation's rows from the dashboard IN ITS OWN NAME (no caller-orchestrator
 * argument): own org only, write access from the writer-role allowlist (data),
 * destructive acts org:admin only, actor "user:<Clerk subject>".
 *
 * Per door the poles are: writer served (+ actor recorded where the row has a
 * column for it), other-org refused, unowned/unstamped refused, non-writer
 * refused, no identity refused, destructive: editor refused / admin served,
 * agent path unchanged.
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

const ANY_CALLER = /RBAC_DENIED/;

async function setup() {
	const t = createT();
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["sigma", "pi"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: now,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-b",
			allowedOrchestrators: ["eta"],
			scopes: ["view-own-tasks"],
			displayName: "org-b",
			isActive: true,
			createdAt: now,
		});
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		for (const orchestratorId of ["sigma", "pi", "eta"]) {
			await ctx.db.insert("profiles", {
				orchestratorId,
				name: orchestratorId,
				static: { role: orchestratorId, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 1 },
			});
		}
	});
	return t;
}

const count = (t: T, table: "messages" | "diary" | "businessUnits" | "recurringTasks" | "messageReceipts") =>
	t.run(async (ctx) => (await ctx.db.query(table).collect()).length);

// ── seeds ───────────────────────────────────────────────────────────────────

type Owner = "own" | "other" | "unowned";

/** message tenant: own org-a, other org-b, unstamped (no tenantId). */
async function seedMessage(t: T, owner: Owner) {
	return await t.run(async (ctx) => {
		const id = await ctx.db.insert("messages", {
			from: "sigma",
			channel: "sigma",
			content: "seed",
			createdAt: Date.now(),
			...(owner === "own" ? { tenantId: "org-a" } : {}),
			...(owner === "other" ? { tenantId: "org-b" } : {}),
		});
		await ctx.db.insert("messageReceipts", {
			messageId: id,
			recipient: "sigma",
			readAt: undefined,
			...(owner === "own" ? { tenantId: "org-a" } : {}),
		});
		return id;
	});
}

/** roster-keyed rows (diary, business unit): own = sigma (org-a roster), other = eta (org-b), unowned = nobody's. */
const ownerName = (owner: Owner) =>
	owner === "own" ? "sigma" : owner === "other" ? "eta" : "ghost";

async function seedDiary(t: T, owner: Owner) {
	return await t.run(async (ctx) =>
		ctx.db.insert("diary", {
			date: "2026-10-01",
			orchestrator: ownerName(owner),
			content: "seed",
			createdAt: Date.now(),
		}),
	);
}

async function seedBu(t: T, owner: Owner) {
	const now = Date.now();
	return await t.run(async (ctx) =>
		ctx.db.insert("businessUnits", {
			name: "BU seed",
			description: "d",
			purpose: "p",
			orchestratorId: ownerName(owner),
			status: "idea",
			businessModel: "m",
			targetCustomers: "c",
			services: [],
			pricing: "p",
			revenueProjections: { y1: 0, y2: 0, y3: 0 },
			coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
			coreProcesses: [],
			dependencies: [],
			kpis: [],
			managementFee: 10,
			createdAt: now,
			updatedAt: now,
		}),
	);
}

async function seedRecurring(t: T, owner: Owner, active = true) {
	const now = Date.now();
	return await t.run(async (ctx) =>
		ctx.db.insert("recurringTasks", {
			title: "Weekly seed",
			assignedTo: "sigma",
			priority: "medium",
			cronExpression: "0 9 * * *",
			nextRunAt: now + 3_600_000,
			active,
			createdBy: "sigma",
			createdAt: now,
			updatedAt: now,
			...(owner === "own" ? { orgId: "org-a" } : {}),
			...(owner === "other" ? { orgId: "org-b" } : {}),
		}),
	);
}

// ── the destructive / mutating row doors ────────────────────────────────────

type RowDoor = {
	name: string;
	/** true: org:admin only; false: any writer role. */
	adminOnly: boolean;
	seed: (t: T, owner: Owner) => Promise<string>;
	call: (c: Caller, id: string) => Promise<unknown>;
	/** the row after the call, null if deleted. */
	read: (t: T, id: string) => Promise<Record<string, unknown> | null>;
	/** a state change visible on the row proving the door ran. */
	served: (before: Record<string, unknown>, after: Record<string, unknown> | null) => boolean;
	/** the actor, when the row has a column to record it. */
	actor?: (row: Record<string, unknown> | null) => unknown;
};

const readRow = (table: "messages" | "diary" | "businessUnits" | "recurringTasks") => (t: T, id: string) =>
	t.run(async (ctx) => (await ctx.db.get(id as Id<typeof table>)) as Record<string, unknown> | null);

const rowDoors: RowDoor[] = [
	{
		name: "messages:deleteMessage",
		adminOnly: true,
		seed: (t, o) => seedMessage(t, o),
		call: (c, id) => c.mutation(api.messages.deleteMessage, { messageId: id as Id<"messages"> }),
		read: readRow("messages"),
		served: (_b, a) => a === null,
	},
	{
		name: "diary:deleteDiary",
		adminOnly: true,
		seed: (t, o) => seedDiary(t, o),
		call: (c, id) => c.mutation(api.diary.deleteDiary, { diaryId: id as Id<"diary"> }),
		read: readRow("diary"),
		served: (_b, a) => a === null,
	},
	{
		name: "businessUnits:update",
		adminOnly: false,
		seed: (t, o) => seedBu(t, o),
		call: (c, id) =>
			c.mutation(api.businessUnits.update, { buId: id as Id<"businessUnits">, name: "Renamed by the human" }),
		read: readRow("businessUnits"),
		served: (_b, a) => a?.name === "Renamed by the human",
	},
	{
		name: "businessUnits:remove",
		adminOnly: true,
		seed: (t, o) => seedBu(t, o),
		call: (c, id) => c.mutation(api.businessUnits.remove, { buId: id as Id<"businessUnits"> }),
		read: readRow("businessUnits"),
		served: (_b, a) => a === null,
	},
	{
		name: "recurringTasks:pause",
		adminOnly: false,
		seed: (t, o) => seedRecurring(t, o, true),
		call: (c, id) => c.mutation(api.recurringTasks.pause, { taskId: id }),
		read: readRow("recurringTasks"),
		served: (_b, a) => a?.active === false,
	},
	{
		name: "recurringTasks:resume",
		adminOnly: false,
		seed: (t, o) => seedRecurring(t, o, false),
		call: (c, id) => c.mutation(api.recurringTasks.resume, { taskId: id }),
		read: readRow("recurringTasks"),
		served: (_b, a) => a?.active === true,
	},
	{
		name: "recurringTasks:remove",
		adminOnly: true,
		seed: (t, o) => seedRecurring(t, o),
		call: (c, id) => c.mutation(api.recurringTasks.remove, { taskId: id }),
		read: readRow("recurringTasks"),
		served: (_b, a) => a === null,
	},
];

describe.each(rowDoors)("human CRUD — $name", (door) => {
	const writer = door.adminOnly ? "org:admin" : "org:editor";

	test(`${writer} own-org row -> served`, async () => {
		const t = await setup();
		const id = await door.seed(t, "own");
		const before = (await door.read(t, id)) as Record<string, unknown>;
		await door.call(t.withIdentity(as("user_m", writer)), id);
		expect(door.served(before, await door.read(t, id))).toBe(true);
	});

	test("other-org row -> refused, untouched", async () => {
		const t = await setup();
		const id = await door.seed(t, "other");
		const before = await door.read(t, id);
		await expect(door.call(t.withIdentity(as("user_m", "org:admin")), id)).rejects.toThrow(ANY_CALLER);
		expect(await door.read(t, id)).toEqual(before);
	});

	test("unstamped / unowned row -> refused, untouched", async () => {
		const t = await setup();
		const id = await door.seed(t, "unowned");
		const before = await door.read(t, id);
		await expect(door.call(t.withIdentity(as("user_m", "org:admin")), id)).rejects.toThrow(ANY_CALLER);
		expect(await door.read(t, id)).toEqual(before);
	});

	test("non-writer role -> refused (role-not-writer), untouched", async () => {
		const t = await setup();
		const id = await door.seed(t, "own");
		const before = await door.read(t, id);
		await expect(door.call(t.withIdentity(as("user_m", "org:viewer")), id)).rejects.toThrow(
			/RBAC_DENIED.*role-not-writer/,
		);
		expect(await door.read(t, id)).toEqual(before);
	});

	test("no role claim -> refused, untouched", async () => {
		const t = await setup();
		const id = await door.seed(t, "own");
		const before = await door.read(t, id);
		await expect(door.call(t.withIdentity(as("user_m")), id)).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
		expect(await door.read(t, id)).toEqual(before);
	});

	test("no identity -> refused, untouched", async () => {
		const t = await setup();
		const id = await door.seed(t, "own");
		const before = await door.read(t, id);
		await expect(door.call(t as unknown as Caller, id)).rejects.toThrow(/AUTH_REQUIRED|RBAC_DENIED/);
		expect(await door.read(t, id)).toEqual(before);
	});

	test("fleet service account with no caller name -> still refused (not the human path)", async () => {
		const t = await setup();
		const id = await door.seed(t, "own");
		const before = await door.read(t, id);
		// An org-less identity that is not the registered service account resolves to
		// no organisation: refused, never treated as a human.
		await expect(
			door.call(
				t.withIdentity({ subject: "svc", organizationSlug: "vantage-fleet" } as Parameters<T["withIdentity"]>[0]),
				id,
			),
		).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED|Forbidden/);
		expect(await door.read(t, id)).toEqual(before);
	});

	if (door.adminOnly) {
		test("org:editor (a writer) -> refused role-not-admin, row survives", async () => {
			const t = await setup();
			const id = await door.seed(t, "own");
			await expect(door.call(t.withIdentity(as("user_m", "org:editor")), id)).rejects.toThrow(
				/RBAC_DENIED.*role-not-admin/,
			);
			expect(await door.read(t, id)).not.toBeNull();
		});
	}
});


describe("human CRUD — businessUnits:update reassignment", () => {
	test("reassigning to an orchestrator outside the org roster -> refused, owner unchanged", async () => {
		const t = await setup();
		const id = await seedBu(t, "own");
		await expect(
			t
				.withIdentity(as("user_m", "org:editor"))
				.mutation(api.businessUnits.update, { buId: id, orchestratorId: "eta" }),
		).rejects.toThrow(/RBAC_DENIED.*reassign/);
		expect((await readRow("businessUnits")(t, id))?.orchestratorId).toBe("sigma");
	});

	test("reassigning to another orchestrator on the roster -> served", async () => {
		const t = await setup();
		const id = await seedBu(t, "own");
		await t
			.withIdentity(as("user_m", "org:editor"))
			.mutation(api.businessUnits.update, { buId: id, orchestratorId: "pi" });
		expect((await readRow("businessUnits")(t, id))?.orchestratorId).toBe("pi");
	});
});

// ── messages:sendMessage ────────────────────────────────────────────────────

describe("human CRUD — messages:sendMessage", () => {
	const args = { channel: "sigma", content: "Hello from the dashboard" };

	test("org:editor -> sent as user:<subject>, tenant from scope, receipts on the org roster", async () => {
		const t = await setup();
		const id = await t.withIdentity(as("user_m", "org:editor")).mutation(api.messages.sendMessage, args);
		const row = await readRow("messages")(t, id);
		expect(row?.from).toBe("user:user_m");
		expect(row?.tenantId).toBe("org-a");
		expect(await count(t, "messageReceipts")).toBe(1);
	});

	test("a supplied foreign tenantId is overridden by the verified org", async () => {
		const t = await setup();
		const id = await t
			.withIdentity(as("user_m", "org:editor"))
			.mutation(api.messages.sendMessage, { ...args, tenantId: "org-b" });
		expect((await readRow("messages")(t, id))?.tenantId).toBe("org-a");
	});

	test("recipient outside the org roster -> refused, nothing inserted", async () => {
		const t = await setup();
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.messages.sendMessage, { ...args, channel: "eta" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await count(t, "messages")).toBe(0);
		expect(await count(t, "messageReceipts")).toBe(0);
	});

	test("a list with one off-roster recipient -> refused whole, nothing inserted", async () => {
		const t = await setup();
		await expect(
			t
				.withIdentity(as("user_m", "org:editor"))
				.mutation(api.messages.sendMessage, { ...args, channel: "sigma,eta" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await count(t, "messages")).toBe(0);
	});

	test("broadcast -> served, fan-out bounded to the org roster", async () => {
		const t = await setup();
		await t.withIdentity(as("user_m", "org:editor")).mutation(api.messages.sendMessage, { ...args, channel: "broadcast" });
		const receipts = await t.run(async (ctx) => await ctx.db.query("messageReceipts").collect());
		expect(receipts.map((r) => r.recipient).sort()).toEqual(["pi", "sigma"]);
	});

	test("non-writer role -> refused role-not-writer, nothing inserted", async () => {
		const t = await setup();
		await expect(
			t.withIdentity(as("user_m", "org:viewer")).mutation(api.messages.sendMessage, args),
		).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
		expect(await count(t, "messages")).toBe(0);
	});

	test("no identity -> refused, nothing inserted", async () => {
		const t = await setup();
		await expect(t.mutation(api.messages.sendMessage, args)).rejects.toThrow(/AUTH_REQUIRED|RBAC_DENIED|Unauthenticated/);
		expect(await count(t, "messages")).toBe(0);
	});

	test("a human cannot label the message with an agent instance, nor carry an agent credential", async () => {
		const t = await setup();
		const c = t.withIdentity(as("user_m", "org:editor"));
		await expect(
			c.mutation(api.messages.sendMessage, { ...args, fromInstanceId: "sigma-vps" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			c.mutation(api.messages.sendMessage, { ...args, agentCredentialSecret: "anything" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await count(t, "messages")).toBe(0);
	});

	test("fleet service account with no sender -> refused (not the human path)", async () => {
		const t = await setup();
		await expect(
			t
				.withIdentity({ subject: "svc", organizationSlug: "vantage-fleet" } as Parameters<T["withIdentity"]>[0])
				.mutation(api.messages.sendMessage, args),
		).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED|Forbidden/);
		expect(await count(t, "messages")).toBe(0);
	});

	test("agent path unchanged: a roster sender with `from` is served as that sender", async () => {
		const t = await setup();
		const id = await t
			.withIdentity(as("user_m", "org:editor"))
			.mutation(api.messages.sendMessage, { ...args, channel: "pi", from: "sigma" });
		expect((await readRow("messages")(t, id))?.from).toBe("sigma");
	});

	test("agent path unchanged: a sender off the roster is still refused", async () => {
		const t = await setup();
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.messages.sendMessage, { ...args, from: "eta" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

// ── recurringTasks:create ───────────────────────────────────────────────────

describe("human CRUD — recurringTasks:create", () => {
	const args = {
		title: "Weekly from the dashboard",
		assignedTo: "sigma",
		priority: "medium" as const,
		cronExpression: "0 9 * * *",
	};

	test("org:editor -> own org stamped from scope, createdBy user:<subject>", async () => {
		const t = await setup();
		const id = await t.withIdentity(as("user_m", "org:editor")).mutation(api.recurringTasks.create, args);
		const row = await readRow("recurringTasks")(t, id);
		expect(row?.orgId).toBe("org-a");
		expect(row?.createdBy).toBe("user:user_m");
	});

	test("the cron materialises the human's schedule into the SAME org, authored by the human", async () => {
		const t = await setup();
		const id = await t.withIdentity(as("user_m", "org:editor")).mutation(api.recurringTasks.create, args);
		await t.run(async (ctx) => ctx.db.patch(id as Id<"recurringTasks">, { nextRunAt: Date.now() - 1000 }));
		const res = await t.mutation(internal.recurringTasks.processDueTasks, {});
		expect(res).toEqual({ created: 1, failed: 0 });
		const tasks = await t.run(async (ctx) => await ctx.db.query("tasks").collect());
		expect(tasks).toHaveLength(1);
		expect(tasks[0].orgId).toBe("org-a");
		expect(tasks[0].createdBy).toBe("user:user_m");
		expect(tasks[0].assignedTo).toBe("sigma");
	});

	test("assignee off the org roster -> refused, nothing inserted", async () => {
		const t = await setup();
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.recurringTasks.create, { ...args, assignedTo: "eta" }),
		).rejects.toThrow(/RBAC_DENIED|CALLER_IDENTITY_MISMATCH|roster/i);
		expect(await count(t, "recurringTasks")).toBe(0);
	});

	test("non-writer role -> refused role-not-writer, nothing inserted", async () => {
		const t = await setup();
		await expect(
			t.withIdentity(as("user_m", "org:viewer")).mutation(api.recurringTasks.create, args),
		).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
		expect(await count(t, "recurringTasks")).toBe(0);
	});

	test("no identity -> refused AUTH_REQUIRED", async () => {
		const t = await setup();
		await expect(t.mutation(api.recurringTasks.create, args)).rejects.toThrow(/AUTH_REQUIRED/);
	});

	test("fleet service account with no createdBy -> refused (not the human path)", async () => {
		const t = await setup();
		await expect(
			t
				.withIdentity({ subject: "svc", organizationSlug: "vantage-fleet" } as Parameters<T["withIdentity"]>[0])
				.mutation(api.recurringTasks.create, args),
		).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED|Forbidden/);
		expect(await count(t, "recurringTasks")).toBe(0);
	});

	test("agent path unchanged: createdBy on the roster is served as that agent", async () => {
		const t = await setup();
		const id = await t
			.withIdentity(as("user_m", "org:editor"))
			.mutation(api.recurringTasks.create, { ...args, createdBy: "sigma" });
		expect((await readRow("recurringTasks")(t, id))?.createdBy).toBe("sigma");
	});
});

// ── agent / master paths unchanged on the row doors ─────────────────────────

describe("agent and master paths unchanged", () => {
	test("messages:deleteMessage — sender with callerOrchestrator deletes its own org's message", async () => {
		const t = await setup();
		const id = await seedMessage(t, "own");
		const res = await t
			.withIdentity(as("user_m", "org:viewer"))
			.mutation(api.messages.deleteMessage, { messageId: id, callerOrchestrator: "sigma" });
		expect(res).toEqual({ deleted: true, receiptsDeleted: 1 });
	});

	test("diary:deleteDiary — owner with callerOrchestrator deletes its entry", async () => {
		const t = await setup();
		const id = await seedDiary(t, "own");
		const res = await t
			.withIdentity(as("user_m", "org:viewer"))
			.mutation(api.diary.deleteDiary, { diaryId: id, callerOrchestrator: "sigma" });
		expect(res).toEqual({ deleted: true });
	});

	test("businessUnits:update — owning orchestrator with callerOrchestrator updates", async () => {
		const t = await setup();
		const id = await seedBu(t, "own");
		await t
			.withIdentity(as("user_m", "org:viewer"))
			.mutation(api.businessUnits.update, { buId: id, callerOrchestrator: "sigma", name: "By the agent" });
		expect((await readRow("businessUnits")(t, id))?.name).toBe("By the agent");
	});

	test("businessUnits:update — agent claiming an orchestrator that does not own the row is refused", async () => {
		const t = await setup();
		const id = await seedBu(t, "own");
		await expect(
			t
				.withIdentity(as("user_m", "org:viewer"))
				.mutation(api.businessUnits.update, { buId: id, callerOrchestrator: "eta", name: "x" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("recurringTasks:pause — an org-scoped agent token with no role claim is still refused (master-only)", async () => {
		const t = await setup();
		const id = await seedRecurring(t, "own");
		await expect(
			t.withIdentity(as("agent_token")).mutation(api.recurringTasks.pause, { taskId: id }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await readRow("recurringTasks")(t, id))?.active).toBe(true);
	});
});
