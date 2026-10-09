/// <reference types="vite/client" />
//
// VantagePeers Cloud — client mail to a fleet agent travels BY ID.
// Operator ruling: identity by ID, never by name. A client org T lists a fleet
// coordinator ("pi") by NAME on its roster, but the agent that reads that mail
// is an `agents` row of the OPERATOR org. The receipt is written in T's tenant;
// the name is resolved ONCE at write time inside the operator org and stamped as
// `recipientId`; the operator agent's verified reader recognises the ID whatever
// the tenant. A name is never matched across orgs at read time.
//
// Poles:
//   DELIVERED  globex clio -> "pi" (channel) and -> pi's ID (recipientAgentIds):
//              the receipt carries the OPERATOR pi's ID; pi reads and marks it.
//   OTHER ORG  acme's own "pi", and initech's own "pi", do not read it; initech's
//              own pi gets initech's mail, never the operator's.
//   REFUSED    recipientAgentIds to an operator agent off the sender's roster.
//   UNSET      two active operator agents of the name, or no operator agent: no ID.
//   BACKFILL   dry run counts, writes nothing; write run stamps; in-org first;
//              off-roster stays unknownAgent.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const FLEET = "fleet-op";
const GLOBEX = "globex";
const ACME = "acme";
const INITECH = "initech";

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

type World = {
	t: T;
	opPi: Id<"agents">;
	opEta: Id<"agents">;
	globexClio: Id<"agents">;
	acmePi: Id<"agents">;
	acmeBob: Id<"agents">;
	initechPi: Id<"agents">;
	initechZed: Id<"agents">;
};

async function world(): Promise<World> {
	const t = createT();
	const ids: Record<string, Id<"agents">> = {};
	await t.run(async (ctx) => {
		const now = Date.now();
		const org = (
			clerkOrgSlug: string,
			allowedOrchestrators: string[],
			orgKind?: "operator",
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug,
				allowedOrchestrators,
				scopes: ["view-own-tasks"],
				displayName: clerkOrgSlug,
				isActive: true,
				createdAt: now,
				...(orgKind ? { orgKind } : {}),
			});
		await org(FLEET, ["*"], "operator");
		await org(GLOBEX, ["clio", "pi"]);
		await org(ACME, ["bob", "pi"]);
		await org(INITECH, ["zed", "pi"]);
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: name,
				isActive: true,
				createdAt: now,
			});
		ids.opPi = await agent(FLEET, "pi");
		ids.opEta = await agent(FLEET, "eta");
		ids.globexClio = await agent(GLOBEX, "clio");
		ids.acmePi = await agent(ACME, "pi");
		ids.acmeBob = await agent(ACME, "bob");
		ids.initechPi = await agent(INITECH, "pi");
		ids.initechZed = await agent(INITECH, "zed");
		for (const n of ["pi", "eta", "clio", "bob", "zed"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: n,
				name: n,
				static: { role: n, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 1 },
			});
		}
	});
	return {
		t,
		opPi: ids.opPi,
		opEta: ids.opEta,
		globexClio: ids.globexClio,
		acmePi: ids.acmePi,
		acmeBob: ids.acmeBob,
		initechPi: ids.initechPi,
		initechZed: ids.initechZed,
	};
}

// A client seat, as the MCP forwards it: the service account carrying the seat's
// verified org and acting agent BY ID.
const seatSends = (
	w: World,
	seat: { from: string; agentId: Id<"agents">; org: string },
	extra: Record<string, unknown>,
) =>
	asService(w.t).mutation(api.messages.sendMessage, {
		from: seat.from,
		content: "hello fleet",
		seatOrgSlug: seat.org,
		verifiedActor: { agentId: seat.agentId, orgSlug: seat.org },
		...extra,
	} as never);

const clioSends = (w: World, extra: Record<string, unknown>) =>
	seatSends(w, { from: "clio", agentId: w.globexClio, org: GLOBEX }, extra);

const readAs = (w: World, agentId: Id<"agents">, org: string) =>
	asService(w.t).query(api.messages.checkNewMessagesEnvelope, {
		verifiedActor: { agentId, orgSlug: org },
	});

const countAs = (w: World, agentId: Id<"agents">, org: string) =>
	asService(w.t).query(api.messages.getUnreadCount, {
		verifiedActor: { agentId, orgSlug: org },
	});

