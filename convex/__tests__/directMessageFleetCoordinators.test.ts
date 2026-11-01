/// <reference types="vite/client" />
//
// Pi ruling (b), task k17axar1dx4k6grekykm9tzz098frfm3, module M1: a client
// org's direct recipients are its own roster PLUS an explicit, data-held
// allow-list of fleet coordinators, stored BY AGENT ID
// (client_org_mapping.addressableFleetCoordinatorIds). Empty by default; never
// inferred; no wildcard. A coordinator is addressed by its ID
// (`recipientAgentIds`) and judged by assertPrincipalListed. M1a keeps the
// CURRENT channel-NAME path beside it, unchanged (the org's
// client_org_mapping.addressableFleetCoordinators names; removed by M1b). The
// write path is the internal mutation
// clientOrgMapping:setAddressableFleetCoordinators, which accepts only IDs of
// active agents of an active operator org.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
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
		org_id: testClerkOrgId(org),
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
				clerkOrgId: testClerkOrgId(orgSlug),
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
	await seedOrg(t, "acme-hr", ["irisbot"]);
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

// Legacy NAME list, as the pre-M1 setter wrote it: data held on the row.
const setNames = (t: T, clerkOrgSlug: string, names: string[]) =>
	t.run(async (ctx) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", clerkOrgSlug))
			.unique();
		if (row) await ctx.db.patch(row._id, { addressableFleetCoordinators: names });
	});

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

	test("(b) acme-hr with [pi] -> pi BY ID: delivered in acme-hr's tenant with pi's ID", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "acme-hr", [w.pi]);
		const m1 = await asOrg(t, "acme-hr").mutation(api.messages.sendMessage, {
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
			["pi", w.pi, "acme-hr"],
		]);
	});

	// Poles (a) and (d): the CURRENT channel-NAME contract, unchanged by M1a.
	// The names are legacy data held on the row (`addressableFleetCoordinators`).
	test("(a) acme-hr lists [pi] by name: channel pi and channel pi-chromebook are REFUSED (a coordinator is addressed by ID, see the last describe), nothing written", async () => {
		const t = createT();
		await seedWorld(t);
		await setNames(t, "acme-hr", ["pi"]);
		const iris = asOrg(t, "acme-hr");
		for (const channel of ["pi", "pi-chromebook"]) {
			await expect(
				iris.mutation(api.messages.sendMessage, {
					from: "irisbot",
					channel,
					content: "x",
				}),
			).rejects.toThrow(/coordinator-by-name-refused/);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("(d) acme-hr lists [pi] by name: channel eta, themis and pi,eta are refused, nothing written", async () => {
		const t = createT();
		await seedWorld(t);
		await setNames(t, "acme-hr", ["pi"]);
		// "pi,eta": pi is refused as a name-addressed coordinator before eta is judged.
		for (const [channel, refusal] of [
			["eta", BOUNCE],
			["themis", BOUNCE],
			["pi,eta", /coordinator-by-name-refused/],
		] as const) {
			await expect(
				asOrg(t, "acme-hr").mutation(api.messages.sendMessage, {
					from: "irisbot",
					channel,
					content: "x",
				}),
			).rejects.toThrow(refusal);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("(d) a name grant alone opens no ID path", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setNames(t, "cgt", ["pi"]);
		await expect(
			asOrg(t, "cgt").mutation(api.messages.sendMessage, {
				from: "cgtbot",
				recipientAgentIds: [w.pi],
				content: "x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("(e) dual write: the setter mirrors the listed labels into the name list, so a name grant is revocable", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const iris = asOrg(t, "acme-hr");
		const send = (channel: string) =>
			iris.mutation(api.messages.sendMessage, {
				from: "irisbot",
				channel,
				content: "x",
			});
		const names = () =>
			t.run(async (ctx) => {
				const row = await ctx.db
					.query("client_org_mapping")
					.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "acme-hr"))
					.unique();
				return row?.addressableFleetCoordinators;
			});

		await setIds(t, "acme-hr", [w.pi, w.sigma]);
		expect(await names()).toEqual(["pi", "sigma"]);
		await expect(send("pi")).rejects.toThrow(/coordinator-by-name-refused/);

		// Drop pi: its label leaves the name list and the channel name bounces.
		await setIds(t, "acme-hr", [w.sigma]);
		expect(await names()).toEqual(["sigma"]);
		await expect(send("pi")).rejects.toThrow(BOUNCE);
		// A still-listed coordinator's name is refused as a name (use its ID).
		await expect(send("sigma")).rejects.toThrow(/coordinator-by-name-refused/);

		// Clearing the list revokes every name.
		await setIds(t, "acme-hr", []);
		expect(await names()).toEqual([]);
		await expect(send("sigma")).rejects.toThrow(BOUNCE);
	});

	test("(c) acme-hr with [pi] -> eta and -> themis BY ID, and a list with one unlisted: RBAC_DENIED, nothing written", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "acme-hr", [w.pi]);
		for (const ids of [[w.eta], [w.themis], [w.pi, w.eta]]) {
			await expect(
				asOrg(t, "acme-hr").mutation(api.messages.sendMessage, {
					from: "irisbot",
					recipientAgentIds: ids,
					content: "x",
				}),
			).rejects.toThrow(/RBAC_DENIED.*recipient-agent-not-addressable/s);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("setter: stores IDs and reports previous/current", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const r = await setIds(t, "acme-hr", [w.pi, w.pi, w.sigma]);
		expect(r).toEqual({
			clerkOrgSlug: "acme-hr",
			previous: [],
			current: [w.pi, w.sigma],
		});
		const cleared = await setIds(t, "acme-hr", []);
		expect(cleared.previous).toEqual([w.pi, w.sigma]);
		expect(cleared.current).toEqual([]);
	});

	test("setter refuses a client agent, an agent of an inactive operator org, a deleted agent, the operator org and an unknown org", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(setIds(t, "acme-hr", [w.themis])).rejects.toThrow(
			/NOT_OPERATOR_AGENT/,
		);
		await expect(setIds(t, "acme-hr", [w.neo])).rejects.toThrow(
			/NOT_OPERATOR_AGENT/,
		);
		await expect(setIds(t, "acme-hr", [w.oldOp])).rejects.toThrow(
			/NOT_OPERATOR_AGENT/,
		);
		await t.run((ctx) => ctx.db.delete(w.eta));
		await expect(setIds(t, "acme-hr", [w.eta])).rejects.toThrow(
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

// Task k17a1q56g4w9yw6s8gzpe6h8hx8h3hmy (Eta REVISE @ 0e32b07d): a client agent
// addressing a fleet coordinator BY NAME is refused and pointed to
// recipientAgentIds. A name receipt carries no recipientId, so the coordinator's
// agent reader (which owns receipts by ID) could never read it: the send was lost
// silently. Refusal is distinguishable from delivery; the ID path delivers.
describe("a fleet coordinator is addressed by ID; by name it is refused", () => {
	const asService = (t: T) =>
		t.withIdentity({ subject: "test-service-account-user-id" });
	const REFUSED = /RBAC_DENIED.*coordinator-by-name-refused.*messages:sendMessage/s;

	const sendTo = (t: T, channel: string) =>
		asOrg(t, "acme-hr").mutation(api.messages.sendMessage, {
			from: "irisbot",
			channel,
			content: "x",
		});

	test("(a) channel pi (pi listed by name and ID) is refused, 0 messages 0 receipts", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "acme-hr", [w.pi]);
		await expect(sendTo(t, "pi")).rejects.toThrow(REFUSED);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("(b) the instance form pi-chromebook, and a list with an own-roster name beside pi, are refused whole", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "acme-hr", [w.pi]);
		await seedProfile(t, "clio");
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "acme-hr"))
				.unique();
			if (row) {
				await ctx.db.patch(row._id, {
					allowedOrchestrators: ["irisbot", "clio"],
				});
			}
		});
		for (const channel of ["pi-chromebook", "clio,pi"]) {
			await expect(sendTo(t, channel)).rejects.toThrow(REFUSED);
		}
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("a name-only listed coordinator is refused the same way", async () => {
		const t = createT();
		await seedWorld(t);
		await setNames(t, "acme-hr", ["pi"]);
		await expect(sendTo(t, "pi")).rejects.toThrow(REFUSED);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("(c) the same agent by recipientAgentIds=[pi's ID] is delivered and pi's agent inbox reads it and marks it read", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "acme-hr", [w.pi]);
		const m = await asOrg(t, "acme-hr").mutation(api.messages.sendMessage, {
			from: "irisbot",
			recipientAgentIds: [w.pi],
			content: "hello-coordinator",
		});
		const receipts = await t.run((ctx) =>
			ctx.db
				.query("messageReceipts")
				.withIndex("by_message", (q) => q.eq("messageId", m))
				.collect(),
		);
		expect(
			receipts.map((r) => [r.recipient, r.recipientId, r.tenantId]),
		).toEqual([["pi", w.pi, "acme-hr"]]);
		const actor = { verifiedActor: { agentId: w.pi, orgSlug: "perello" } };
		const inbox = await asService(t).query(
			api.messages.checkNewMessagesEnvelope,
			actor as never,
		);
		expect(inbox.messages.map((x) => x.content)).toEqual(["hello-coordinator"]);
		expect(
			await asService(t).mutation(api.messages.markAsRead, {
				receiptIds: [inbox.messages[0]?.receiptId as string],
				...actor,
			} as never),
		).toBe(1);
		const after = await asService(t).query(
			api.messages.checkNewMessagesEnvelope,
			actor as never,
		);
		expect(after.messages).toEqual([]);
	});

	test("(d) a name on the sender's OWN roster is still delivered by name, with no coordinator ID", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "acme-hr", [w.pi]);
		await seedProfile(t, "clio");
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "acme-hr"))
				.unique();
			if (row) {
				await ctx.db.patch(row._id, {
					allowedOrchestrators: ["irisbot", "clio"],
				});
			}
		});
		const m = await sendTo(t, "clio");
		const rs = await t.run((ctx) =>
			ctx.db
				.query("messageReceipts")
				.withIndex("by_message", (q) => q.eq("messageId", m))
				.collect(),
		);
		expect(rs.map((r) => [r.recipient, r.recipientId, r.tenantId])).toEqual([
			["clio", undefined, "acme-hr"],
		]);
	});

	test("a name on the sender's OWN roster AND listed as a coordinator is delivered by name (own roster wins)", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "acme-hr", [w.pi]);
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "acme-hr"))
				.unique();
			if (row) {
				await ctx.db.patch(row._id, {
					allowedOrchestrators: ["irisbot", "pi"],
				});
			}
		});
		const m = await sendTo(t, "pi");
		const rs = await t.run((ctx) =>
			ctx.db
				.query("messageReceipts")
				.withIndex("by_message", (q) => q.eq("messageId", m))
				.collect(),
		);
		// No coordinator ID is stamped on a client's internal message.
		expect(rs.map((r) => [r.recipient, r.recipientId, r.tenantId])).toEqual([
			["pi", undefined, "acme-hr"],
		]);
	});

	test("(e) an unlisted fleet agent (sigma) is still bounced with pi listed, nothing written", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await setIds(t, "acme-hr", [w.pi]);
		await expect(sendTo(t, "sigma")).rejects.toThrow(BOUNCE);
		expect(await writes(t)).toEqual({ messages: 0, receipts: 0 });
	});

	test("the fleet master addressing pi by name is unchanged (delivered)", async () => {
		const t = createT();
		await seedWorld(t);
		const m = await asService(t).mutation(api.messages.sendMessage, {
			from: "sigma",
			channel: "pi",
			content: "x",
		});
		expect(await recipientsOf(t, m)).toEqual(["pi"]);
	});
});
