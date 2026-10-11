/// <reference types="vite/client" />
//
// Cross-tenant DIRECT-message leak (measured on prod 2026-10-06, task
// k17axar1dx4k6grekykm9tzz098frfm3): a client-org seat called send_message with
// channel "sigma" (a perello-consulting fleet orchestrator) and got a
// messageId; sigma received it. sendMessageCore's direct-channel branch built
// its known recipients from ALL profiles with no tenant filter. Only the
// broadcast branch was org-scoped (mission fix-broadcast-org-scoped-v1).
//
// Contract pinned here, poles REFUSED / PRESENT:
//   - a client-scoped caller reaches only its own org's roster
//     (scope.allowedOrchestrators); "*" names nobody (never a cross-org grant).
//   - one foreign part in a comma list refuses the WHOLE send (no partial
//     delivery); the refusal is the existing recipient-error bounce.
//   - a refused send leaves no message row and no receipt (transactional).
//   - the true internal master (isMaster && orgSlug === null) keeps
//     fleet-wide reach.

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedProfile(t: T, orchestratorId: string, instanceId?: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			instanceId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

async function seedOrg(t: T, clerkOrgSlug: string, allowedOrchestrators: string[]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
			allowedOrchestrators,
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const asOrg = (t: T, org: string) =>
	t.withIdentity({
		subject: `user-${org}`,
		organizationId: org,
		org_id: testClerkOrgId(org),
	} as Parameters<T["withIdentity"]>[0]);

const asMaster = (t: T) =>
	t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<T["withIdentity"]>[0]);

async function seedWorld(t: T) {
	await seedOrg(t, "org-a", ["alice", "amy"]);
	await seedOrg(t, "org-b", ["bob"]);
	await seedProfile(t, "alice", "alice-vps");
	await seedProfile(t, "amy");
	await seedProfile(t, "bob", "bob-vps");
	await seedProfile(t, "sigma", "sigma-vps"); // internal fleet, no mapping row
	await seedProfile(t, "pi");
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

const BOUNCE = /recipient error/;

describe("sendMessage direct channel: org-scoped recipients", () => {
	test("REFUSED: org-a seat -> org-b orchestrator, nothing written", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asOrg(t, "org-a").mutation(api.messages.sendMessage, {
				from: "alice",
				channel: "bob",
				content: "cross-org",
			}),
		).rejects.toThrow(BOUNCE);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("REFUSED: org-a seat -> fleet orchestrator (the prod incident), nothing written", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asOrg(t, "org-a").mutation(api.messages.sendMessage, {
				from: "alice",
				channel: "sigma",
				content: "into the fleet",
			}),
		).rejects.toThrow(BOUNCE);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("REFUSED: comma list mixing own-org and foreign is refused as a whole", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asOrg(t, "org-a").mutation(api.messages.sendMessage, {
				from: "alice",
				channel: "amy,bob",
				content: "mixed",
			}),
		).rejects.toThrow(BOUNCE);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("REFUSED: foreign org instance channel (bob-vps, sigma-vps)", async () => {
		const t = createT();
		await seedWorld(t);
		for (const channel of ["bob-vps", "sigma-vps"]) {
			await expect(
				asOrg(t, "org-a").mutation(api.messages.sendMessage, {
					from: "alice",
					channel,
					content: "instance",
				}),
			).rejects.toThrow(BOUNCE);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("PRESENT: org-a seat reaches its own org (role, list, instance)", async () => {
		const t = createT();
		await seedWorld(t);
		const a = asOrg(t, "org-a");
		const m1 = await a.mutation(api.messages.sendMessage, {
			from: "alice",
			channel: "amy",
			content: "role",
		});
		expect(await recipientsOf(t, m1)).toEqual(["amy"]);

		const m2 = await a.mutation(api.messages.sendMessage, {
			from: "amy",
			channel: "alice,amy",
			content: "list (self excluded)",
		});
		expect(await recipientsOf(t, m2)).toEqual(["alice"]);

		const m3 = await a.mutation(api.messages.sendMessage, {
			from: "amy",
			channel: "alice-vps",
			content: "instance",
		});
		expect(await recipientsOf(t, m3)).toEqual(["alice"]);
	});

	test("PRESENT: fleet master keeps fleet-wide reach (fleet, client-bound, list)", async () => {
		const t = createT();
		await seedWorld(t);
		const m = asMaster(t);
		const m1 = await m.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "sigma",
			content: "fleet",
		});
		expect(await recipientsOf(t, m1)).toEqual(["sigma"]);
		const m2 = await m.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "alice,bob,sigma-vps",
			content: "wide",
		});
		expect((await recipientsOf(t, m2)).sort()).toEqual(["alice", "bob", "sigma"]);
	});
});