const receiptsOf = (w: World, messageId: Id<"messages">) =>
	w.t.run((ctx) =>
		ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", messageId))
			.collect(),
	);

async function errorOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : String(e);
	}
	throw new Error("expected a refusal, the call succeeded");
}

describe("DELIVERED — a client's mail to a fleet agent carries the fleet agent's ID", () => {
	test("channel 'pi': receipt in globex's tenant with the OPERATOR pi's ID; pi reads and marks it", async () => {
		const w = await world();
		const messageId = await clioSends(w, { channel: "pi" });
		const receipts = await receiptsOf(w, messageId);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].tenantId).toBe(GLOBEX);
		expect(receipts[0].recipient).toBe("pi");
		expect(receipts[0].recipientId).toBe(w.opPi);

		const inbox = await readAs(w, w.opPi, FLEET);
		expect(inbox.messages.map((m) => m.messageId)).toEqual([messageId]);
		expect(await countAs(w, w.opPi, FLEET)).toBe(1);

		const marked = await asService(w.t).mutation(api.messages.markAsRead, {
			receiptIds: [receipts[0]._id],
			verifiedActor: { agentId: w.opPi, orgSlug: FLEET },
		} as never);
		expect(marked).toBe(1);
		expect((await readAs(w, w.opPi, FLEET)).messages).toHaveLength(0);
		expect(await countAs(w, w.opPi, FLEET)).toBe(0);
	});

	test("recipientAgentIds [operator pi]: same receipt, same reader", async () => {
		const w = await world();
		const messageId = await clioSends(w, { recipientAgentIds: [w.opPi] });
		const receipts = await receiptsOf(w, messageId);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].tenantId).toBe(GLOBEX);
		expect(receipts[0].recipientId).toBe(w.opPi);
		const inbox = await readAs(w, w.opPi, FLEET);
		expect(inbox.messages.map((m) => m.messageId)).toEqual([messageId]);
		const marked = await asService(w.t).mutation(api.messages.markAsRead, {
			receiptIds: [receipts[0]._id],
			verifiedActor: { agentId: w.opPi, orgSlug: FLEET },
		} as never);
		expect(marked).toBe(1);
	});
});

describe("OTHER ORG — a name is never matched across orgs", () => {
	test("acme's and initech's own 'pi' do not read globex's mail to the operator pi", async () => {
		const w = await world();
		const byName = await clioSends(w, { channel: "pi" });
		const byId = await clioSends(w, { recipientAgentIds: [w.opPi] });
		for (const [id, org] of [
			[w.acmePi, ACME],
			[w.initechPi, INITECH],
		] as const) {
			expect((await readAs(w, id, org)).messages).toHaveLength(0);
			expect(await countAs(w, id, org)).toBe(0);
		}
		const all = await receiptsOf(w, byName).then(async (a) => [
			...a,
			...(await receiptsOf(w, byId)),
		]);
		await expect(
			asService(w.t).mutation(api.messages.markAsRead, {
				receiptIds: [all[0]._id],
				verifiedActor: { agentId: w.acmePi, orgSlug: ACME },
			} as never),
		).rejects.toThrow(/RBAC_DENIED.*messages:markAsRead/);
		const left = await w.t.run((ctx) => ctx.db.get(all[0]._id));
		expect(left?.readAt).toBeUndefined();
	});

	test("a tenant with its OWN 'pi' gets its own mail: in-org first, the operator pi gets nothing", async () => {
		const w = await world();
		const messageId = await seatSends(
			w,
			{ from: "zed", agentId: w.initechZed, org: INITECH },
			{ channel: "pi" },
		);
		const receipts = await receiptsOf(w, messageId);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].tenantId).toBe(INITECH);
		expect(receipts[0].recipientId).toBe(w.initechPi);
		expect((await readAs(w, w.initechPi, INITECH)).messages).toHaveLength(1);
		expect((await readAs(w, w.opPi, FLEET)).messages).toHaveLength(0);
	});

	test("acme's mail to 'pi' goes to acme's own pi; the operator pi reads only its own ID", async () => {
		const w = await world();
		await clioSends(w, { channel: "pi" });
		const bobMail = await seatSends(
			w,
			{ from: "bob", agentId: w.acmeBob, org: ACME },
			{ channel: "pi" },
		);
		const piInbox = await readAs(w, w.opPi, FLEET);
		// globex's mail only: acme has its own "pi", so bob's mail is acme's.
		expect(piInbox.messages).toHaveLength(1);
		expect((await readAs(w, w.acmePi, ACME)).messages).toHaveLength(1);
		// A receipt stamped for acmePi (own org) is not the operator pi's.
		await w.t.run((ctx) =>
			ctx.db.insert("messageReceipts", {
				messageId: bobMail,
				recipient: "pi",
				recipientId: w.acmePi,
				tenantId: ACME,
				readAt: undefined,
			}),
		);
		expect((await readAs(w, w.opPi, FLEET)).messages).toHaveLength(1);
	});
});

