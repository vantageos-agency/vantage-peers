/// <reference types="vite/client" />
//
// VantagePeers Cloud — explicit agent link (task k17965eh23twqzsbjc8mjgfcmx8gpxmh).
//
// pi (an agent of the organisation `perello`) and victor (an agent of `acme-hr`)
// must reach each other, in two organisations. The cross-org NAME match is closed;
// the one way across is an agent link decided by @vantageos/cloud-identity 0.23.0
// (`buildAgentLink` / `resolveAgentLink`):
//   - DIRECTIONAL: pi -> victor says nothing about victor -> pi;
//   - GRANTED by an ADMIN of the TARGET organisation, as the verified person;
//   - EXACT PAIR, STANDING, revocable (`revokedAt`), voided when the grantor stops
//     being an admin of the target organisation.
//
// Every permission is tested in BOTH directions, under SCOPED identities (an org
// admin's session, an org member's session): the grant door never runs as the
// master or the service account. The consumption doors (sendMessage, tasks)
// receive the proven calling agent from the MCP transport (`verifiedActor`), which
// exists only on the service account; the permission under test there is the
// link, and every refusal pole asserts NOTHING was written.
//
//   GRANT     admin of target stores the row; grantedBy is the verified subject;
//             member of target / admin of source only / anonymous / unsynced
//             membership / same-org pair refused; `grantedBy` is not an argument.
//   MESSAGES  linked send delivered into the TARGET's tenant and inbox, not in any
//             other org; reverse without its own link refused; revoked refused;
//             grantor demoted or removed refused; a NAME channel still refused;
//             a third agent of the same two orgs is not covered.
//   TASKS     linked create / update stamps the target org and the target agent,
//             visible to the target's members and to nobody else; unlinked refused.

import { ConvexError } from "convex/values";
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

const PERELLO = "perello-consulting";
const IRIS = "acme-hr";
const ACME = "acme";
const REASON = "HR onboarding coordination between the two organisations";

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const person = (
	t: T,
	org: string,
	subject: string,
	role: "org:admin" | "org:member",
) =>
	t.withIdentity({
		subject,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Identity);

const MARIE = "user_marie"; // admin of acme-hr
const LAURENT = "user_laurent"; // admin of perello-consulting
const BOB = "user_bob"; // plain member of acme-hr
const ZOE = "user_zoe"; // admin of acme

type World = {
	t: T;
	pi: Id<"agents">;
	victor: Id<"agents">;
	clio: Id<"agents">; // a third agent of acme-hr
	ada: Id<"agents">; // an agent of acme
};

async function world(): Promise<World> {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		const now = Date.now();
		const org = (slug: string, orchestrators: string[], orgKind?: "operator") =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: orchestrators,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: now,
				...(orgKind ? { orgKind } : {}),
			});
		const perello = await org(PERELLO, ["pi"]);
		const iris = await org(IRIS, ["victor", "clio"]);
		await org(ACME, ["ada"]);
		await org("fleet-op", ["*"], "operator");
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name,
				isActive: true,
				createdAt: now,
			});
		const pi = await agent(PERELLO, "pi");
		const victor = await agent(IRIS, "victor");
		const clio = await agent(IRIS, "clio");
		const ada = await agent(ACME, "ada");
		await ctx.db.patch(perello, { allowedAgentIds: [pi] });
		await ctx.db.patch(iris, { allowedAgentIds: [victor, clio] });
		const member = (
			orgSlug: string,
			userId: string,
			role: "admin" | "member",
		) =>
			ctx.db.insert("orgMembership", {
				clerkOrgSlug: orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				clerkUserId: userId,
				role,
				createdAt: now,
				updatedAt: now,
			});
		await member(IRIS, MARIE, "admin");
		await member(IRIS, BOB, "member");
		await member(PERELLO, LAURENT, "admin");
		await member(ACME, ZOE, "admin");
		return { pi, victor, clio, ada };
	});
	return { t, ...ids };
}

async function errorOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ConvexError) return String(e.data);
		// A door that does not exist is not a refusal: it must never pass a pole.
		if (/Could not find module|is not a function|undefined/i.test(String(e))) {
			throw e;
		}
		return String(e);
	}
	throw new Error("expected a refusal, the call succeeded");
}

