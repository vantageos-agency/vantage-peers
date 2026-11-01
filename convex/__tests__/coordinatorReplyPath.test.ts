/// <reference types="vite/client" />
//
// VantagePeers Cloud messaging, task k177h2f3nkgns1f1ncf2v160vh8hd5hy: the REPLY
// path. A client org lists the fleet coordinators it may address
// (client_org_mapping.addressableFleetCoordinators by name,
// addressableFleetCoordinatorIds by agent ID). Inbound (client agent -> listed
// coordinator) was admitted; the reverse (the coordinator answering that client's
// roster agent) bounced, because an operator agent's reach was only its own org's
// roster. Measured on prod: CGT agent neo -> pi delivered, pi -> "neo" bounced.
//
// World: operator org perello (pi, eta, sigma); client org cgt (neo, hal) listing
// pi (name and ID); client org other-client (themis) listing nobody.
//
// Poles:
//   DELIVERED  pi -> neo / hal by NAME and by ID, with and without a proven
//              actor, stamped in cgt's tenant and READ by neo's own inbox; neo -> pi
//              by ID unchanged.
//   REFUSED    eta (not listed by cgt) -> neo; pi -> themis (other-client lists
//              nobody); a client agent that merely bears the name "pi"; a mixed
//              own-roster + client list (two tenants); a broadcast never reaches cgt;
//              a cgt agent that is NOT on cgt's roster.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { ownAgent } from "../../tests/lib/ownAgent";
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

async function world() {
	const t = createT();
	const made: Record<string, Agent> = {};
	await t.run(async (ctx) => {
		const now = Date.now();
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
		await agent("perello", "pi");
		await agent("perello", "eta");
		await agent("perello", "sigma");
		await agent("cgt", "neo");
		await agent("cgt", "hal");
		await agent("cgt", "stray"); // active, in cgt, but NOT on cgt's roster
		await agent("cgt", "pi"); // a client agent that merely bears the name
		await agent("other-client", "themis");
		await agent("other-client", "pi");
		const org = (
			slug: string,
			allowedOrchestrators: string[],
			extra: Record<string, unknown>,
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: now,
				...extra,
			} as never);
		await org("perello", ["pi", "eta", "sigma"], {
			orgKind: "operator",
			allowedAgentIds: [
				made["perello/pi"].id,
				made["perello/eta"].id,
				made["perello/sigma"].id,
			],
		});
		await org("cgt", ["neo", "hal", "pi"], {
			allowedAgentIds: [
				made["cgt/neo"].id,
				made["cgt/hal"].id,
				made["cgt/pi"].id,
			],
			addressableFleetCoordinators: ["pi"],
			addressableFleetCoordinatorIds: [made["perello/pi"].id],
		});
		await org("other-client", ["themis", "pi"], {
			allowedAgentIds: [made["other-client/themis"].id, made["other-client/pi"].id],
		});
		for (const role of ["pi", "eta", "sigma", "neo", "hal", "themis", "stray"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: role,
				name: role,
				static: { role, workspace: "test", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 1 },
			});
		}
	});
	return {
		t,
		pi: made["perello/pi"],
		eta: made["perello/eta"],
		sigma: made["perello/sigma"],
		neo: made["cgt/neo"],
		hal: made["cgt/hal"],
		stray: made["cgt/stray"],
		cgtPi: made["cgt/pi"],
		themis: made["other-client/themis"],
	};
}
type World = Awaited<ReturnType<typeof world>>;

// The MCP forwards the acting agent BY ID (a proven actor).
const proven = (w: World, s: Agent, to: { channel: string } | { ids: Agent[] }) =>
	asService(w.t).mutation(api.messages.sendMessage, {
		from: s.name,
		content: "hello",
		...("channel" in to
			? { channel: to.channel }
			: { recipientAgentIds: to.ids.map((a) => a.id) }),
		verifiedActor: { agentId: s.id, orgSlug: s.org },
		...(s.org === "perello" ? {} : { seatOrgSlug: s.org }),
	} as never);

// An operator-org admin speaking as an agent of its roster with that agent's
// credential (no proven actor, so no principal reaches the core).
const unproven = async (
	w: World,
	s: Agent,
	to: { channel: string } | { ids: Agent[] },
) => {
	const admin = w.t.withIdentity({
		subject: `admin-of-${s.org}`,
		org_slug: s.org,
		org_id: testClerkOrgId(s.org),
		org_role: "org:admin",
	} as Identity);
	await ownAgent(w.t, s.org, s.name);
	const minted = await admin.mutation(api.agentCredentials.mintAgentCredential, {
		agentId: s.id,
	});
	return await admin.mutation(api.messages.sendMessage, {
		from: s.name,
		content: "hello",
		agentCredentialSecret: minted.secret,
		...("channel" in to
			? { channel: to.channel }
			: { recipientAgentIds: to.ids.map((a) => a.id) }),
	} as never);
};

const counts = (w: World) =>
	w.t.run(async (ctx) => ({
		messages: (await ctx.db.query("messages").collect()).length,
		receipts: (await ctx.db.query("messageReceipts").collect()).length,
	}));

