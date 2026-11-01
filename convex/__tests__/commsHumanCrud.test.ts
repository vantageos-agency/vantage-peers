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

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { seedAgents } from "../../tests/lib/agentIdOf";
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
		org_id: testClerkOrgId("org-a"),
		...(role !== undefined ? { org_role: role } : {}),
	}) as Parameters<T["withIdentity"]>[0];

const ANY_CALLER = /RBAC_DENIED/;

async function setup() {
	const t = createT();
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			clerkOrgId: testClerkOrgId("org-a"),
			allowedOrchestrators: ["sigma", "pi"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: now,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-b",
			clerkOrgId: testClerkOrgId("org-b"),
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
			...(owner === "own" ? { tenantId: "org-a", tenantOrgId: testClerkOrgId("org-a") } : {}),
			...(owner === "other" ? { tenantId: "org-b", tenantOrgId: testClerkOrgId("org-b") } : {}),
		});
		await ctx.db.insert("messageReceipts", {
			messageId: id,
			recipient: "sigma",
			readAt: undefined,
			...(owner === "own" ? { tenantId: "org-a", tenantOrgId: testClerkOrgId("org-a") } : {}),
		});
		return id;
	});
}

/** roster-keyed rows (diary, business unit): own = sigma (org-a roster), other = eta (org-b), unowned = nobody's. */
const ownerName = (owner: Owner) =>
	owner === "own" ? "sigma" : owner === "other" ? "eta" : "ghost";

async function seedDiary(t: T, owner: Owner) {
	// The diary judges the seat by agent ID, so org-a's "sigma" is registered
	// here and only here: a task door that finds a registered agent behind an
	// asserted name requires its credential.
	if (owner === "own") await t.run((ctx) => seedRosterAgent(ctx, "org-a", "sigma"));
	return await t.run(async (ctx) =>
		ctx.db.insert("diary", {
			date: "2026-10-01",
			orchestrator: ownerName(owner),
			content: "seed",
			createdAt: Date.now(),
			...(owner === "own" ? { orgId: "org-a", clerkOrgId: testClerkOrgId("org-a") } : {}),
			...(owner === "other" ? { orgId: "org-b", clerkOrgId: testClerkOrgId("org-b") } : {}),
		}),
	);
}

