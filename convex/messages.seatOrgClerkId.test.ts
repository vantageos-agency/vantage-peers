/// <reference types="vite/client" />
//
// Task k1783fk8r6p795x9fxrzyt9evd8hcxm7 (slug-takeover class, PR 2c, ledger row
// A-6). `messages:sendMessage` resolved the seat's organisation by the REUSABLE
// label `seatOrgSlug`. After organisation A is renamed and organisation B takes
// the label, a seat of A still carrying the old label was scoped as B. The seat
// now also forwards `seatOrgClerkId` (the permanent ID of the verified
// principal's organisation); when present it is the ONLY key into
// client_org_mapping. Slug-only stays as it was (expand step of the rollout).

import { convexTest } from "../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const ID_A = "org_TestAAAA";
const ID_B = "org_TestBBBB";
const ID_DORMANT = "org_TestDormant";
const REUSED_LABEL = "reused-label";
const RENAMED_A = "renamed-a";

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seedOrgWithAgents(
	t: T,
	label: string,
	clerkOrgId: string,
	names: string[],
	isActive = true,
) {
	const ids: Id<"agents">[] = [];
	for (const name of names) {
		ids.push(
			await t.run((ctx) =>
				ctx.db.insert("agents", {
					orgSlug: label,
					clerkOrgId,
					name,
					normalizedName: name,
					isActive: true,
					createdAt: Date.now(),
				}),
			),
		);
		await t.run((ctx) =>
			ctx.db.insert("profiles", {
				orchestratorId: name,
				name,
				static: { role: name, workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			}),
		);
	}
	await t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: label,
			clerkOrgId,
			allowedOrchestrators: names,
			scopes: ["view-own-tasks"],
			displayName: label,
			isActive,
			createdAt: Date.now(),
			allowedAgentIds: ids,
		}),
	);
}

// A held the label REUSED_LABEL, was renamed to RENAMED_A, and B took the label.
async function seedRenamedWorld(t: T) {
	await seedOrgWithAgents(t, REUSED_LABEL, ID_A, ["a1", "a2", "a3"]);
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", ID_A))
			.unique();
		if (row) await ctx.db.patch(row._id, { clerkOrgSlug: RENAMED_A });
	});
	await seedOrgWithAgents(t, REUSED_LABEL, ID_B, ["b1", "b2", "b3"]);
	await seedOrgWithAgents(t, "dormant", ID_DORMANT, ["d1"], false);
}

async function recipientsOf(t: T, messageId: string) {
	const rs = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
	return rs
		.filter((r) => r.messageId === messageId)
		.map((r) => r.recipient)
		.sort();
}

async function writes(t: T) {
	return await t.run(async (ctx) => ({
		messages: (await ctx.db.query("messages").collect()).length,
		receipts: (await ctx.db.query("messageReceipts").collect()).length,
	}));
}

describe("messages:sendMessage — seatOrgClerkId is the only key when present", () => {
	test("A's seat with the STALE label and A's real ID is scoped as A, not as B", async () => {
		const t = createT();
		await seedRenamedWorld(t);
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "a1",
			channel: "broadcast",
			content: "x",
			seatOrgSlug: REUSED_LABEL,
			seatOrgClerkId: ID_A,
		});
		expect(await recipientsOf(t, id)).toEqual(["a2", "a3"]);
	});

	test("A's seat cannot reach B's roster by the stale label once its ID is sent", async () => {
		const t = createT();
		await seedRenamedWorld(t);
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "a1",
				channel: "b2",
				content: "x",
				seatOrgSlug: REUSED_LABEL,
				seatOrgClerkId: ID_A,
			}),
		).rejects.toThrow(/recipient error/);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("B's seat (the label's new holder, its own ID) is unaffected", async () => {
		const t = createT();
		await seedRenamedWorld(t);
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "b1",
			channel: "broadcast",
			content: "x",
			seatOrgSlug: REUSED_LABEL,
			seatOrgClerkId: ID_B,
		});
		expect(await recipientsOf(t, id)).toEqual(["b2", "b3"]);
	});

	test("an ID alone (no label) is enough to scope the seat", async () => {
		const t = createT();
		await seedRenamedWorld(t);
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "a1",
			channel: "broadcast",
			content: "x",
			seatOrgClerkId: ID_A,
		});
		expect(await recipientsOf(t, id)).toEqual(["a2", "a3"]);
	});

	test("an ID whose mapping is inactive, or unknown, is refused; nothing written", async () => {
		const t = createT();
		await seedRenamedWorld(t);
		for (const seatOrgClerkId of [ID_DORMANT, "org_TestNoSuchOrg", ""]) {
			await expect(
				asServiceAccount(t).mutation(api.messages.sendMessage, {
					from: "d1",
					channel: "broadcast",
					content: "x",
					seatOrgSlug: REUSED_LABEL,
					seatOrgClerkId,
				}),
			).rejects.toThrow(/RBAC_DENIED/);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("seatOrgClerkId is believed from the service account only", async () => {
		const t = createT();
		await seedRenamedWorld(t);
		await expect(
			t
				.withIdentity({
					subject: "someone-else",
					organizationId: "x",
				} as Parameters<T["withIdentity"]>[0])
				.mutation(api.messages.sendMessage, {
					from: "a1",
					channel: "broadcast",
					content: "x",
					seatOrgClerkId: ID_A,
				}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("a tenantId is judged against the organisation the ID names (its current label)", async () => {
		const t = createT();
		await seedRenamedWorld(t);
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "a1",
				channel: "a2",
				content: "x",
				tenantId: REUSED_LABEL,
				seatOrgClerkId: ID_A,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const ok = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "a1",
			channel: "a2",
			content: "x",
			tenantId: RENAMED_A,
			seatOrgClerkId: ID_A,
		});
		expect(await recipientsOf(t, ok)).toEqual(["a2"]);
	});

	test("EXPAND POLE: slug-only (old MCP) behaves exactly as before — scoped by the label's current holder", async () => {
		const t = createT();
		await seedRenamedWorld(t);
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "b1",
			channel: "broadcast",
			content: "x",
			seatOrgSlug: REUSED_LABEL,
		});
		expect(await recipientsOf(t, id)).toEqual(["b2", "b3"]);
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "x",
				channel: "b1",
				content: "x",
				seatOrgSlug: "dormant",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
