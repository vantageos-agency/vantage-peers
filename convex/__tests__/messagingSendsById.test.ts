/// <reference types="vite/client" />
//
// VantagePeers Cloud, module M5b (follow-up of M5, task k173069sdrkaapcqxz10h15btx8fz7rb):
// the sends M5 left by NAME now decide by agent ID. A channel label ("a,b") is only a
// way to FIND an agents row; the row is then judged by the same ID decision as
// `recipientAgentIds` (resolveRecipientAgents -> addressRecipientById / the ID roster).
//
// World: operator org fleet-op (pi, eta, nova), clients iris-rh (clio, helios, pi) and
// acme (helios, pi). iris-rh lists the fleet pi and the fleet nova as addressable
// coordinators; acme lists none. Both clients hold a "helios" and a "pi".
//
// Poles, per caller kind (client agent / operator agent / member session / seat with
// no actor / fleet service account):
//   DELIVERED  own org by label; a listed operator agent by label; an operator agent to
//              the one client agent that lists it; receipts keyed by the agent IDs.
//   REFUSED    a label with no agent (RBAC_DENIED, recipient-label-no-agent); a label
//              that finds several (recipient-label-ambiguous); a same-name agent of
//              another org is never reached.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
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
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: "user_member1",
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:editor",
	} as Identity);

type Agent = { id: Id<"agents">; org: string; name: string };
type World = { t: T; a: Record<string, Agent> };

async function world(): Promise<World> {
	const t = createT();
	const a: Record<string, Agent> = {};
	await t.run(async (ctx) => {
		const now = Date.now();
		const org = (slug: string, roster: string[], orgKind?: "operator") =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: roster,
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
				...(orgKind ? { orgKind } : {}),
			});
		const iris = await org("iris-rh", ["clio", "helios", "pi"]);
		const acme = await org("acme", ["helios", "pi"]);
		await org("fleet-op", ["*"], "operator");
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		// Profiles carry no tenant: the name-based path of the base accepted any of
		// these names for any caller it believed reachable.
		for (const o of ["pi", "eta", "nova", "clio", "helios"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: o,
				name: o,
				static: { role: o, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 0 },
			});
		}
		const agent = async (orgSlug: string, name: string) => {
			const id = await ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name,
				isActive: true,
				createdAt: now,
			});
			a[`${orgSlug}/${name}`] = { id, org: orgSlug, name };
		};
		for (const n of ["pi", "eta", "nova"]) await agent("fleet-op", n);
		for (const n of ["clio", "helios", "pi"]) await agent("iris-rh", n);
		for (const n of ["helios", "pi"]) await agent("acme", n);
		await ctx.db.patch(iris, {
			allowedAgentIds: ["clio", "helios", "pi"].map((n) => a[`iris-rh/${n}`].id),
			addressableFleetCoordinatorIds: [a["fleet-op/pi"].id, a["fleet-op/nova"].id],
		});
		await ctx.db.patch(acme, {
			allowedAgentIds: ["helios", "pi"].map((n) => a[`acme/${n}`].id),
		});
	});
	return { t, a };
}

async function errorOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		if (typeof data === "string") {
			try {
				const parsed: unknown = JSON.parse(data);
				return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
			} catch {
				return data;
			}
		}
		return data !== undefined ? JSON.stringify(data) : String(e);
	}
	throw new Error("expected a refusal, the call succeeded");
}

const counts = (w: World) =>
	w.t.run(async (ctx) => ({
		messages: (await ctx.db.query("messages").collect()).length,
		receipts: (await ctx.db.query("messageReceipts").collect()).length,
	}));

const receiptsOf = (w: World, id: Id<"messages">) =>
	w.t.run((ctx) =>
		ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", id))
			.collect(),
	);

const recipientsOf = async (w: World, id: Id<"messages">) =>
	(await receiptsOf(w, id)).map((r) => r.recipientId).sort();

// An agent speaking through the MCP: forwarded BY ID, plus the seat org for a client.
const agentSends = (w: World, sender: Agent, channel: string, extra: object = {}) =>
	asService(w.t).mutation(api.messages.sendMessage, {
		from: sender.name,
		content: "hello",
		channel,
		verifiedActor: { agentId: sender.id, orgSlug: sender.org },
		...(sender.org === "fleet-op" ? {} : { seatOrgSlug: sender.org }),
		...extra,
	} as never);