const linkRows = (t: T) =>
	t.run((ctx) =>
		(
			ctx.db as unknown as {
				query: (table: string) => { collect: () => Promise<unknown[]> };
			}
		)
			.query("agentLinks")
			.collect(),
	);
const messageRows = (t: T) =>
	t.run((ctx) => ctx.db.query("messages").collect());
const receiptRows = (t: T) =>
	t.run((ctx) => ctx.db.query("messageReceipts").collect());
const taskRows = (t: T) => t.run((ctx) => ctx.db.query("tasks").collect());

/** Marie (admin of acme-hr) grants pi -> victor, the TARGET side's admin. */
const marieGrantsPiToVictor = (w: World) =>
	person(w.t, IRIS, MARIE, "org:admin").mutation(api.agentLinks.grant, {
		fromAgentId: w.pi,
		toAgentId: w.victor,
		reason: REASON,
	});
/** Laurent (admin of perello) grants victor -> pi. */
const laurentGrantsVictorToPi = (w: World) =>
	person(w.t, PERELLO, LAURENT, "org:admin").mutation(api.agentLinks.grant, {
		fromAgentId: w.victor,
		toAgentId: w.pi,
		reason: REASON,
	});

// An agent's seat, as the MCP forwards it: the service account carries the
// seat's verified org and the acting agent BY ID.
const piSends = (w: World, extra: Record<string, unknown>) =>
	asService(w.t).mutation(api.messages.sendMessage, {
		from: "pi",
		content: "hello victor",
		seatOrgSlug: PERELLO,
		verifiedActor: { agentId: w.pi, orgSlug: PERELLO },
		...extra,
	} as never);
const victorSends = (w: World, extra: Record<string, unknown>) =>
	asService(w.t).mutation(api.messages.sendMessage, {
		from: "victor",
		content: "hello pi",
		seatOrgSlug: IRIS,
		verifiedActor: { agentId: w.victor, orgSlug: IRIS },
		...extra,
	} as never);
const inbox = (w: World, recipient: string, orgSlug: string) =>
	asService(w.t).query(api.messages.checkNewMessagesEnvelope, {
		recipient,
		verifiedOrg: { orgSlug },
	});

const piCreatesTask = (w: World, extra: Record<string, unknown> = {}) =>
	asService(w.t).mutation(api.tasks.create, {
		title: "cross-org task",
		priority: "low",
		status: "todo",
		createdBy: "pi",
		assignedToAgentId: w.victor,
		verifiedActor: { agentId: w.pi, orgSlug: PERELLO },
		...extra,
	} as never);

const listAs = (
	w: World,
	org: string,
	subject: string,
): Promise<Array<{ title: string; assignedToId?: string; orgId?: string }>> =>
	person(w.t, org, subject, "org:admin").query(api.tasks.list, {}) as never;

/** Marie revokes pi -> victor. */
const marieRevokesPiToVictor = (w: World) =>
	person(w.t, IRIS, MARIE, "org:admin").mutation(api.agentLinks.revoke, {
		fromAgentId: w.pi,
		toAgentId: w.victor,
	});

/** Mark an organisation inactive on its mapping row (`client_org_mapping.isActive`). */
const deactivateOrg = (w: World, slug: string) =>
	w.t.run(async (ctx) => {
		const m = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.unique();
		if (m === null) throw new Error("fixture: no mapping");
		await ctx.db.patch(m._id, { isActive: false });
	});