describe("REFUSED / UNSET", () => {
	test("recipientAgentIds to an operator agent NOT on the sender's roster: refused, nothing written", async () => {
		const w = await world();
		const msg = await errorOf(clioSends(w, { recipientAgentIds: [w.opEta] }));
		expect(msg).toMatch(/recipient-agent-not-addressable/);
		const n = await w.t.run(
			async (ctx) => (await ctx.db.query("messageReceipts").collect()).length,
		);
		expect(n).toBe(0);
	});

	test("an operator agent that is inactive is refused with the same code", async () => {
		const w = await world();
		await w.t.run((ctx) => ctx.db.patch(w.opPi, { isActive: false }));
		const msg = await errorOf(clioSends(w, { recipientAgentIds: [w.opPi] }));
		expect(msg).toMatch(/recipient-agent-not-addressable/);
	});

	test("two active operator agents of the name: the ID is left unset (ambiguous)", async () => {
		const w = await world();
		await w.t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: FLEET,
				name: "pi",
				normalizedName: "pi",
				isActive: true,
				createdAt: Date.now(),
			}),
		);
		const messageId = await clioSends(w, { channel: "pi" });
		const receipts = await receiptsOf(w, messageId);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].recipientId).toBeUndefined();
	});
});

describe("BACKFILL — a roster name resolves in the operator org, in-org first", () => {
	const run = internal.migrations.backfill_actor_ids.run;
	const seedReceipt = (w: World, tenantId: string, recipient: string) =>
		w.t.run(async (ctx) => {
			const messageId = await ctx.db.insert("messages", {
				from: "someone",
				channel: recipient,
				content: "legacy",
				tenantId,
				createdAt: Date.now(),
			});
			return await ctx.db.insert("messageReceipts", {
				messageId,
				recipient,
				tenantId,
				readAt: undefined,
			});
		});

	test("dry run counts it with pi's operator ID and writes nothing; the write run stamps it", async () => {
		const w = await world();
		const rosterReceipt = await seedReceipt(w, GLOBEX, "pi");
		const ownReceipt = await seedReceipt(w, INITECH, "pi");
		const offRoster = await seedReceipt(w, GLOBEX, "eta");

		const dry = await w.t.mutation(run, { table: "messageReceipts" });
		expect(dry.dryRun).toBe(true);
		const col = dry.columns.find((c) => c.column === "recipientId");
		// globex->pi (operator) and initech->pi (own); globex->eta stays unknown.
		expect(col?.toFill).toBe(2);
		expect(col?.filled).toBe(0);
		expect(col?.unknownAgent).toBe(1);
		expect(dry.undecidable.map((u) => u.rowId)).toEqual([offRoster]);
		const afterDry = await w.t.run((ctx) => ctx.db.get(rosterReceipt));
		expect(afterDry?.recipientId).toBeUndefined();

		const wet = await w.t.mutation(run, {
			table: "messageReceipts",
			dryRun: false,
		});
		expect(wet.columns.find((c) => c.column === "recipientId")?.filled).toBe(2);
		const rows = await w.t.run(async (ctx) => ({
			roster: (await ctx.db.get(rosterReceipt))?.recipientId,
			own: (await ctx.db.get(ownReceipt))?.recipientId,
			off: (await ctx.db.get(offRoster))?.recipientId,
		}));
		expect(rows).toEqual({ roster: w.opPi, own: w.initechPi, off: undefined });

		// Idempotent: the second write run finds both already set.
		const again = await w.t.mutation(run, {
			table: "messageReceipts",
			dryRun: false,
		});
		const c2 = again.columns.find((c) => c.column === "recipientId");
		expect(c2?.alreadySet).toBe(2);
		expect(c2?.filled).toBe(0);

		// And the stamped legacy receipt is now readable by the operator pi.
		expect((await readAs(w, w.opPi, FLEET)).messages).toHaveLength(1);
	});
});