async function seedBu(t: T, owner: Owner) {
	const now = Date.now();
	return await t.run(async (ctx) => {
		// Since M10f a business unit's owner is an agents-row ID of its own org
		// (registered only here: a registered agent acting elsewhere in this file
		// would owe a per-agent credential).
		const agentOf = async (orgSlug: string, name: string) =>
			(
				await ctx.db
					.query("agents")
					.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
					.collect()
			).find((a) => a.name === name)?._id ??
			(await seedRosterAgent(ctx, orgSlug, name));
		const ownerId =
			owner === "own"
				? await agentOf("org-a", "sigma")
				: owner === "other"
					? await agentOf("org-b", "eta")
					: undefined;
		return ctx.db.insert("businessUnits", {
			...(ownerId !== undefined ? { ownerId } : {}),
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
			...(owner === "own" ? { orgId: "org-a", clerkOrgId: testClerkOrgId("org-a") } : {}),
			...(owner === "other" ? { orgId: "org-b", clerkOrgId: testClerkOrgId("org-b") } : {}),
		});
	});
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
			...(owner === "own" ? { orgId: "org-a", clerkOrgId: testClerkOrgId("org-a") } : {}),
			...(owner === "other" ? { orgId: "org-b", clerkOrgId: testClerkOrgId("org-b") } : {}),
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
		name: "recurringTasks:update",
		adminOnly: false,
		seed: (t, o) => seedRecurring(t, o),
		call: (c, id) => c.mutation(api.recurringTasks.update, { recurringTaskId: id, title: "Renamed by the human" }),
		read: readRow("recurringTasks"),
		served: (_b, a) => a?.title === "Renamed by the human",
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
				t.withIdentity({ subject: "svc", organizationSlug: "vantage-fleet", org_id: testClerkOrgId("vantage-fleet") } as Parameters<T["withIdentity"]>[0]),
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


// ── diary and businessUnits: the human path (residues of B2) ────────────────
// Both tables are stamped with the owning org's permanent ID, so a human org
// member acts on its OWN org's rows in its own name: diary:write needs a writer
// role; diary:deleteDiary and businessUnits:remove need org:admin;
// businessUnits:update (callerOrchestrator now optional) needs a writer role.
// Another org (even one holding the same roster label) and unstamped rows are
// refused. The agent / fleet service-account paths are unchanged.

describe("human CRUD — diary and businessUnits", () => {
	const master = (t: T) =>
		t.withIdentity({ subject: "test-service-account-user-id" } as Parameters<T["withIdentity"]>[0]);
	const inOrg = (t: T, orgSlug: string, subject: string, role?: string) =>
		t.withIdentity({
			subject,
			organizationSlug: orgSlug,
			org_id: testClerkOrgId(orgSlug),
			...(role !== undefined ? { org_role: role } : {}),
		} as Parameters<T["withIdentity"]>[0]);
	const addOrgC = (t: T) =>
		t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-c",
				clerkOrgId: testClerkOrgId("org-c"),
				allowedOrchestrators: ["sigma"], // the SAME roster name as org-a's
				scopes: ["view-own-tasks"],
				displayName: "org-c",
				isActive: true,
				createdAt: Date.now(),
			});
			await seedRosterAgent(ctx, "org-c", "sigma");
		});
	const diaryArgs = { date: "2026-10-02", orchestrator: "sigma", content: "human entry" };

	describe("diary:write", () => {
		test.each(["org:admin", "org:editor"])("%s of the owning org writes its seat's entry, authored by the person", async (role) => {
			const t = await setup();
			await t.run((ctx) => seedRosterAgent(ctx, "org-a", "sigma"));
			const id = await inOrg(t, "org-a", "user_m", role).mutation(api.diary.write, diaryArgs);
			const row = await readRow("diary")(t, id);
			expect(row?.content).toBe("human entry");
			expect(row?.createdBy).toBe("user:user_m");
		});

		test.each([["org:viewer"], [undefined]])("role %s -> refused role-not-writer, nothing written", async (role) => {
			const t = await setup();
			await t.run((ctx) => seedRosterAgent(ctx, "org-a", "sigma"));
			await expect(
				inOrg(t, "org-a", "user_v", role).mutation(api.diary.write, diaryArgs),
			).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
			expect(await count(t, "diary")).toBe(0);
		});

		test("an editor of ANOTHER org naming org-a's seat -> refused, nothing written", async () => {
			const t = await setup();
			await t.run((ctx) => seedRosterAgent(ctx, "org-a", "sigma"));
			await expect(
				inOrg(t, "org-b", "user_b", "org:editor").mutation(api.diary.write, diaryArgs),
			).rejects.toThrow(ANY_CALLER);
			expect(await count(t, "diary")).toBe(0);
		});

		test("the fleet service account is still served", async () => {
			const t = await setup();
			await master(t).mutation(api.diary.write, diaryArgs);
			expect(await count(t, "diary")).toBe(1);
		});
	});

	describe("diary:deleteDiary", () => {
		const del = (c: Caller, id: string, callerOrchestrator?: string) =>
			c.mutation(api.diary.deleteDiary, {
				diaryId: id as Id<"diary">,
				...(callerOrchestrator !== undefined ? { callerOrchestrator } : {}),
			});

		test("org:admin of the owning org deletes in its own name", async () => {
			const t = await setup();
			const id = await seedDiary(t, "own");
			expect(await del(inOrg(t, "org-a", "user_m", "org:admin"), id)).toEqual({ deleted: true });
			expect(await readRow("diary")(t, id)).toBeNull();
		});

		test("org:editor -> refused role-not-admin, org:viewer -> refused role-not-writer, row survives", async () => {
			const t = await setup();
			const id = await seedDiary(t, "own");
			await expect(del(inOrg(t, "org-a", "user_m", "org:editor"), id)).rejects.toThrow(/RBAC_DENIED.*role-not-admin/);
			await expect(del(inOrg(t, "org-a", "user_v", "org:viewer"), id)).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
			expect(await readRow("diary")(t, id)).not.toBeNull();
		});

		test("an admin of ANOTHER org, of a COLLIDING org, and any admin on an unstamped row -> refused, row survives", async () => {
			const t = await setup();
			await addOrgC(t);
			const own = await seedDiary(t, "own");
			const unowned = await seedDiary(t, "unowned");
			await expect(del(inOrg(t, "org-b", "user_b", "org:admin"), own)).rejects.toThrow(ANY_CALLER);
			await expect(del(inOrg(t, "org-c", "user_c", "org:admin"), own)).rejects.toThrow(ANY_CALLER);
			await expect(del(inOrg(t, "org-a", "user_m", "org:admin"), unowned)).rejects.toThrow(ANY_CALLER);
			expect(await readRow("diary")(t, own)).not.toBeNull();
			expect(await readRow("diary")(t, unowned)).not.toBeNull();
		});

		test("no identity -> refused", async () => {
			const t = await setup();
			const id = await seedDiary(t, "own");
			await expect(del(t as unknown as Caller, id)).rejects.toThrow(ANY_CALLER);
			expect(await readRow("diary")(t, id)).not.toBeNull();
		});

		test("a session typing the owner's name: a viewer is refused role-not-writer, a writer is served", async () => {
			const t = await setup();
			const id = await seedDiary(t, "own");
			await expect(del(inOrg(t, "org-a", "user_v", "org:viewer"), id, "sigma")).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
			expect(await readRow("diary")(t, id)).not.toBeNull();
			expect(await del(inOrg(t, "org-a", "user_m", "org:editor"), id, "sigma")).toEqual({ deleted: true });
		});

		test("the fleet service account naming the owner is still served", async () => {
			const t = await setup();
			const id = await seedDiary(t, "own");
			await del(master(t), id, "sigma");
			expect(await readRow("diary")(t, id)).toBeNull();
		});
	});

	describe("businessUnits:remove", () => {
		const rm = (c: Caller, id: string) =>
			c.mutation(api.businessUnits.remove, { buId: id as Id<"businessUnits"> });

		test("org:admin of the owning org deletes its unit", async () => {
			const t = await setup();
			const id = await seedBu(t, "own");
			expect(await rm(inOrg(t, "org-a", "user_m", "org:admin"), id)).toEqual({ deleted: true });
			expect(await readRow("businessUnits")(t, id)).toBeNull();
		});

		test("org:editor -> role-not-admin, org:viewer -> role-not-writer, row survives", async () => {
			const t = await setup();
			const id = await seedBu(t, "own");
			await expect(rm(inOrg(t, "org-a", "user_m", "org:editor"), id)).rejects.toThrow(/RBAC_DENIED.*role-not-admin/);
			await expect(rm(inOrg(t, "org-a", "user_v", "org:viewer"), id)).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
			expect(await readRow("businessUnits")(t, id)).not.toBeNull();
		});

		test("an admin of ANOTHER org, of a COLLIDING org, and any admin on an unstamped unit -> refused, row survives", async () => {
			const t = await setup();
			await addOrgC(t);
			const own = await seedBu(t, "own");
			const unowned = await seedBu(t, "unowned");
			await expect(rm(inOrg(t, "org-b", "user_b", "org:admin"), own)).rejects.toThrow(/RBAC_DENIED.*row-not-in-caller-org/);
			await expect(rm(inOrg(t, "org-c", "user_c", "org:admin"), own)).rejects.toThrow(/RBAC_DENIED.*row-not-in-caller-org/);
			await expect(rm(inOrg(t, "org-a", "user_m", "org:admin"), unowned)).rejects.toThrow(/RBAC_DENIED/);
			expect(await readRow("businessUnits")(t, own)).not.toBeNull();
			expect(await readRow("businessUnits")(t, unowned)).not.toBeNull();
		});

		test("no identity -> refused", async () => {
			const t = await setup();
			const id = await seedBu(t, "own");
			await expect(rm(t as unknown as Caller, id)).rejects.toThrow(ANY_CALLER);
			expect(await readRow("businessUnits")(t, id)).not.toBeNull();
		});

		test("the fleet service account naming the verified org is still served", async () => {
			const t = await setup();
			const id = await seedBu(t, "own");
			await master(t).mutation(api.businessUnits.remove, {
				buId: id,
				verifiedOrg: { orgSlug: "org-a" },
			});
			expect(await readRow("businessUnits")(t, id)).toBeNull();
		});
	});

	describe("businessUnits:update with no callerOrchestrator", () => {
		const upd = (c: Caller, id: string, name = "Renamed") =>
			c.mutation(api.businessUnits.update, { buId: id as Id<"businessUnits">, name });

		test.each(["org:admin", "org:editor"])("%s of the owning org renames its unit in its own name", async (role) => {
			const t = await setup();
			const id = await seedBu(t, "own");
			await upd(inOrg(t, "org-a", "user_m", role), id);
			expect((await readRow("businessUnits")(t, id))?.name).toBe("Renamed");
		});

		test("a member judges its own org's unit, not an owner it never claimed: a unit of its org with no stored owner is renamed", async () => {
			const t = await setup();
			const id = await seedBu(t, "own");
			await t.run((ctx) => ctx.db.patch(id as Id<"businessUnits">, { ownerId: undefined }));
			await upd(inOrg(t, "org-a", "user_m", "org:editor"), id);
			expect((await readRow("businessUnits")(t, id))?.name).toBe("Renamed");
		});

		test.each([["org:viewer"], [undefined]])("role %s -> refused role-not-writer, unit unchanged", async (role) => {
			const t = await setup();
			const id = await seedBu(t, "own");
			await expect(upd(inOrg(t, "org-a", "user_v", role), id)).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
			expect((await readRow("businessUnits")(t, id))?.name).toBe("BU seed");
		});

		test("an editor of ANOTHER org, of a COLLIDING org, and any editor on an unstamped unit -> refused, unit unchanged", async () => {
			const t = await setup();
			await addOrgC(t);
			const own = await seedBu(t, "own");
			const unowned = await seedBu(t, "unowned");
			await expect(upd(inOrg(t, "org-b", "user_b", "org:editor"), own)).rejects.toThrow(/RBAC_DENIED.*row-not-in-caller-org/);
			await expect(upd(inOrg(t, "org-c", "user_c", "org:editor"), own)).rejects.toThrow(/RBAC_DENIED.*row-not-in-caller-org/);
			await expect(upd(inOrg(t, "org-a", "user_m", "org:editor"), unowned)).rejects.toThrow(/RBAC_DENIED/);
			expect((await readRow("businessUnits")(t, own))?.name).toBe("BU seed");
			expect((await readRow("businessUnits")(t, unowned))?.name).toBe("BU seed");
		});

		test("no identity -> refused; the fleet service account must still name an owner", async () => {
			const t = await setup();
			const id = await seedBu(t, "own");
			await expect(upd(t as unknown as Caller, id)).rejects.toThrow(ANY_CALLER);
			await expect(upd(master(t), id)).rejects.toThrow(/RBAC_DENIED.*caller-orchestrator-required/);
			expect((await readRow("businessUnits")(t, id))?.name).toBe("BU seed");
		});
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
		// M1: the org-a roster is stored BY ID; a broadcast fans out to these agents
		// (seeded here only: as agent rows they would need a credential to SEND).
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-a"))
				.unique();
			const ids = [];
			for (const name of ["sigma", "pi"]) {
				ids.push(
					await ctx.db.insert("agents", {
						orgSlug: "org-a",
						clerkOrgId: testClerkOrgId("org-a"),
						name,
						normalizedName: name,
						isActive: true,
						createdAt: Date.now(),
					}),
				);
			}
			if (row) await ctx.db.patch(row._id, { allowedAgentIds: ids });
		});
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
				.withIdentity({ subject: "svc", organizationSlug: "vantage-fleet", org_id: testClerkOrgId("vantage-fleet") } as Parameters<T["withIdentity"]>[0])
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

	// M10h: the assignee is an agent of the org (resolved by ID).
	const setupWithAssignee = async () => {
		const t = await setup();
		await seedAgents(t, [["org-a", "sigma"]]);
		return t;
	};

	test("org:editor -> own org stamped from scope, createdBy user:<subject>", async () => {
		const t = await setupWithAssignee();
		const id = await t.withIdentity(as("user_m", "org:editor")).mutation(api.recurringTasks.create, args);
		const row = await readRow("recurringTasks")(t, id);
		expect(row?.orgId).toBe("org-a");
		expect(row?.createdBy).toBe("user:user_m");
	});

	test("the cron materialises the human's schedule into the SAME org, authored by the human", async () => {
		const t = await setupWithAssignee();
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
				.withIdentity({ subject: "svc", organizationSlug: "vantage-fleet", org_id: testClerkOrgId("vantage-fleet") } as Parameters<T["withIdentity"]>[0])
				.mutation(api.recurringTasks.create, args),
		).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED|Forbidden/);
		expect(await count(t, "recurringTasks")).toBe(0);
	});

	test("agent path unchanged: createdBy on the roster is served as that label", async () => {
		const t = await setupWithAssignee();
		// "pi" is on the roster and registered as no agent: the label is recorded, no ID guessed.
		const id = await t
			.withIdentity(as("user_m", "org:editor"))
			.mutation(api.recurringTasks.create, { ...args, createdBy: "pi" });
		const row = await readRow("recurringTasks")(t, id);
		expect(row?.createdBy).toBe("pi");
		expect(row?.createdById).toBeUndefined();
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
			.withIdentity(as("user_m", "org:editor"))
			.mutation(api.diary.deleteDiary, { diaryId: id, callerOrchestrator: "sigma" });
		expect(res).toEqual({ deleted: true });
	});

	test("businessUnits:update — the fleet naming the owning orchestrator updates", async () => {
		const t = await setup();
		const id = await seedBu(t, "own");
		await t
			.withIdentity({ subject: "test-service-account-user-id" } as Parameters<T["withIdentity"]>[0])
			.mutation(api.businessUnits.update, { buId: id, callerOrchestrator: "sigma", name: "By the agent" });
		expect((await readRow("businessUnits")(t, id))?.name).toBe("By the agent");
	});

	test("businessUnits:update — a writer-role member naming the owning orchestrator updates; a viewer is refused", async () => {
		const t = await setup();
		const id = await seedBu(t, "own");
		await expect(
			t
				.withIdentity(as("user_v", "org:viewer"))
				.mutation(api.businessUnits.update, { buId: id, callerOrchestrator: "sigma", name: "By a viewer" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await t
			.withIdentity(as("user_m", "org:editor"))
			.mutation(api.businessUnits.update, { buId: id, callerOrchestrator: "sigma", name: "By an editor" });
		expect((await readRow("businessUnits")(t, id))?.name).toBe("By an editor");
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