const inbox = (w: World, recipient: Agent) =>
	asService(w.t).query(api.messages.checkNewMessagesEnvelope, {
		recipient: recipient.name,
		verifiedOrg: { orgSlug: recipient.org },
	});

const refused = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : String(e);
	}
	throw new Error("expected a refusal, the call succeeded");
};

describe("DELIVERED: a listed coordinator answers a roster agent", () => {
	test("pi -> 'neo' by NAME (proven actor): stamped in cgt, receipt keyed by neo's ID, read by neo", async () => {
		const w = await world();
		const id = await proven(w, w.pi, { channel: "neo" });
		const message = await w.t.run((ctx) => ctx.db.get(id));
		expect(message?.tenantId).toBe("cgt");
		expect(message?.fromId).toBe(w.pi.id);
		const receipts = await w.t.run((ctx) => ctx.db.query("messageReceipts").collect());
		expect(receipts.map((r) => [r.recipientId, r.tenantId])).toEqual([
			[w.neo.id, "cgt"],
		]);
		expect((await inbox(w, w.neo)).messages.map((m) => m.content)).toEqual(["hello"]);
		expect((await inbox(w, w.hal)).messages).toEqual([]);
	});

	test("pi -> 'neo,hal' by NAME: one message, one receipt each", async () => {
		const w = await world();
		await proven(w, w.pi, { channel: "neo,hal" });
		expect(await counts(w)).toEqual({ messages: 1, receipts: 2 });
	});

	test("pi -> neo BY ID (proven actor): delivered and read by neo", async () => {
		const w = await world();
		await proven(w, w.pi, { ids: [w.neo] });
		expect((await inbox(w, w.neo)).messages.map((m) => m.content)).toEqual(["hello"]);
	});

	test("pi -> 'neo' by NAME (operator credential, no proven actor): delivered and read", async () => {
		const w = await world();
		await unproven(w, w.pi, { channel: "neo" });
		expect((await inbox(w, w.neo)).messages.map((m) => m.content)).toEqual(["hello"]);
	});

	test("pi -> neo BY ID (operator credential, no proven actor): delivered and read", async () => {
		const w = await world();
		await unproven(w, w.pi, { ids: [w.neo] });
		expect((await inbox(w, w.neo)).messages.map((m) => m.content)).toEqual(["hello"]);
	});

	test("inbound unchanged: neo -> pi BY ID delivered in cgt's tenant", async () => {
		const w = await world();
		const id = await proven(w, w.neo, { ids: [w.pi] });
		const message = await w.t.run((ctx) => ctx.db.get(id));
		expect(message?.tenantId).toBe("cgt");
		const receipts = await w.t.run((ctx) => ctx.db.query("messageReceipts").collect());
		expect(receipts.map((r) => r.recipientId)).toEqual([w.pi.id]);
	});
});

describe("REFUSED: nothing is written", () => {
	test("eta (not listed by cgt) -> 'neo' by name and by ID, proven or not", async () => {
		const w = await world();
		await refused(proven(w, w.eta, { channel: "neo" }));
		await refused(proven(w, w.eta, { ids: [w.neo] }));
		await refused(unproven(w, w.eta, { channel: "neo" }));
		await refused(unproven(w, w.eta, { ids: [w.neo] }));
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("pi -> other-client's themis (that org lists nobody), by name and by ID", async () => {
		const w = await world();
		await refused(proven(w, w.pi, { channel: "themis" }));
		await refused(proven(w, w.pi, { ids: [w.themis] }));
		await refused(unproven(w, w.pi, { channel: "themis" }));
		await refused(unproven(w, w.pi, { ids: [w.themis] }));
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("pi -> a cgt agent that is NOT on cgt's roster ('stray'): refused", async () => {
		const w = await world();
		await refused(proven(w, w.pi, { channel: "stray" }));
		await refused(proven(w, w.pi, { ids: [w.stray] }));
		await refused(unproven(w, w.pi, { ids: [w.stray] }));
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("a CLIENT agent bearing the name 'pi' (other-client) is not the coordinator", async () => {
		const w = await world();
		const impostor = { id: w.themis.id, org: "other-client", name: "pi" };
		await refused(
			asService(w.t).mutation(api.messages.sendMessage, {
				from: "pi",
				content: "x",
				channel: "neo",
				verifiedActor: { agentId: impostor.id, orgSlug: "other-client" },
				seatOrgSlug: "other-client",
			} as never),
		);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("own-roster + client names in one list span two tenants: refused", async () => {
		const w = await world();
		await refused(proven(w, w.pi, { channel: "sigma,neo" }));
		await refused(proven(w, w.pi, { ids: [w.sigma, w.neo] }));
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("a broadcast from pi never reaches cgt's agents", async () => {
		const w = await world();
		await proven(w, w.pi, { channel: "broadcast" }).catch(() => undefined);
		expect((await inbox(w, w.neo)).messages).toEqual([]);
		expect((await inbox(w, w.hal)).messages).toEqual([]);
	});
});
