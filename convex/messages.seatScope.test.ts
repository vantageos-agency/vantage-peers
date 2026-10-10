/// <reference types="vite/client" />
//
// Task k174f54w3fv3amnk16v68tb3jh8frxxt. The MCP server reaches Convex as the
// fleet SERVICE ACCOUNT, which resolves as the true fleet master (isMaster,
// orgSlug null). PR #1470 scoped direct-message recipients by the caller's org,
// so that scope never applied to an MCP seat of a client org: its `send_message`
// to a fleet orchestrator was delivered. The fix: the MCP forwards the seat's
// VERIFIED org as `seatOrgSlug`, and `messages:sendMessage` applies the #1470
// recipient scope for THAT org — believed from the service account only.

import { convexTest } from "convex-test";
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

const SEAT_ORG = "cgt-alsachimie";
const BOUNCE = /recipient error/;

// vitest.config.ts sets CLERK_SERVICE_ACCOUNT_USER_ID to this subject.
const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

const asOrgMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `user-${org}`,
		organizationId: org,
	} as Parameters<T["withIdentity"]>[0]);

async function seedProfile(t: T, orchestratorId: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

async function seedOrg(
	t: T,
	clerkOrgSlug: string,
	allowedOrchestrators: string[],
	opts: {
		isActive?: boolean;
		orgKind?: "operator";
		agentIds?: Id<"agents">[];
		coordinatorIds?: Id<"agents">[];
		coordinatorNames?: string[];
	} = {},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: opts.isActive ?? true,
			createdAt: Date.now(),
			...(opts.orgKind !== undefined ? { orgKind: opts.orgKind } : {}),
			// M1: the roster and the fleet coordinators are stored BY ID.
			...(opts.agentIds !== undefined ? { allowedAgentIds: opts.agentIds } : {}),
			...(opts.coordinatorIds !== undefined
				? { addressableFleetCoordinatorIds: opts.coordinatorIds }
				: {}),
			// The current channel-NAME grant, legacy data held on the row.
			...(opts.coordinatorNames !== undefined
				? { addressableFleetCoordinators: opts.coordinatorNames }
				: {}),
		});
	});
}

async function seedAgent(
	t: T,
	orgSlug: string,
	name: string,
): Promise<Id<"agents">> {
	return await t.run((ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			name,
			normalizedName: name,
			isActive: true,
			createdAt: Date.now(),
		}),
	);
}

async function seedWorld(t: T) {
	const seat: Id<"agents">[] = [];
	for (const name of ["neo", "hal", "mimir", "bob"]) {
		seat.push(await seedAgent(t, SEAT_ORG, name));
	}
	const pi = await seedAgent(t, "perello", "pi");
	await seedOrg(t, "perello", ["pi"], { orgKind: "operator" });
	await seedOrg(t, SEAT_ORG, ["neo", "hal", "mimir", "bob"], {
		agentIds: seat,
		coordinatorIds: [pi],
		coordinatorNames: ["pi"],
	});
	await seedOrg(t, "dormant-org", ["ghost"], { isActive: false });
	await seedOrg(t, "other-client", ["themis"]);
	for (const o of [
		"neo",
		"hal",
		"mimir",
		"bob",
		"sigma",
		"pi",
		"ghost",
		"themis",
	]) {
		await seedProfile(t, o);
	}
	return { pi };
}

async function writes(t: T) {
	return await t.run(async (ctx) => ({
		messages: (await ctx.db.query("messages").collect()).length,
		receipts: (await ctx.db.query("messageReceipts").collect()).length,
	}));
}

async function recipientsOf(t: T, messageId: string) {
	const rs = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
	return rs.filter((r) => r.messageId === messageId).map((r) => r.recipient);
}

describe("messages:sendMessage — forwarded seat org on the service-account path", () => {
	test("(a) seat of a client org -> sigma: refused, nothing written", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "neo",
				channel: "sigma",
				content: "x",
				seatOrgSlug: SEAT_ORG,
			}),
		).rejects.toThrow(BOUNCE);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("(b) the same seat -> neo (own roster): delivered", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "hal",
			channel: "neo",
			content: "x",
			seatOrgSlug: SEAT_ORG,
		});
		expect(await recipientsOf(t, id)).toEqual(["neo"]);
	});

	test("(c) the same seat -> pi BY ID (stored fleet coordinator) and by channel NAME (listed name): both delivered", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "neo",
			recipientAgentIds: [w.pi],
			content: "x",
			seatOrgSlug: SEAT_ORG,
		});
		expect(await recipientsOf(t, id)).toEqual(["pi"]);
		const byName = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "neo",
			channel: "pi",
			content: "x",
			seatOrgSlug: SEAT_ORG,
		});
		expect(await recipientsOf(t, byName)).toEqual(["pi"]);
	});

	test("(d) service account with NO forwarded org (fleet master) -> sigma: delivered", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "sigma",
			content: "x",
		});
		expect(await recipientsOf(t, id)).toEqual(["sigma"]);
	});

	test("(e) forwarded org unknown or inactive: refused, nothing written", async () => {
		const t = createT();
		await seedWorld(t);
		for (const seatOrgSlug of ["no-such-org", "dormant-org", ""]) {
			await expect(
				asServiceAccount(t).mutation(api.messages.sendMessage, {
					from: "neo",
					channel: "neo",
					content: "x",
					seatOrgSlug,
				}),
			).rejects.toThrow(/RBAC_DENIED/);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("(f) a non-service-account caller passing the field is refused and cannot widen", async () => {
		const t = createT();
		await seedWorld(t);
		// A member of another client org naming the seat org: no widening, no spoof.
		await expect(
			asOrgMember(t, "other-client").mutation(api.messages.sendMessage, {
				from: "themis",
				channel: "neo",
				content: "x",
				seatOrgSlug: SEAT_ORG,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		// A member of the seat org itself: the field grants nothing there either.
		await expect(
			asOrgMember(t, SEAT_ORG).mutation(api.messages.sendMessage, {
				from: "neo",
				channel: "sigma",
				content: "x",
				seatOrgSlug: SEAT_ORG,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("(g) mixed list neo,sigma: refused whole, no partial delivery", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "hal",
				channel: "neo,sigma",
				content: "x",
				seatOrgSlug: SEAT_ORG,
			}),
		).rejects.toThrow(BOUNCE);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("(h) broadcast from a seat reaches only its org roster, never the fleet", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "neo",
			channel: "broadcast",
			content: "x",
			seatOrgSlug: SEAT_ORG,
		});
		expect((await recipientsOf(t, id)).sort()).toEqual(["bob", "hal", "mimir"]);
	});

	test("(i) a tenantId naming another org than the forwarded seat org: refused", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "neo",
				channel: "hal",
				content: "x",
				tenantId: "other-client",
				seatOrgSlug: SEAT_ORG,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});
});
