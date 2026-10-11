/// <reference types="vite/client" />
//
// VantagePeers Cloud, module M5 (task k173069sdrkaapcqxz10h15btx8fz7rb): sending a
// message decides who may address whom by AGENT ID, in both directions across
// organisations, through @vantageos/cloud-identity `assertRecipientAddressable`
// (convex/lib/actingPrincipal.ts addressRecipientById). A name never selects or
// authorises.
//
// World: an operator org (fleet-op) with agents "pi" and "eta"; two client orgs
// (iris-rh, acme). BOTH clients also hold an agent named "pi" (the fleet
// coordinator's name), and each holds a "helios". iris-rh stores the fleet "pi" ID
// as an addressable fleet coordinator; acme stores none. Every caller below is a
// SCOPED identity: the agent is forwarded BY ID (`verifiedActor`) through the MCP
// service account, exactly as the MCP does, and is resolved to its own org.
//
// Poles:
//   DELIVERED  client -> listed fleet agent ID; fleet pi -> iris agent ID (the
//              reply direction), stamped in iris's tenant and read by iris's agent,
//              the sender recorded as the FLEET pi's ID, never the namesake's.
//   REFUSED    a same-NAME agent of another org (both directions); an unlisted
//              recipient; an inactive recipient; recipients spanning two orgs.
//   REVOKED    removing the fleet agent from the client's list closes the reply.
//
// On main (8e57a83) the reply direction and the span/revoke poles fail: an
// operator agent's reach is its own org's roster, so every client ID is refused.

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

type Agent = { id: Id<"agents">; org: string; name: string };
type World = {
	t: T;
	fleetPi: Agent;
	fleetEta: Agent;
	irisClio: Agent;
	irisHelios: Agent;
	irisPi: Agent;
	acmeHelios: Agent;
	acmePi: Agent;
};

async function world(): Promise<World> {
	const t = createT();
	const made: Record<string, Agent> = {};
	await t.run(async (ctx) => {
		const now = Date.now();
		const org = (
			clerkOrgSlug: string,
			allowedOrchestrators: string[],
			orgKind?: "operator",
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug,
				clerkOrgId: testClerkOrgId(clerkOrgSlug),
				allowedOrchestrators,
				scopes: ["view-own-tasks"],
				displayName: clerkOrgSlug,
				isActive: true,
				createdAt: now,
				...(orgKind ? { orgKind } : {}),
			});
		const irisRow = await org("iris-rh", ["clio", "helios", "pi"]);
		const acmeRow = await org("acme", ["helios", "pi"]);
		await org("fleet-op", ["*"], "operator");
		const agent = async (orgSlug: string, name: string) => {
			const id = await ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name,
				isActive: true,
				createdAt: now,
			});
			made[`${orgSlug}/${name}`] = { id, org: orgSlug, name };
		};
		await agent("fleet-op", "pi");
		await agent("fleet-op", "eta");
		await agent("iris-rh", "clio");
		await agent("iris-rh", "helios");
		await agent("iris-rh", "pi");
		await agent("acme", "helios");
		await agent("acme", "pi");
		await ctx.db.patch(irisRow, {
			allowedAgentIds: [
				made["iris-rh/clio"].id,
				made["iris-rh/helios"].id,
				made["iris-rh/pi"].id,
			],
			// The fleet "pi" (by ID), and only it.
			addressableFleetCoordinatorIds: [made["fleet-op/pi"].id],
		});
		await ctx.db.patch(acmeRow, {
			allowedAgentIds: [made["acme/helios"].id, made["acme/pi"].id],
		});
	});
	return {
		t,
		fleetPi: made["fleet-op/pi"],
		fleetEta: made["fleet-op/eta"],
		irisClio: made["iris-rh/clio"],
		irisHelios: made["iris-rh/helios"],
		irisPi: made["iris-rh/pi"],
		acmeHelios: made["acme/helios"],
		acmePi: made["acme/pi"],
	};
}