describe("REPLY — an operator agent answers a client agent BY ID", () => {
	const fleetSends = (
		w: World,
		from: string,
		agentId: Id<"agents">,
		extra: Record<string, unknown>,
	) =>
		asService(w.t).mutation(api.messages.sendMessage, {
			from,
			content: "reply from the fleet",
			verifiedActor: { agentId, orgSlug: FLEET },
			...extra,
		} as never);
	const nothingWritten = async (w: World) =>
		w.t.run(async (ctx) => ({
			messages: (await ctx.db.query("messages").collect()).length,
			receipts: (await ctx.db.query("messageReceipts").collect()).length,
		}));

	test("pi (on globex's roster) -> a globex agent by ID: written in globex's tenant, the agent reads it", async () => {
		const w = await world();
		const messageId = await fleetSends(w, "pi", w.opPi, {
			recipientAgentIds: [w.globexClio],
		});
		const message = await w.t.run((ctx) => ctx.db.get(messageId));
		expect(message?.tenantId).toBe(GLOBEX);
		expect(message?.fromId).toBe(w.opPi);
		const receipts = await receiptsOf(w, messageId);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].tenantId).toBe(GLOBEX);
		expect(receipts[0].recipientId).toBe(w.globexClio);
		const inbox = await readAs(w, w.globexClio, GLOBEX);
		expect(inbox.messages.map((m) => m.messageId)).toEqual([messageId]);
		// Another org's agent does not read it.
		expect((await readAs(w, w.acmeBob, ACME)).messages).toHaveLength(0);
	});

	test("an operator agent NOT on globex's roster -> a globex agent by ID: refused, nothing written", async () => {
		const w = await world();
		const msg = await errorOf(
			fleetSends(w, "eta", w.opEta, { recipientAgentIds: [w.globexClio] }),
		);
		expect(msg).toMatch(/recipient-agent-not-addressable/);
		expect(await nothingWritten(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("an agent of another client org U -> a globex agent by ID: refused", async () => {
		const w = await world();
		const msg = await errorOf(
			seatSends(
				w,
				{ from: "bob", agentId: w.acmeBob, org: ACME },
				{ recipientAgentIds: [w.globexClio] },
			),
		);
		expect(msg).toMatch(/recipient-agent-not-addressable/);
		expect(await nothingWritten(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("pi -> agents of globex AND acme in one call: refused whole, nothing written", async () => {
		const w = await world();
		const msg = await errorOf(
			fleetSends(w, "pi", w.opPi, {
				recipientAgentIds: [w.globexClio, w.acmeBob],
			}),
		);
		expect(msg).toMatch(/recipient-agent-not-addressable/);
		expect(await nothingWritten(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("pi -> a globex agent plus an operator-org agent: refused whole", async () => {
		const w = await world();
		const msg = await errorOf(
			fleetSends(w, "pi", w.opPi, {
				recipientAgentIds: [w.globexClio, w.opEta],
			}),
		);
		expect(msg).toMatch(/recipient-agent-not-addressable/);
		expect(await nothingWritten(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("pi -> an inactive globex agent: the same single refusal", async () => {
		const w = await world();
		await w.t.run((ctx) => ctx.db.patch(w.globexClio, { isActive: false }));
		const msg = await errorOf(
			fleetSends(w, "pi", w.opPi, { recipientAgentIds: [w.globexClio] }),
		);
		expect(msg).toMatch(/recipient-agent-not-addressable/);
	});

	test("two active operator agents named pi: the reply is refused (the name is not unique)", async () => {
		const w = await world();
		await w.t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: FLEET,
				name: "pi",
				normalizedName: "pi",
				isActive: true,
				createdAt: Date.now(),
			}),
		);
		const msg = await errorOf(
			fleetSends(w, "pi", w.opPi, { recipientAgentIds: [w.globexClio] }),
		);
		expect(msg).toMatch(/recipient-agent-not-addressable/);
	});
});