const NO_AGENT = '"reason":"recipient-label-no-agent"';
const AMBIGUOUS = '"reason":"recipient-label-ambiguous"';
const NOT_ADDRESSABLE = '"reason":"recipient-agent-not-addressable"';

describe("client agent (forwarded actor), channel by label", () => {
	test("own org labels resolve to the own org's agents, never a namesake of another org", async () => {
		const w = await world();
		const id = await agentSends(w, w.a["acme/pi"], "helios");
		expect(await recipientsOf(w, id)).toEqual([w.a["acme/helios"].id]);
		const m = await w.t.run((ctx) => ctx.db.get(id));
		expect(m?.tenantId).toBe("acme");
	});

	test("a listed operator agent is reached by label, in the client's tenant", async () => {
		const w = await world();
		const id = await agentSends(w, w.a["iris-rh/clio"], "nova");
		expect(await recipientsOf(w, id)).toEqual([w.a["fleet-op/nova"].id]);
		expect((await w.t.run((ctx) => ctx.db.get(id)))?.tenantId).toBe("iris-rh");
	});

	test("an operator agent the client does not list has no label here", async () => {
		const w = await world();
		const err = await errorOf(agentSends(w, w.a["iris-rh/clio"], "eta"));
		expect(err).toContain("RBAC_DENIED");
		expect(err).toContain(NO_AGENT);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("acme cannot reach the fleet nova by label: acme lists nobody", async () => {
		const w = await world();
		expect(await errorOf(agentSends(w, w.a["acme/pi"], "nova"))).toContain(NO_AGENT);
	});

	test("one absent label refuses the whole send, nothing written", async () => {
		const w = await world();
		const err = await errorOf(agentSends(w, w.a["iris-rh/clio"], "helios,ghost"));
		expect(err).toContain(NO_AGENT);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});
});

describe("operator agent (forwarded actor), channel by label", () => {
	test("reply direction: fleet pi -> the one client agent whose org lists it", async () => {
		const w = await world();
		const id = await agentSends(w, w.a["fleet-op/pi"], "clio");
		expect(await recipientsOf(w, id)).toEqual([w.a["iris-rh/clio"].id]);
		const m = await w.t.run((ctx) => ctx.db.get(id));
		expect(m?.tenantId).toBe("iris-rh");
		expect(m?.fromId).toBe(w.a["fleet-op/pi"].id);
	});

	test("the label 'helios' exists in acme too, but acme does not list the fleet pi: iris only", async () => {
		const w = await world();
		const id = await agentSends(w, w.a["fleet-op/pi"], "helios");
		expect(await recipientsOf(w, id)).toEqual([w.a["iris-rh/helios"].id]);
	});

	test("two client orgs both list the sender and both hold the label: ambiguous, refused", async () => {
		const w = await world();
		await w.t.run(async (ctx) => {
			const acme = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "acme"))
				.first();
			if (acme) {
				await ctx.db.patch(acme._id, {
					addressableFleetCoordinatorIds: [w.a["fleet-op/pi"].id],
				});
			}
		});
		const err = await errorOf(agentSends(w, w.a["fleet-op/pi"], "helios"));
		expect(err).toContain(AMBIGUOUS);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("fleet eta: no client lists it, so 'clio' names nobody it may address", async () => {
		const w = await world();
		const err = await errorOf(agentSends(w, w.a["fleet-op/eta"], "clio"));
		expect(err).toContain(NO_AGENT);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("removing the fleet pi from iris's list closes the label path too", async () => {
		const w = await world();
		await expect(agentSends(w, w.a["fleet-op/pi"], "clio")).resolves.toBeTruthy();
		await w.t.run(async (ctx) => {
			const iris = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "iris-rh"))
				.first();
			if (iris) await ctx.db.patch(iris._id, { addressableFleetCoordinatorIds: [] });
		});
		expect(await errorOf(agentSends(w, w.a["fleet-op/pi"], "clio"))).toContain(NO_AGENT);
	});

	test("an inactive client agent found by label is refused as not addressable", async () => {
		const w = await world();
		await w.t.run((ctx) => ctx.db.patch(w.a["iris-rh/clio"].id, { isActive: false }));
		expect(await errorOf(agentSends(w, w.a["fleet-op/pi"], "clio"))).toContain(
			NOT_ADDRESSABLE,
		);
	});
});

describe("member session (Clerk user, no forwarded agent)", () => {
	test("a member's label resolves in the member's org by ID roster; the namesake of acme is untouched", async () => {
		const w = await world();
		const id = await asMember(w.t, "iris-rh").mutation(api.messages.sendMessage, {
			content: "hi",
			channel: "helios",
		});
		expect(await recipientsOf(w, id)).toEqual([w.a["iris-rh/helios"].id]);
		expect((await w.t.run((ctx) => ctx.db.get(id)))?.tenantId).toBe("iris-rh");
	});

	test("a member whose org's roster does not list the agent is refused, even though the agent exists in its org", async () => {
		const w = await world();
		await w.t.run(async (ctx) => {
			const iris = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "iris-rh"))
				.first();
			if (iris) {
				await ctx.db.patch(iris._id, { allowedAgentIds: [w.a["iris-rh/clio"].id] });
			}
		});
		const err = await errorOf(
			asMember(w.t, "iris-rh").mutation(api.messages.sendMessage, {
				content: "hi",
				channel: "helios",
			}),
		);
		expect(err).toContain("RBAC_DENIED");
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("a label that names an agent only in another org (or a fleet coordinator) is refused with a named code", async () => {
		const w = await world();
		for (const label of ["nova", "eta", "ghost"]) {
			const err = await errorOf(
				asMember(w.t, "iris-rh").mutation(api.messages.sendMessage, {
					content: "hi",
					channel: label,
				}),
			);
			expect(err).toContain("RBAC_DENIED");
			expect(err).toContain(NO_AGENT);
		}
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});
});

describe("seat with no forwarded agent (service account + seatOrgSlug)", () => {
	const seatSends = (w: World, org: string, from: string, channel: string) =>
		asService(w.t).mutation(api.messages.sendMessage, {
			from,
			content: "hello",
			channel,
			seatOrgSlug: org,
		} as never);

	test("own org label by ID roster; listed coordinator by label; namesake of another org never", async () => {
		const w = await world();
		const own = await seatSends(w, "acme", "pi", "helios");
		expect(await recipientsOf(w, own)).toEqual([w.a["acme/helios"].id]);
		const coord = await seatSends(w, "iris-rh", "clio", "nova");
		expect(await recipientsOf(w, coord)).toEqual([w.a["fleet-op/nova"].id]);
		expect(await errorOf(seatSends(w, "acme", "pi", "nova"))).toContain(NO_AGENT);
	});
});

describe("fleet service account, no forwarded agent: grants unchanged, labels by ID in the operator org", () => {
	const fleetSends = (w: World, channel: string, extra: object = {}) =>
		asService(w.t).mutation(api.messages.sendMessage, {
			from: "pi",
			content: "hello",
			channel,
			...extra,
		} as never);

	test("'pi' reaches the OPERATOR org's pi, not the namesakes of iris-rh or acme", async () => {
		const w = await world();
		const id = await fleetSends(w, "eta");
		expect(await recipientsOf(w, id)).toEqual([w.a["fleet-op/eta"].id]);
		const id2 = await fleetSends(w, "nova,eta");
		expect(await recipientsOf(w, id2)).toEqual(
			[w.a["fleet-op/nova"].id, w.a["fleet-op/eta"].id].sort(),
		);
	});

	test("a label held only by client orgs ('helios') is not matched across orgs", async () => {
		const w = await world();
		const err = await errorOf(fleetSends(w, "helios"));
		expect(err).toContain("RBAC_DENIED");
		expect(err).toContain(NO_AGENT);
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("with a declared tenant the label resolves in THAT org by ID", async () => {
		const w = await world();
		const id = await fleetSends(w, "helios", { tenantId: "iris-rh" });
		expect(await recipientsOf(w, id)).toEqual([w.a["iris-rh/helios"].id]);
	});

	test("an absent label is refused with a named code", async () => {
		const w = await world();
		expect(await errorOf(fleetSends(w, "ghost"))).toContain(NO_AGENT);
	});
});