// The MCP forwards the acting agent BY ID and, for a client seat, the seat's org.
const sends = (
	w: World,
	sender: Agent,
	recipients: readonly Agent[],
	extra: Record<string, unknown> = {},
) =>
	asService(w.t).mutation(api.messages.sendMessage, {
		from: sender.name,
		content: "hello",
		recipientAgentIds: recipients.map((r) => r.id),
		verifiedActor: { agentId: sender.id, orgSlug: sender.org },
		...(sender.org === "fleet-op" ? {} : { seatOrgSlug: sender.org }),
		...extra,
	} as never);

async function errorOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		// convex-test carries ConvexError data as a JSON string; prod as the value.
		const data = (e as { data?: unknown }).data;
		if (typeof data === "string") {
			try {
				const parsed: unknown = JSON.parse(data);
				return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
			} catch {
				return data;
			}
		}
		if (data !== undefined) return JSON.stringify(data);
		return String(e);
	}
	throw new Error("expected a refusal, the call succeeded");
}

const counts = (w: World) =>
	w.t.run(async (ctx) => ({
		messages: (await ctx.db.query("messages").collect()).length,
		receipts: (await ctx.db.query("messageReceipts").collect()).length,
	}));

const receiptsOf = (w: World, messageId: Id<"messages">) =>
	w.t.run((ctx) =>
		ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", messageId))
			.collect(),
	);

const inbox = (w: World, recipient: string, orgSlug: string) =>
	asService(w.t).query(api.messages.checkNewMessagesEnvelope, {
		recipient,
		verifiedOrg: { orgSlug },
	});

const NOT_ADDRESSABLE = '"reason":"recipient-agent-not-addressable"';

describe("DELIVERED — by agent ID, in both directions", () => {
	test("client -> a listed fleet agent ID: delivered in the client's tenant, keyed by the IDs", async () => {
		const w = await world();
		const id = await sends(w, w.irisClio, [w.fleetPi]);
		const message = await w.t.run((ctx) => ctx.db.get(id));
		expect(message?.tenantId).toBe("iris-rh");
		expect(message?.fromId).toBe(w.irisClio.id);
		const receipts = await receiptsOf(w, id);
		expect(receipts.map((r) => [r.recipientId, r.tenantId])).toEqual([
			[w.fleetPi.id, "iris-rh"],
		]);
	});

	test("fleet pi -> a rostered client agent ID: delivered in the CLIENT's tenant, sender recorded by ID", async () => {
		const w = await world();
		const id = await sends(w, w.fleetPi, [w.irisHelios]);
		const message = await w.t.run((ctx) => ctx.db.get(id));
		expect(message?.tenantId).toBe("iris-rh");
		// The sender is the FLEET pi. iris-rh holds its own agent named "pi": it is
		// a different agent and is never recorded as the sender.
		expect(message?.fromId).toBe(w.fleetPi.id);
		expect(message?.fromId).not.toBe(w.irisPi.id);
		const receipts = await receiptsOf(w, id);
		expect(receipts.map((r) => [r.recipientId, r.tenantId])).toEqual([
			[w.irisHelios.id, "iris-rh"],
		]);
	});

	test("the reply is read by iris's agent and by nobody of acme", async () => {
		const w = await world();
		await sends(w, w.fleetPi, [w.irisHelios]);
		expect((await inbox(w, "helios", "iris-rh")).messages.map((m) => m.content)).toEqual([
			"hello",
		]);
		expect((await inbox(w, "helios", "acme")).messages).toEqual([]);
	});

	test("several agents of ONE client org: one message, one receipt each", async () => {
		const w = await world();
		const id = await sends(w, w.fleetPi, [w.irisHelios, w.irisClio]);
		expect((await receiptsOf(w, id)).map((r) => r.recipientId).sort()).toEqual(
			[w.irisHelios.id, w.irisClio.id].sort(),
		);
		expect(await counts(w)).toEqual({ messages: 1, receipts: 2 });
	});
});

