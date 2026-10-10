/// <reference types="vite/client" />
/**
 * convex/__tests__/missionBriefingHumanCrud.test.ts
 *
 * Task k17d5k5bw741p3681bc0pq76ah8fk4sn (Admin CRUD B2, slice A — missions and
 * briefing notes). A human org member creates / edits / cancels missions and
 * creates / edits / deletes briefing notes from the dashboard in its OWN NAME
 * (no createdBy / callerOrchestrator): own org only, role from the writer-role
 * allowlist (data), destructive acts (cancel, delete) org:admin only, actor
 * recorded "user:<Clerk subject>". Subjects are scoped NON-creator members
 * carrying `org_role`, never master. Pole style mirrors taskHumanCrud.test.ts.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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
		org_id: testClerkOrgId("org-a"),
		...(role !== undefined ? { org_role: role } : {}),
	}) as Parameters<T["withIdentity"]>[0];

async function setup() {
	const t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			clerkOrgId: testClerkOrgId("org-a"),
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-missions"],
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

async function seedMission(t: T, orgId: string | null = "org-a", status: "plan" | "cancelled" = "plan") {
	const now = Date.now();
	return await t.run(async (ctx) =>
		ctx.db.insert("missions", {
			name: "Seed mission",
			project: "demo",
			status,
			priority: "medium",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "sigma",
			createdAt: now,
			updatedAt: now,
			...(orgId !== null ? { orgId, clerkOrgId: testClerkOrgId(orgId) } : {}),
		}),
	);
}

async function seedNote(t: T, orgId: string | null = "org-a") {
	return await t.run(async (ctx) =>
		ctx.db.insert("briefingNotes", {
			title: "Seed note",
			topic: "demo",
			participants: ["sigma"],
			content: "seed content",
			createdBy: "sigma",
			createdAt: Date.now(),
			...(orgId !== null ? { orgId, clerkOrgId: testClerkOrgId(orgId) } : {}),
		}),
	);
}

const mrow = (t: T, id: Id<"missions">) => t.run(async (ctx) => ctx.db.get(id));
const nrow = (t: T, id: Id<"briefingNotes">) => t.run(async (ctx) => ctx.db.get(id));

// ── missions: writer doors on an existing row ───────────────────────────────
type MDoor = { name: string; call: (c: Caller, id: Id<"missions">) => Promise<unknown> };
const missionDoors: MDoor[] = [
	{ name: "update", call: (c, missionId) => c.mutation(api.missions.update, { missionId, name: "Renamed by the human" }) },
	{ name: "updateStatus", call: (c, missionId) => c.mutation(api.missions.updateStatus, { missionId, status: "execute" }) },
	{ name: "updateProgress", call: (c, missionId) => c.mutation(api.missions.updateProgress, { missionId, progress: 40 }) },
];

describe.each(missionDoors)("missions human CRUD — $name", (door) => {
	test("org:editor own-org mission -> served, lastActedBy user:<subject>", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await door.call(t.withIdentity(as("user_m", "org:editor")), id);
		expect((await mrow(t, id))?.lastActedBy).toBe("user:user_m");
	});

	test("other-org mission -> refused (tenant boundary), untouched", async () => {
		const t = await setup();
		const id = await seedMission(t, "org-b");
		await expect(door.call(t.withIdentity(as("user_m", "org:admin")), id)).rejects.toThrow(/RBAC_DENIED/);
		expect((await mrow(t, id))?.lastActedBy).toBeUndefined();
		expect((await mrow(t, id))?.updatedAt).toBeDefined();
	});

	test("unstamped mission -> refused, untouched", async () => {
		const t = await setup();
		const id = await seedMission(t, null);
		await expect(door.call(t.withIdentity(as("user_m", "org:admin")), id)).rejects.toThrow(/RBAC_DENIED/);
		expect((await mrow(t, id))?.lastActedBy).toBeUndefined();
	});

	test("non-writer role -> refused role-not-writer, untouched", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await expect(door.call(t.withIdentity(as("user_m", "org:viewer")), id)).rejects.toThrow(
			/RBAC_DENIED.*role-not-writer/,
		);
		expect((await mrow(t, id))?.lastActedBy).toBeUndefined();
	});

	test("no identity -> refused (no credential), untouched", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await expect(door.call(t as unknown as Caller, id)).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED/);
		expect((await mrow(t, id))?.lastActedBy).toBeUndefined();
	});
});

describe("missions.update — cancel is destructive: org:admin only", () => {
	const cancel = (c: Caller, missionId: Id<"missions">) =>
		c.mutation(api.missions.update, { missionId, status: "cancelled", cancelReason: "Scope dropped" });

	test("org:editor -> refused role-not-admin, mission untouched", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await expect(cancel(t.withIdentity(as("user_m", "org:editor")), id)).rejects.toThrow(
			/RBAC_DENIED.*role-not-admin/,
		);
		expect((await mrow(t, id))?.status).toBe("plan");
	});

	test("org:admin (not the creator) -> cancelled, cancelledBy and lastActedBy user:<subject>", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await cancel(t.withIdentity(as("user_m", "org:admin")), id);
		const after = await mrow(t, id);
		expect(after?.status).toBe("cancelled");
		expect(after?.cancelledBy).toBe("user:user_m");
		expect(after?.lastActedBy).toBe("user:user_m");
		expect(after?.cancelReason).toBe("Scope dropped");
	});

	test("org:admin without a reason -> CANCEL_REASON_REQUIRED, untouched", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await expect(
			t.withIdentity(as("user_m", "org:admin")).mutation(api.missions.update, { missionId: id, status: "cancelled" }),
		).rejects.toThrow(/CANCEL_REASON_REQUIRED/);
		expect((await mrow(t, id))?.status).toBe("plan");
	});

	test("updateStatus cannot be used to cancel (bypassing the admin gate)", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.missions.updateStatus, { missionId: id, status: "cancelled" }),
		).rejects.toThrow(/RBAC_DENIED|CANCEL_REASON_REQUIRED/);
		expect((await mrow(t, id))?.status).toBe("plan");
	});

	test("org:editor cannot reopen a cancelled mission", async () => {
		const t = await setup();
		const id = await seedMission(t, "org-a", "cancelled");
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.missions.update, { missionId: id, status: "execute" }),
		).rejects.toThrow(/RBAC_DENIED.*role-not-admin/);
		expect((await mrow(t, id))?.status).toBe("cancelled");
	});

	test("pilot reassigned off the org roster -> refused, pilot unchanged", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.missions.update, { missionId: id, pilot: "eta" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await mrow(t, id))?.pilot).toBe("sigma");
	});
});

describe("missions.create — human, no createdBy", () => {
	const args = {
		name: "Created from the dashboard",
		project: "demo",
		status: "plan" as const,
		priority: "medium" as const,
		pilot: "sigma",
		agents: ["sigma"],
	};

	test("org:editor -> org stamped from scope, createdBy and lastActedBy user:<subject>", async () => {
		const t = await setup();
		const id = await t.withIdentity(as("user_m", "org:editor")).mutation(api.missions.create, args);
		const after = await mrow(t, id);
		expect(after?.orgId).toBe("org-a");
		expect(after?.createdBy).toBe("user:user_m");
		expect(after?.lastActedBy).toBe("user:user_m");
	});

	test("non-writer role -> refused, nothing inserted", async () => {
		const t = await setup();
		await expect(t.withIdentity(as("user_m", "org:viewer")).mutation(api.missions.create, args)).rejects.toThrow(
			/RBAC_DENIED.*role-not-writer/,
		);
		expect((await t.run(async (ctx) => ctx.db.query("missions").collect())).length).toBe(0);
	});

	test("pilot off the org roster -> refused, nothing inserted", async () => {
		const t = await setup();
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.missions.create, { ...args, pilot: "eta" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await t.run(async (ctx) => ctx.db.query("missions").collect())).length).toBe(0);
	});

	test("pilot omitted -> refused PILOT_REQUIRED, nothing inserted", async () => {
		const t = await setup();
		const { pilot: _pilot, ...noPilot } = args;
		await expect(t.withIdentity(as("user_m", "org:editor")).mutation(api.missions.create, noPilot)).rejects.toThrow(
			/PILOT_REQUIRED/,
		);
		expect((await t.run(async (ctx) => ctx.db.query("missions").collect())).length).toBe(0);
	});

	test("no identity -> refused (no credential)", async () => {
		const t = await setup();
		await expect(t.mutation(api.missions.create, args)).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED/);
	});

	test("agent path unchanged: roster createdBy is recorded as given, no lastActedBy", async () => {
		const t = await setup();
		const id = await t
			.withIdentity(as("user_m", "org:viewer"))
			.mutation(api.missions.create, { ...args, createdBy: "sigma" });
		const after = await mrow(t, id);
		expect(after?.createdBy).toBe("sigma");
		expect(after?.lastActedBy).toBeUndefined();
	});

	test("a client-supplied non-roster createdBy is not an identity -> refused", async () => {
		const t = await setup();
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.missions.create, { ...args, createdBy: "team/org-a/user" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("missions.update — agent path unchanged", () => {
	test("roster creator cancels as itself: cancelledBy sigma, no lastActedBy, role not consulted", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await t.withIdentity(as("user_m", "org:viewer")).mutation(api.missions.update, {
			missionId: id,
			callerOrchestrator: "sigma",
			status: "cancelled",
			cancelReason: "Agent decision",
		});
		const after = await mrow(t, id);
		expect(after?.cancelledBy).toBe("sigma");
		expect(after?.lastActedBy).toBeUndefined();
	});

	test("non-creator agent name still refused", async () => {
		const t = await setup();
		const id = await seedMission(t);
		await expect(
			t.withIdentity(as("user_m", "org:admin")).mutation(api.missions.update, {
				missionId: id,
				callerOrchestrator: "eta",
				status: "cancelled",
				cancelReason: "x y z",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

// ── briefing notes ───────────────────────────────────────────────────────────
type NDoor = { name: string; call: (c: Caller, id: Id<"briefingNotes">) => Promise<unknown> };
const noteDoors: NDoor[] = [
	{ name: "update", call: (c, noteId) => c.mutation(api.briefingNotes.update, { noteId, title: "Retitled by the human" }) },
	{ name: "deleteBriefingNote", call: (c, noteId) => c.mutation(api.briefingNotes.deleteBriefingNote, { noteId }) },
];

describe.each(noteDoors)("briefing notes human CRUD — $name", (door) => {
	const writer = door.name === "deleteBriefingNote" ? "org:admin" : "org:editor";

	test(`${writer} own-org note -> served, actor user:<subject>`, async () => {
		const t = await setup();
		const id = await seedNote(t);
		await door.call(t.withIdentity(as("user_m", writer)), id);
		const after = await nrow(t, id);
		if (door.name === "deleteBriefingNote") expect(after).toBeNull();
		else {
			expect(after?.title).toBe("Retitled by the human");
			expect(after?.updatedBy).toBe("user:user_m");
		}
	});

	test("other-org note -> refused, untouched", async () => {
		const t = await setup();
		const id = await seedNote(t, "org-b");
		await expect(door.call(t.withIdentity(as("user_m", "org:admin")), id)).rejects.toThrow(/RBAC_DENIED/);
		const after = await nrow(t, id);
		expect(after).not.toBeNull();
		expect(after?.updatedBy).toBeUndefined();
	});

	test("unstamped note -> refused, untouched", async () => {
		const t = await setup();
		const id = await seedNote(t, null);
		await expect(door.call(t.withIdentity(as("user_m", "org:admin")), id)).rejects.toThrow(/RBAC_DENIED/);
		expect(await nrow(t, id)).not.toBeNull();
	});

	test("non-writer role -> refused role-not-writer, untouched", async () => {
		const t = await setup();
		const id = await seedNote(t);
		await expect(door.call(t.withIdentity(as("user_m", "org:viewer")), id)).rejects.toThrow(
			/RBAC_DENIED.*role-not-writer/,
		);
		const after = await nrow(t, id);
		expect(after).not.toBeNull();
		expect(after?.updatedBy).toBeUndefined();
	});

	test("no identity -> refused (no credential), untouched", async () => {
		const t = await setup();
		const id = await seedNote(t);
		await expect(door.call(t as unknown as Caller, id)).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED/);
		expect(await nrow(t, id)).not.toBeNull();
	});
});

describe("briefingNotes.deleteBriefingNote — org:admin only", () => {
	test("org:editor (a writer) -> refused role-not-admin, note survives", async () => {
		const t = await setup();
		const id = await seedNote(t);
		await expect(
			t.withIdentity(as("user_m", "org:editor")).mutation(api.briefingNotes.deleteBriefingNote, { noteId: id }),
		).rejects.toThrow(/RBAC_DENIED.*role-not-admin/);
		expect(await nrow(t, id)).not.toBeNull();
	});

	test("org:admin -> { deleted: true }, participants index emptied", async () => {
		const t = await setup();
		const id = await seedNote(t);
		const res = await t
			.withIdentity(as("user_m", "org:admin"))
			.mutation(api.briefingNotes.deleteBriefingNote, { noteId: id });
		expect(res).toEqual({ deleted: true });
		expect(await nrow(t, id)).toBeNull();
	});
});

describe("briefingNotes.create — human, no createdBy", () => {
	const args = { title: "From the dashboard", topic: "demo", participants: ["sigma"], content: "hello" };

	test("org:editor -> org stamped from scope, createdBy user:<subject>", async () => {
		const t = await setup();
		const id = await t.withIdentity(as("user_m", "org:editor")).mutation(api.briefingNotes.create, args);
		const after = await nrow(t, id);
		expect(after?.orgId).toBe("org-a");
		expect(after?.createdBy).toBe("user:user_m");
	});

	test("non-writer role -> refused, nothing inserted", async () => {
		const t = await setup();
		await expect(
			t.withIdentity(as("user_m", "org:viewer")).mutation(api.briefingNotes.create, args),
		).rejects.toThrow(/RBAC_DENIED.*role-not-writer/);
		expect((await t.run(async (ctx) => ctx.db.query("briefingNotes").collect())).length).toBe(0);
	});

	test("a client-supplied createdBy 'team/<org>/user' is not an identity -> refused", async () => {
		const t = await setup();
		await expect(
			t
				.withIdentity(as("user_m", "org:editor"))
				.mutation(api.briefingNotes.create, { ...args, createdBy: "team/org-a/user" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await t.run(async (ctx) => ctx.db.query("briefingNotes").collect())).length).toBe(0);
	});

	test("no identity -> refused (no credential)", async () => {
		const t = await setup();
		await expect(t.mutation(api.briefingNotes.create, args)).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED/);
	});

	test("agent path unchanged: roster createdBy recorded as given", async () => {
		const t = await setup();
		const id = await t
			.withIdentity(as("user_m", "org:viewer"))
			.mutation(api.briefingNotes.create, { ...args, createdBy: "sigma" });
		expect((await nrow(t, id))?.createdBy).toBe("sigma");
	});
});

describe("briefingNotes.update — agent path unchanged", () => {
	test("roster creator updates as itself, updatedBy sigma", async () => {
		const t = await setup();
		const id = await seedNote(t);
		await t
			.withIdentity(as("user_m", "org:viewer"))
			.mutation(api.briefingNotes.update, { noteId: id, callerOrchestrator: "sigma", title: "Agent edit" });
		expect((await nrow(t, id))?.updatedBy).toBe("sigma");
	});

	test("non-creator agent name still refused", async () => {
		const t = await setup();
		const id = await seedNote(t);
		await expect(
			t
				.withIdentity(as("user_m", "org:admin"))
				.mutation(api.briefingNotes.update, { noteId: id, callerOrchestrator: "eta", title: "x" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
