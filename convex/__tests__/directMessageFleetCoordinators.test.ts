/// <reference types="vite/client" />
//
// Pi ruling (b), task k17axar1dx4k6grekykm9tzz098frfm3, module M1: a client
// org's direct recipients are its own roster PLUS an explicit, data-held
// allow-list of fleet coordinators, stored BY AGENT ID
// (client_org_mapping.addressableFleetCoordinatorIds). Empty by default; never
// inferred; no wildcard. A coordinator is addressed by its ID
// (`recipientAgentIds`) and judged by assertPrincipalListed; a channel NAME no
// longer reaches it. The write path is the internal mutation
// clientOrgMapping:setAddressableFleetCoordinators, which accepts only IDs of
// active agents of an active operator org.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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

async function seedOrg(
	t: T,
	clerkOrgSlug: string,
	allowedOrchestrators: string[],
	orgKind?: "operator" | "client",
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
			...(orgKind !== undefined ? { orgKind } : {}),
		});
	});
}

const asOrg = (t: T, org: string) =>
	t.withIdentity({
		subject: `user-${org}`,
		organizationId: org,
	} as Parameters<T["withIdentity"]>[0]);

type World = {
	pi: Id<"agents">;
	sigma: Id<"agents">;
	eta: Id<"agents">;
	themis: Id<"agents">;
	neo: Id<"agents">;
	oldOp: Id<"agents">;
};

async function seedWorld(t: T): Promise<World> {
	const ids = await t.run(async (ctx) => {
		const agent = (orgSlug: string, name: string, isActive = true) =>
			ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: name,
				isActive,
				createdAt: Date.now(),
			});
		return {
			pi: await agent("perello", "pi"),
			sigma: await agent("perello", "sigma"),
			eta: await agent("perello", "eta"),
			themis: await agent("other-client", "themis"),
			neo: await agent("cgt", "neo"),
			oldOp: await agent("old-op", "ghost"),
		};
	});
	await seedOrg(t, "perello", ["pi", "sigma", "eta"], "operator");
	await seedOrg(t, "old-op", ["ghost"], "operator");
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "old-op"))
			.unique();
		if (row) await ctx.db.patch(row._id, { isActive: false });
	});
	await seedOrg(t, "cgt", ["cgtbot", "neo"]);
	await seedOrg(t, "iris-rh", ["irisbot"]);
	await seedOrg(t, "other-client", ["themis"]);
	for (const o of ["cgtbot", "neo", "irisbot", "sigma", "eta", "themis"]) {
		await seedProfile(t, o);
	}
	await seedProfile(t, "pi", "pi-chromebook");
	return ids;
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

const setIds = (t: T, clerkOrgSlug: string, agentIds: Id<"agents">[]) =>
	t.mutation(internal.clientOrgMapping.setAddressableFleetCoordinators, {
		clerkOrgSlug,
		agentIds,
	});

describe("direct messages: addressableFleetCoordinatorIds (empty by default)", () => {
	test("CGT (no list) -> sigma by name: refused, nothing written", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asOrg(t, "cgt").mutation(api.messages.sendMessage, {
				from: "cgtbot",
				channel: "sigma",
				content: "x",
			}),
		).rejects.toThrow(BOUNCE);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("CGT (no list) -> sigma BY ID: refused, nothing written", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(
			asOrg(t, "cgt").mutation(api.messages.sendMessage, {
				from: "cgtbot",
				recipientAgentIds: [w.sigma],
				content: "x",
			}),
		).rejects.toThrow(/recipient-agent-not-addressable/);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("CGT -> neo (own roster, by name): delivered", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await asOrg(t, "cgt").mutation(api.messages.sendMessage, {
			from: "cgtbot",
			channel: "neo",
			content: "x",
		});
		expect(await recipientsOf(t, id)).toEqual(["neo"]);
	});

	test("iris-rh with [pi] -> pi BY ID: delivered in iris-rh's tenant with pi's ID", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "iris-rh", [w.pi]);
		const m1 = await asOrg(t, "iris-rh").mutation(api.messages.sendMessage, {
			from: "irisbot",
			recipientAgentIds: [w.pi],
			content: "x",
		});
		const receipts = await t.run((ctx) =>
			ctx.db
				.query("messageReceipts")
				.withIndex("by_message", (q) => q.eq("messageId", m1))
				.collect(),
		);
		expect(receipts.map((r) => [r.recipient, r.recipientId, r.tenantId])).toEqual([
			["pi", w.pi, "iris-rh"],
		]);
	});

	test("iris-rh with [pi]: a channel NAME no longer reaches the coordinator", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "iris-rh", [w.pi]);
		for (const channel of ["pi", "pi-chromebook"]) {
			await expect(
				asOrg(t, "iris-rh").mutation(api.messages.sendMessage, {
					from: "irisbot",
					channel,
					content: "x",
				}),
			).rejects.toThrow(BOUNCE);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("iris-rh with [pi] -> eta and -> themis BY ID, and a list with one unlisted: refused", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "iris-rh", [w.pi]);
		for (const ids of [[w.eta], [w.themis], [w.pi, w.eta]]) {
			await expect(
				asOrg(t, "iris-rh").mutation(api.messages.sendMessage, {
					from: "irisbot",
					recipientAgentIds: ids,
					content: "x",
				}),
			).rejects.toThrow(/recipient-agent-not-addressable/);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("setter: stores IDs and reports previous/current", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const r = await setIds(t, "iris-rh", [w.pi, w.pi, w.sigma]);
		expect(r).toEqual({
			clerkOrgSlug: "iris-rh",
			previous: [],
			current: [w.pi, w.sigma],
		});
		const cleared = await setIds(t, "iris-rh", []);
		expect(cleared.previous).toEqual([w.pi, w.sigma]);
		expect(cleared.current).toEqual([]);
	});

	test("setter refuses a client agent, an agent of an inactive operator org, a deleted agent, the operator org and an unknown org", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(setIds(t, "iris-rh", [w.themis])).rejects.toThrow(
			/NOT_OPERATOR_AGENT/,
		);
		await expect(setIds(t, "iris-rh", [w.neo])).rejects.toThrow(
			/NOT_OPERATOR_AGENT/,
		);
		await expect(setIds(t, "iris-rh", [w.oldOp])).rejects.toThrow(
			/NOT_OPERATOR_AGENT/,
		);
		await t.run((ctx) => ctx.db.delete(w.eta));
		await expect(setIds(t, "iris-rh", [w.eta])).rejects.toThrow(
			/NOT_OPERATOR_AGENT/,
		);
		await expect(setIds(t, "perello", [w.pi])).rejects.toThrow(
			/OPERATOR_ORG_HAS_NO_ALLOW_LIST/,
		);
		await expect(setIds(t, "no-such-org", [w.pi])).rejects.toThrow(
			/ORG_MAPPING_NOT_FOUND/,
		);
	});
});