describe("REFUSED — a same-NAME agent of another org is not addressable", () => {
	test("iris clio -> acme's 'pi' (the fleet coordinator's name, another org): refused", async () => {
		const w = await world();
		const err = await errorOf(sends(w, w.irisClio, [w.acmePi]));
		expect(err).toContain("RBAC_DENIED");
		expect(err).toContain(NOT_ADDRESSABLE);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("iris clio -> iris-rh's OWN 'pi' is a different agent from the fleet pi: still by ID", async () => {
		const w = await world();
		const id = await sends(w, w.irisClio, [w.irisPi]);
		expect((await receiptsOf(w, id)).map((r) => r.recipientId)).toEqual([
			w.irisPi.id,
		]);
	});

	test("fleet pi -> acme's helios: acme lists no fleet agent, refused", async () => {
		const w = await world();
		const err = await errorOf(sends(w, w.fleetPi, [w.acmeHelios]));
		expect(err).toContain(NOT_ADDRESSABLE);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("acme's 'pi' -> iris's helios: client to client is refused whatever the name", async () => {
		const w = await world();
		const err = await errorOf(sends(w, w.acmePi, [w.irisHelios]));
		expect(err).toContain(NOT_ADDRESSABLE);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("acme's 'pi' -> the fleet pi: iris lists that ID for iris, never for acme", async () => {
		const w = await world();
		const err = await errorOf(sends(w, w.acmePi, [w.fleetPi]));
		expect(err).toContain(NOT_ADDRESSABLE);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});
});

describe("REFUSED — an unlisted recipient", () => {
	test("iris clio -> fleet eta (an operator agent iris does not list): refused", async () => {
		const w = await world();
		const err = await errorOf(sends(w, w.irisClio, [w.fleetEta]));
		expect(err).toContain(NOT_ADDRESSABLE);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("fleet eta -> iris helios: iris does not list eta, refused", async () => {
		const w = await world();
		const err = await errorOf(sends(w, w.fleetEta, [w.irisHelios]));
		expect(err).toContain(NOT_ADDRESSABLE);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("an inactive client recipient is refused with the same reason as an unlisted one", async () => {
		const w = await world();
		await w.t.run((ctx) => ctx.db.patch(w.irisHelios.id, { isActive: false }));
		const inactive = await errorOf(sends(w, w.fleetPi, [w.irisHelios]));
		const unlisted = await errorOf(sends(w, w.fleetEta, [w.irisClio]));
		const reason = (e: string) => e.match(/"reason":"([^"]+)"/)?.[1];
		expect(reason(inactive)).toBe("recipient-agent-not-addressable");
		expect(reason(unlisted)).toBe(reason(inactive));
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("one unlisted ID refuses the whole send, nothing written", async () => {
		const w = await world();
		const err = await errorOf(sends(w, w.fleetPi, [w.irisHelios, w.acmeHelios]));
		expect(err).toContain(NOT_ADDRESSABLE);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});
});

describe("SPAN and REVOKE", () => {
	test("recipients of two client orgs that BOTH list the fleet pi cannot share one tenant", async () => {
		const w = await world();
		await w.t.run(async (ctx) => {
			const acme = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "acme"))
				.first();
			if (acme) {
				await ctx.db.patch(acme._id, {
					addressableFleetCoordinatorIds: [w.fleetPi.id],
				});
			}
		});
		const err = await errorOf(sends(w, w.fleetPi, [w.irisHelios, w.acmeHelios]));
		expect(err).toContain("recipients-span-organisations");
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
		// Each org alone is addressable.
		await expect(sends(w, w.fleetPi, [w.acmeHelios])).resolves.toBeTruthy();
		await expect(sends(w, w.fleetPi, [w.irisHelios])).resolves.toBeTruthy();
	});

	test("removing the fleet pi from iris's list closes both directions", async () => {
		const w = await world();
		await expect(sends(w, w.fleetPi, [w.irisHelios])).resolves.toBeTruthy();
		await w.t.run(async (ctx) => {
			const iris = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "iris-rh"))
				.first();
			if (iris) {
				await ctx.db.patch(iris._id, { addressableFleetCoordinatorIds: [] });
			}
		});
		expect(await errorOf(sends(w, w.fleetPi, [w.irisHelios]))).toContain(
			NOT_ADDRESSABLE,
		);
		expect(await errorOf(sends(w, w.irisClio, [w.fleetPi]))).toContain(
			NOT_ADDRESSABLE,
		);
	});
});