// ─────────────────────────────────────────────────────────────────────────────
describe("GRANT — the admin of the TARGET organisation, as the verified person", () => {
	test("Marie (admin of acme-hr) grants pi -> victor: one row, grantedBy is her verified subject", async () => {
		const w = await world();
		const id = await marieGrantsPiToVictor(w);
		expect(id).toBeTruthy();
		const rows = (await linkRows(w.t)) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			orgSlug: IRIS,
			fromAgentId: w.pi,
			fromOrgId: testClerkOrgId(PERELLO),
			toAgentId: w.victor,
			toOrgId: testClerkOrgId(IRIS),
			grantedBy: MARIE,
			reason: REASON,
		});
		expect(rows[0].revokedAt ?? null).toBeNull();
	});

	test("REFUSED: a plain MEMBER of the target organisation", async () => {
		const w = await world();
		const msg = await errorOf(
			person(w.t, IRIS, BOB, "org:member").mutation(api.agentLinks.grant, {
				fromAgentId: w.pi,
				toAgentId: w.victor,
				reason: REASON,
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: an admin of an INACTIVE target organisation cannot grant, nothing is written", async () => {
		const w = await world();
		await deactivateOrg(w, IRIS);
		const msg = await errorOf(
			person(w.t, IRIS, MARIE, "org:admin").mutation(api.agentLinks.grant, {
				fromAgentId: w.pi,
				toAgentId: w.victor,
				reason: REASON,
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: an admin of the SOURCE organisation only (the grant is the receiving side's)", async () => {
		const w = await world();
		const msg = await errorOf(
			person(w.t, PERELLO, LAURENT, "org:admin").mutation(
				api.agentLinks.grant,
				{ fromAgentId: w.pi, toAgentId: w.victor, reason: REASON },
			),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: an admin of a THIRD organisation", async () => {
		const w = await world();
		await errorOf(
			person(w.t, ACME, ZOE, "org:admin").mutation(api.agentLinks.grant, {
				fromAgentId: w.pi,
				toAgentId: w.victor,
				reason: REASON,
			}),
		);
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: anonymous", async () => {
		const w = await world();
		const msg = await errorOf(
			w.t.mutation(api.agentLinks.grant, {
				fromAgentId: w.pi,
				toAgentId: w.victor,
				reason: REASON,
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: a session claiming admin whose stored membership is not an admin row", async () => {
		const w = await world();
		// Bob's stored membership is `member`; his session claims org:admin.
		await errorOf(
			person(w.t, IRIS, BOB, "org:admin").mutation(api.agentLinks.grant, {
				fromAgentId: w.pi,
				toAgentId: w.victor,
				reason: REASON,
			}),
		);
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: the service account may not grant (no person, no link)", async () => {
		const w = await world();
		await errorOf(
			asService(w.t).mutation(api.agentLinks.grant, {
				fromAgentId: w.pi,
				toAgentId: w.victor,
				reason: REASON,
			}),
		);
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("`grantedBy` is not an argument: passing it is rejected and nothing is stored", async () => {
		const w = await world();
		const msg = await errorOf(
			person(w.t, IRIS, MARIE, "org:admin").mutation(api.agentLinks.grant, {
				fromAgentId: w.pi,
				toAgentId: w.victor,
				reason: REASON,
				grantedBy: "user_someone_else",
			} as never),
		);
		expect(msg).toMatch(/grantedBy|extra field|Validator/i);
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: both agents of one organisation (a link is for two organisations)", async () => {
		const w = await world();
		await errorOf(
			person(w.t, IRIS, MARIE, "org:admin").mutation(api.agentLinks.grant, {
				fromAgentId: w.clio,
				toAgentId: w.victor,
				reason: REASON,
			}),
		);
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: a trivial reason", async () => {
		const w = await world();
		await errorOf(
			person(w.t, IRIS, MARIE, "org:admin").mutation(api.agentLinks.grant, {
				fromAgentId: w.pi,
				toAgentId: w.victor,
				reason: "ok",
			}),
		);
		expect(await linkRows(w.t)).toHaveLength(0);
	});

	test("a second grant of the same pair keeps ONE row (re-grant, never a duplicate)", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await marieGrantsPiToVictor(w);
		expect(await linkRows(w.t)).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("REVOKE — an admin of the TARGET organisation", () => {
	test("Marie revokes pi -> victor: revokedAt is set", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await person(w.t, IRIS, MARIE, "org:admin").mutation(
			api.agentLinks.revoke,
			{ fromAgentId: w.pi, toAgentId: w.victor },
		);
		const rows = (await linkRows(w.t)) as Array<{ revokedAt?: number | null }>;
		expect(typeof rows[0].revokedAt).toBe("number");
	});

	test("REFUSED: a member of the target organisation, the source's admin, anonymous", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		const args = { fromAgentId: w.pi, toAgentId: w.victor };
		await errorOf(
			person(w.t, IRIS, BOB, "org:member").mutation(
				api.agentLinks.revoke,
				args,
			),
		);
		await errorOf(
			person(w.t, PERELLO, LAURENT, "org:admin").mutation(
				api.agentLinks.revoke,
				args,
			),
		);
		await errorOf(w.t.mutation(api.agentLinks.revoke, args));
		const rows = (await linkRows(w.t)) as Array<{ revokedAt?: number | null }>;
		expect(rows[0].revokedAt ?? null).toBeNull();
	});

	test("REFUSED: a link whose stored toOrgId is not the target agent's current org changes nothing", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		// The stored link names an organisation other than victor's current one.
		await w.t.run(async (ctx) => {
			const db = ctx.db as unknown as {
				query: (t: string) => {
					unique: () => Promise<{ _id: Id<"agentLinks"> }>;
				};
				patch: (id: Id<"agentLinks">, v: object) => Promise<void>;
			};
			const row = await db.query("agentLinks").unique();
			await db.patch(row._id, { toOrgId: testClerkOrgId(ACME) });
		});
		const msg = await errorOf(marieRevokesPiToVictor(w));
		expect(msg).toContain("AGENT_LINK_NOT_FOUND");
		const rows = (await linkRows(w.t)) as Array<{ revokedAt?: number | null }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].revokedAt ?? null).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("MESSAGES — recipientAgentIds across two organisations", () => {
	test("with the link, pi -> victor is delivered into acme-hr's tenant and victor's inbox only", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		const messageId = await piSends(w, { recipientAgentIds: [w.victor] });
		const message = await w.t.run((ctx) => ctx.db.get(messageId));
		expect(message?.tenantId).toBe(IRIS);
		expect(message?.fromId).toBe(w.pi);
		const receipts = await receiptRows(w.t);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].recipientId).toBe(w.victor);
		expect(receipts[0].tenantId).toBe(IRIS);

		const victorInbox = await inbox(w, "victor", IRIS);
		expect(victorInbox.messages.map((m) => m.content)).toEqual([
			"hello victor",
		]);
		expect(victorInbox.messages[0].from).toBe("pi");
		// Not in any other organisation's inbox: acme's, nor pi's own.
		expect((await inbox(w, "ada", ACME)).messages).toEqual([]);
		expect((await inbox(w, "pi", PERELLO)).messages).toEqual([]);
	});

	test("REFUSED: without any link, nothing is written", async () => {
		const w = await world();
		await errorOf(piSends(w, { recipientAgentIds: [w.victor] }));
		expect(await messageRows(w.t)).toHaveLength(0);
		expect(await receiptRows(w.t)).toHaveLength(0);
	});

	test("REVERSE: victor -> pi is refused while only pi -> victor exists, delivered once the operator grants it", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await errorOf(victorSends(w, { recipientAgentIds: [w.pi] }));
		expect(await messageRows(w.t)).toHaveLength(0);

		await laurentGrantsVictorToPi(w);
		const messageId = await victorSends(w, { recipientAgentIds: [w.pi] });
		const message = await w.t.run((ctx) => ctx.db.get(messageId));
		expect(message?.tenantId).toBe(PERELLO);
		const piInbox = await inbox(w, "pi", PERELLO);
		expect(piInbox.messages.map((m) => m.content)).toEqual(["hello pi"]);
		expect((await inbox(w, "victor", IRIS)).messages).toEqual([]);
	});

	test("REFUSED after revoke", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await piSends(w, { recipientAgentIds: [w.victor] });
		await person(w.t, IRIS, MARIE, "org:admin").mutation(
			api.agentLinks.revoke,
			{ fromAgentId: w.pi, toAgentId: w.victor },
		);
		await errorOf(piSends(w, { recipientAgentIds: [w.victor] }));
		expect(await messageRows(w.t)).toHaveLength(1);
	});

	test("REFUSED when the grantor loses the admin role (membership downgraded)", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await w.t.run(async (ctx) => {
			const row = await ctx.db
				.query("orgMembership")
				.withIndex("by_org_user_clerk_id", (q) =>
					q.eq("clerkOrgId", testClerkOrgId(IRIS)).eq("clerkUserId", MARIE),
				)
				.unique();
			if (row === null) throw new Error("fixture: no membership");
			await ctx.db.patch(row._id, { role: "member" });
		});
		await errorOf(piSends(w, { recipientAgentIds: [w.victor] }));
		expect(await messageRows(w.t)).toHaveLength(0);
	});

	test("REFUSED when the grantor leaves the organisation (membership tombstoned)", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await w.t.run(async (ctx) => {
			const row = await ctx.db
				.query("orgMembership")
				.withIndex("by_org_user_clerk_id", (q) =>
					q.eq("clerkOrgId", testClerkOrgId(IRIS)).eq("clerkUserId", MARIE),
				)
				.unique();
			if (row === null) throw new Error("fixture: no membership");
			await ctx.db.patch(row._id, { deletedAt: Date.now() });
		});
		await errorOf(piSends(w, { recipientAgentIds: [w.victor] }));
		expect(await messageRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: a third agent of the same two organisations is not covered by pi -> victor", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await errorOf(piSends(w, { recipientAgentIds: [w.clio] }));
		expect(await messageRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: a NAME channel to an agent of another organisation stays refused, link or not", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await errorOf(piSends(w, { channel: "victor" }));
		expect(await messageRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: an UNPROVEN caller does not inherit the link (no verifiedActor)", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await errorOf(
			asService(w.t).mutation(api.messages.sendMessage, {
				from: "pi",
				content: "hello victor",
				seatOrgSlug: PERELLO,
				recipientAgentIds: [w.victor],
			} as never),
		);
		expect(await messageRows(w.t)).toHaveLength(0);
	});

	test("a RE-GRANT after a revoke delivers again (the revocation is cleared, one row)", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await marieRevokesPiToVictor(w);
		await errorOf(piSends(w, { recipientAgentIds: [w.victor] }));
		expect(await messageRows(w.t)).toHaveLength(0);

		await marieGrantsPiToVictor(w);
		const rows = (await linkRows(w.t)) as Array<{ revokedAt?: number | null }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].revokedAt ?? null).toBeNull();
		const messageId = await piSends(w, { recipientAgentIds: [w.victor] });
		const message = await w.t.run((ctx) => ctx.db.get(messageId));
		expect(message?.tenantId).toBe(IRIS);
		expect(
			(await inbox(w, "victor", IRIS)).messages.map((m) => m.content),
		).toEqual(["hello victor"]);
	});

	test("REFUSED: the TARGET organisation is inactive, a live link does not reach it, nothing is written", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await deactivateOrg(w, IRIS);
		await errorOf(piSends(w, { recipientAgentIds: [w.victor] }));
		expect(await messageRows(w.t)).toHaveLength(0);
		expect(await receiptRows(w.t)).toHaveLength(0);
	});

	test("same-organisation sends are unchanged", async () => {
		const w = await world();
		const messageId = await asService(w.t).mutation(api.messages.sendMessage, {
			from: "clio",
			content: "hi",
			seatOrgSlug: IRIS,
			verifiedActor: { agentId: w.clio, orgSlug: IRIS },
			recipientAgentIds: [w.victor],
		} as never);
		const message = await w.t.run((ctx) => ctx.db.get(messageId));
		expect(message?.tenantId).toBe(IRIS);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("TASKS — assignedToAgentId across two organisations", () => {
	test("create with the link: the task is stamped to acme-hr and victor, visible to acme-hr only", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		const taskId = await piCreatesTask(w);
		const row = await w.t.run((ctx) => ctx.db.get(taskId as Id<"tasks">));
		expect(row?.orgId).toBe(IRIS);
		expect(row?.clerkOrgId).toBe(testClerkOrgId(IRIS));
		expect(row?.assignedToId).toBe(w.victor);
		expect(row?.assignedTo).toBe("victor");
		expect(row?.createdById).toBe(w.pi);

		expect((await listAs(w, IRIS, MARIE)).map((r) => r.title)).toEqual([
			"cross-org task",
		]);
		expect(await listAs(w, ACME, ZOE)).toEqual([]);
		expect(await listAs(w, PERELLO, LAURENT)).toEqual([]);
	});

	test("REFUSED: create without a link, nothing written", async () => {
		const w = await world();
		const msg = await errorOf(piCreatesTask(w));
		expect(msg).toMatch(/RBAC_DENIED|ORG_MISMATCH/);
		expect(await taskRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: create in the REVERSE direction while only pi -> victor exists", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await errorOf(
			asService(w.t).mutation(api.tasks.create, {
				title: "reverse",
				priority: "low",
				status: "todo",
				createdBy: "victor",
				assignedToAgentId: w.pi,
				verifiedActor: { agentId: w.victor, orgSlug: IRIS },
			} as never),
		);
		expect(await taskRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: create after revoke", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await person(w.t, IRIS, MARIE, "org:admin").mutation(
			api.agentLinks.revoke,
			{ fromAgentId: w.pi, toAgentId: w.victor },
		);
		await errorOf(piCreatesTask(w));
		expect(await taskRows(w.t)).toHaveLength(0);
	});

	test("a RE-GRANT after a revoke lets pi create the task again", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await marieRevokesPiToVictor(w);
		await errorOf(piCreatesTask(w));
		expect(await taskRows(w.t)).toHaveLength(0);

		await marieGrantsPiToVictor(w);
		const taskId = await piCreatesTask(w);
		const row = await w.t.run((ctx) => ctx.db.get(taskId as Id<"tasks">));
		expect(row?.orgId).toBe(IRIS);
		expect(row?.assignedToId).toBe(w.victor);
	});

	test("REFUSED: the TARGET organisation is inactive, a live link does not reach it, nothing is written", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await deactivateOrg(w, IRIS);
		await errorOf(piCreatesTask(w));
		expect(await taskRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: an UNPROVEN caller (no verifiedActor, no credential) does not inherit the link", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await errorOf(
			asService(w.t).mutation(api.tasks.create, {
				title: "cross-org task",
				priority: "low",
				status: "todo",
				createdBy: "pi",
				assignedToAgentId: w.victor,
			} as never),
		);
		expect(await taskRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: a perello SESSION naming pi as creator (no agent proof) does not inherit pi's link", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await errorOf(
			person(w.t, PERELLO, LAURENT, "org:admin").mutation(api.tasks.create, {
				title: "cross-org task",
				priority: "low",
				status: "todo",
				createdBy: "pi",
				assignedToAgentId: w.victor,
			} as never),
		);
		expect(await taskRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: an UNPROVEN service call naming an OPERATOR-org agent that holds a link does not inherit it (`proven` is the only guard)", async () => {
		const w = await world();
		// The one population that reaches linkedAssigneeOf with a defined
		// `callerActorId` and NO proof: the service account (no org of its own)
		// asserts the NAME of an agent of the operator org; the name resolves in the
		// operator org without a credential check (targetOrgSlug is null). That
		// agent holds a standing link to victor.
		const op = await w.t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: "fleet-op",
				clerkOrgId: testClerkOrgId("fleet-op"),
				name: "opsig",
				normalizedName: "opsig",
				isActive: true,
				createdAt: Date.now(),
			}),
		);
		await person(w.t, IRIS, MARIE, "org:admin").mutation(api.agentLinks.grant, {
			fromAgentId: op,
			toAgentId: w.victor,
			reason: REASON,
		});
		const unproven = {
			title: "cross-org task",
			priority: "low",
			status: "todo",
			createdBy: "opsig",
			assignedToAgentId: w.victor,
		};
		await errorOf(asService(w.t).mutation(api.tasks.create, unproven as never));
		expect(await taskRows(w.t)).toHaveLength(0);

		// The same call WITH the agent proof is the linked create: the refusal
		// above is the missing proof, not a broken link.
		const taskId = await asService(w.t).mutation(api.tasks.create, {
			...unproven,
			verifiedActor: { agentId: op, orgSlug: "fleet-op" },
		} as never);
		const row = await w.t.run((ctx) => ctx.db.get(taskId as Id<"tasks">));
		expect(row?.orgId).toBe(IRIS);
		expect(row?.assignedToId).toBe(w.victor);
	});

	test("REFUSED: a third agent of acme-hr is not covered", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await errorOf(piCreatesTask(w, { assignedToAgentId: w.clio }));
		expect(await taskRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: a NAME assignee in another organisation stays refused, link or not", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		await errorOf(
			piCreatesTask(w, { assignedToAgentId: undefined, assignedTo: "victor" }),
		);
		expect(await taskRows(w.t)).toHaveLength(0);
	});

	test("REFUSED: update to an agent of another organisation WITH a link: a reassign never moves a task between tenants", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		const taskId = await w.t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: "hand over",
				status: "todo",
				priority: "low",
				assignedTo: "pi",
				assignedToId: w.pi,
				createdBy: "pi",
				createdById: w.pi,
				orgId: PERELLO,
				clerkOrgId: testClerkOrgId(PERELLO),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never),
		);
		const msg = await errorOf(
			asService(w.t).mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "pi",
				assignedToAgentId: w.victor,
				verifiedActor: { agentId: w.pi, orgSlug: PERELLO },
			} as never),
		);
		expect(msg).toContain("ORG_MISMATCH");
		const row = await w.t.run((ctx) => ctx.db.get(taskId));
		expect(row?.orgId).toBe(PERELLO);
		expect(row?.clerkOrgId).toBe(testClerkOrgId(PERELLO));
		expect(row?.assignedToId).toBe(w.pi);
		expect(await listAs(w, IRIS, MARIE)).toEqual([]);
	});

	test("ALLOWED: a same-organisation reassign still works and keeps the task in its org", async () => {
		const w = await world();
		const peer = await w.t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: PERELLO,
				clerkOrgId: testClerkOrgId(PERELLO),
				name: "pia",
				normalizedName: "pia",
				isActive: true,
				createdAt: Date.now(),
			}),
		);
		await w.t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", PERELLO))
				.unique();
			if (m === null) throw new Error("fixture: no mapping");
			await ctx.db.patch(m._id, {
				allowedOrchestrators: ["pi", "pia"],
				allowedAgentIds: [w.pi, peer],
			});
		});
		const taskId = await w.t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: "same org",
				status: "todo",
				priority: "low",
				assignedTo: "pi",
				assignedToId: w.pi,
				createdBy: "pi",
				createdById: w.pi,
				orgId: PERELLO,
				clerkOrgId: testClerkOrgId(PERELLO),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never),
		);
		await asService(w.t).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "pi",
			assignedToAgentId: peer,
			verifiedActor: { agentId: w.pi, orgSlug: PERELLO },
		} as never);
		const row = await w.t.run((ctx) => ctx.db.get(taskId));
		expect(row?.orgId).toBe(PERELLO);
		expect(row?.assignedToId).toBe(peer);
		expect(row?.assignedTo).toBe("pia");
	});

	test("REFUSED: after the hand-over pi may not re-assign the task to any OTHER agent of acme-hr (one exact pair)", async () => {
		const w = await world();
		await marieGrantsPiToVictor(w);
		const taskId = await piCreatesTask(w);
		await errorOf(
			asService(w.t).mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "pi",
				assignedToAgentId: w.clio,
				verifiedActor: { agentId: w.pi, orgSlug: PERELLO },
			} as never),
		);
		const row = await w.t.run((ctx) => ctx.db.get(taskId as Id<"tasks">));
		expect(row?.assignedToId).toBe(w.victor);
	});

	test("REFUSED: update to an agent of another organisation without a link, the row is unchanged", async () => {
		const w = await world();
		const taskId = await w.t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: "stay",
				status: "todo",
				priority: "low",
				assignedTo: "pi",
				assignedToId: w.pi,
				createdBy: "pi",
				createdById: w.pi,
				orgId: PERELLO,
				clerkOrgId: testClerkOrgId(PERELLO),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never),
		);
		await errorOf(
			asService(w.t).mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "pi",
				assignedToAgentId: w.victor,
				verifiedActor: { agentId: w.pi, orgSlug: PERELLO },
			} as never),
		);
		const row = await w.t.run((ctx) => ctx.db.get(taskId));
		expect(row?.orgId).toBe(PERELLO);
		expect(row?.assignedToId).toBe(w.pi);
	});
});
