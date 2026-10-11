/// <reference types="vite/client" />
//
// VantagePeers Cloud — client incident Iris RH, task k1716f01f9g1a0scz7nj30118h8fx32c.
// Operator decision 2026-10-08: a message recipient is resolved by its AGENT ID,
// never by its name (no accent fold, no name tolerance).
//
// World: two organisations each hold an agent named "hélios" (iris-rh and acme),
// the same label for two different agents. iris-rh also holds an inactive agent,
// an agent off its roster and an agent with no profile row (victor).
//
// Poles:
//   DELIVERED  clio -> iris hélios BY ID: one receipt, keyed by the ID, in iris's
//              tenant; iris hélios's check_messages sees it, acme hélios's does not.
//   REFUSED    acme hélios's ID from an iris caller; a deleted, inactive or
//              off-roster agent; all one refusal, so it is not an existence oracle.
//   INVALID    a NAME (accented, unaccented, upper case, NFD), a malformed string,
//              an ID of another table: a typed validation error, nothing written.
//   CONTRACT   both channel and IDs, neither, an empty list: INVALID_RECIPIENTS.
//   DIRECTORY  the agent directory lists the STORED IDs of the caller's own org only
//              (M1: the roster is IDs), null for an inactive agent, nothing for an ID
//              with no agent row.

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
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
type Identity = Parameters<T["withIdentity"]>[0];

const HELIOS = "hélios";
const HELIOS_NFD = "hélios";

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Identity);
const anonymous = (t: T) => t;

type World = {
	t: T;
	iris: Record<
		"clio" | "helios" | "marie" | "victor" | "nadia" | "offRoster" | "gone",
		Id<"agents">
	>;
	acmeHelios: Id<"agents">;
	fleetPi: Id<"agents">;
	profileId: string;
};

async function world(): Promise<World> {
	const t = createT();
	const ids: Record<string, Id<"agents">> = {};
	let profileId = "";
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
		const irisRow = await org("iris-rh", [
			"clio",
			HELIOS,
			"marie",
			"victor",
			"nadia",
			"ghost",
		]);
		const acmeRow = await org("acme", [HELIOS, "bob"]);
		await org("fleet-op", ["*"], "operator");
		const agent = (orgSlug: string, name: string, isActive = true) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name.normalize("NFC").toLowerCase().trim(),
				isActive,
				createdAt: now,
			});
		ids.clio = await agent("iris-rh", "clio");
		ids.helios = await agent("iris-rh", HELIOS);
		ids.marie = await agent("iris-rh", "marie");
		ids.victor = await agent("iris-rh", "victor"); // no profile row
		ids.nadia = await agent("iris-rh", "nadia", false); // inactive
		ids.offRoster = await agent("iris-rh", "oscar"); // not on iris's roster
		ids.gone = await agent("iris-rh", "marie-old");
		await ctx.db.delete(ids.gone);
		ids.acmeHelios = await agent("acme", HELIOS);
		ids.fleetPi = await agent("fleet-op", "pi");
		// M1: the rosters are stored BY ID (the name rosters above stay beside them).
		// iris-rh also lists a deleted agent's stale ID; "ghost" and "oscar" are not
		// on it (no agent row / off the roster).
		await ctx.db.patch(irisRow, {
			allowedAgentIds: [
				ids.clio,
				ids.helios,
				ids.marie,
				ids.victor,
				ids.nadia,
				ids.gone,
			],
		});
		await ctx.db.patch(acmeRow, { allowedAgentIds: [ids.acmeHelios] });
		for (const n of ["clio", HELIOS, "marie", "pi"]) {
			const p = await ctx.db.insert("profiles", {
				orchestratorId: n,
				name: n,
				static: { role: n, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 1 },
			});
			if (n === "clio") profileId = p;
		}
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: "hash-clio",
			clientId: "client-clio",
			userId: "clio",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "clio-iris-rh",
			fromAllowList: ["clio"],
			namespaceReadPrefixes: ["team/iris-rh"],
			namespaceWritePrefixes: ["team/iris-rh"],
			expiresAt: now + 3_600_000,
			createdAt: now,
			clerkOrgSlug: "iris-rh",
			clerkOrgId: testClerkOrgId("iris-rh"),
		});
	});
	return {
		t,
		iris: {
			clio: ids.clio,
			helios: ids.helios,
			marie: ids.marie,
			victor: ids.victor,
			nadia: ids.nadia,
			offRoster: ids.offRoster,
			gone: ids.gone,
		},
		acmeHelios: ids.acmeHelios,
		fleetPi: ids.fleetPi,
		profileId,
	};
}

// Clio's seat, exactly as the MCP forwards it since #1485: the service account
// carries the seat's verified org and the acting agent BY ID.
const clioSends = (w: World, extra: Record<string, unknown>) =>
	asService(w.t).mutation(api.messages.sendMessage, {
		from: "clio",
		content: "hello",
		seatOrgSlug: "iris-rh",
		verifiedActor: { agentId: w.iris.clio, orgSlug: "iris-rh" },
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

// The inbox is read through the VERIFIED org (task k17c5q842gm1gbh0j2qjtc80g18fx5kb):
// the service account can no longer name a client tenant by argument.
const inbox = (w: World, recipient: string, orgSlug: string) =>
	asService(w.t).query(api.messages.checkNewMessagesEnvelope, {
		recipient,
		verifiedOrg: { orgSlug },
	});

describe("DELIVERED — a recipient addressed by its agent ID", () => {
	test("clio -> iris hélios BY ID: one receipt keyed by the ID, in iris's tenant", async () => {
		const w = await world();
		const messageId = await clioSends(w, {
			recipientAgentIds: [w.iris.helios],
		});
		const receipts = await w.t.run((ctx) =>
			ctx.db
				.query("messageReceipts")
				.withIndex("by_message", (q) => q.eq("messageId", messageId))
				.collect(),
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].recipientId).toBe(w.iris.helios);
		expect(receipts[0].recipient).toBe(HELIOS);
		expect(receipts[0].tenantId).toBe("iris-rh");
		const message = await w.t.run((ctx) => ctx.db.get(messageId));
		expect(message?.channel).toBe(HELIOS);
		expect(message?.tenantId).toBe("iris-rh");
	});

	test("iris hélios's check_messages sees it; acme hélios's does not", async () => {
		const w = await world();
		await clioSends(w, { recipientAgentIds: [w.iris.helios] });
		const irisInbox = await inbox(w, HELIOS, "iris-rh");
		expect(irisInbox.messages.map((m) => m.content)).toEqual(["hello"]);
		expect(irisInbox.messages[0].from).toBe("clio");
		const acmeInbox = await inbox(w, HELIOS, "acme");
		expect(acmeInbox.messages).toEqual([]);
	});

	test("never reaches the same-named agent of another org", async () => {
		const w = await world();
		await clioSends(w, { recipientAgentIds: [w.iris.helios] });
		const toAcme = await w.t.run((ctx) =>
			ctx.db
				.query("messageReceipts")
				.withIndex("by_recipientId_unread", (q) =>
					q.eq("recipientId", w.acmeHelios).eq("readAt", undefined),
				)
				.collect(),
		);
		expect(toAcme).toEqual([]);
	});

	test("an agent with NO profile row is addressable by ID", async () => {
		const w = await world();
		await expect(
			clioSends(w, { recipientAgentIds: [w.iris.victor] }),
		).resolves.toBeTruthy();
		expect((await inbox(w, "victor", "iris-rh")).messages).toHaveLength(1);
	});

	test("several IDs: one receipt each; a repeated ID is one receipt", async () => {
		const w = await world();
		await clioSends(w, {
			recipientAgentIds: [w.iris.helios, w.iris.marie, w.iris.helios],
		});
		expect(await counts(w)).toEqual({ messages: 1, receipts: 2 });
	});

	test("the seat path without verifiedActor (seatOrgSlug only) is scoped the same", async () => {
		const w = await world();
		const send = (ids: string[]) =>
			asService(w.t).mutation(api.messages.sendMessage, {
				from: "clio",
				content: "x",
				seatOrgSlug: "iris-rh",
				recipientAgentIds: ids,
			});
		await expect(send([w.iris.helios])).resolves.toBeTruthy();
		expect(await errorOf(send([w.acmeHelios]))).toContain(
			"recipient-agent-not-addressable",
		);
	});

	test("the sender's own ID is skipped; only itself is refused", async () => {
		const w = await world();
		await clioSends(w, { recipientAgentIds: [w.iris.clio, w.iris.marie] });
		expect(await counts(w)).toEqual({ messages: 1, receipts: 1 });
		expect(
			await errorOf(clioSends(w, { recipientAgentIds: [w.iris.clio] })),
		).toContain("only-self");
	});

	test("an org member (human path) reaches its own org's agent by ID, not acme's", async () => {
		const w = await world();
		await w.t.mutation(internal.memberWriterRoles.setMemberWriterRoles, {
			orgSlug: "iris-rh",
			roles: ["org:admin"],
		});
		const send = (ids: string[]) =>
			adminOf(w.t, "iris-rh").mutation(api.messages.sendMessage, {
				content: "from a person",
				recipientAgentIds: ids,
			});
		await expect(send([w.iris.helios])).resolves.toBeTruthy();
		expect(await errorOf(send([w.acmeHelios]))).toContain(
			"recipient-agent-not-addressable",
		);
	});

	test("fleet master: an operator-org agent by ID; a client agent without its tenant is refused", async () => {
		const w = await world();
		const send = (ids: string[], tenantId?: string) =>
			asService(w.t).mutation(api.messages.sendMessage, {
				from: "sigma",
				content: "fleet",
				recipientAgentIds: ids,
				...(tenantId ? { tenantId } : {}),
			});
		await expect(send([w.fleetPi])).resolves.toBeTruthy();
		expect(await errorOf(send([w.iris.helios]))).toContain(
			"recipient-agent-not-addressable",
		);
		await expect(send([w.iris.helios], "iris-rh")).resolves.toBeTruthy();
		expect(await errorOf(send([w.acmeHelios], "iris-rh"))).toContain(
			"recipient-agent-not-addressable",
		);
	});
});

describe("REFUSED — an ID outside the caller's reach, one refusal for every cause", () => {
	const cases: Array<[string, (w: World) => string]> = [
		["acme hélios (same name, other org)", (w) => w.acmeHelios],
		["a deleted agent", (w) => w.iris.gone],
		["an inactive agent", (w) => w.iris.nadia],
		["an own-org agent off the roster", (w) => w.iris.offRoster],
		["a fleet agent (operator org)", (w) => w.fleetPi],
	];
	for (const [label, idOf] of cases) {
		test(`${label}: RBAC_DENIED recipient-agent-not-addressable, nothing written`, async () => {
			const w = await world();
			const err = await errorOf(clioSends(w, { recipientAgentIds: [idOf(w)] }));
			expect(err).toContain("RBAC_DENIED");
			expect(err).toContain('"reason":"recipient-agent-not-addressable"');
			expect(err).toContain('"door":"messages:sendMessage"');
			expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
		});
	}

	test("one foreign ID in a list refuses the whole send", async () => {
		const w = await world();
		const err = await errorOf(
			clioSends(w, { recipientAgentIds: [w.iris.helios, w.acmeHelios] }),
		);
		expect(err).toContain("recipient-agent-not-addressable");
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("a foreign ID and a deleted ID are refused with the same reason (no oracle)", async () => {
		const w = await world();
		const reason = (e: string) => e.match(/"reason":"([^"]+)"/)?.[1];
		const foreign = await errorOf(
			clioSends(w, { recipientAgentIds: [w.acmeHelios] }),
		);
		const deleted = await errorOf(
			clioSends(w, { recipientAgentIds: [w.iris.gone] }),
		);
		expect(reason(foreign)).toBe("recipient-agent-not-addressable");
		expect(reason(deleted)).toBe(reason(foreign));
	});
});

describe("INVALID — a name, a malformed string or another table's ID never routes", () => {
	const names = [HELIOS, "helios", "Hélios", "HELIOS", HELIOS_NFD, " hélios "];
	for (const name of names) {
		test(`recipientAgentIds ["${name}"]: typed validation error, nothing written`, async () => {
			const w = await world();
			const err = await errorOf(clioSends(w, { recipientAgentIds: [name] }));
			expect(err).toContain('"expectedTable":"agents"');
			expect(err).toContain('"path":"recipientAgentIds"');
			expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
		});
	}

	test("a malformed ID and an empty string are validation errors", async () => {
		const w = await world();
		for (const raw of ["abc", "", "j57xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]) {
			expect(
				await errorOf(clioSends(w, { recipientAgentIds: [raw] })),
			).toContain('"expectedTable":"agents"');
		}
	});

	test("a valid ID of ANOTHER table (a profile) is a validation error", async () => {
		const w = await world();
		const err = await errorOf(
			clioSends(w, { recipientAgentIds: [w.profileId] }),
		);
		expect(err).toContain('"expectedTable":"agents"');
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});

	test("the NAME channel gained no tolerance: unaccented 'helios' still bounces", async () => {
		const w = await world();
		const err = await errorOf(clioSends(w, { channel: "helios" }));
		expect(err).toContain("message non livré");
		expect(await counts(w)).toEqual({ messages: 0, receipts: 0 });
	});
});

describe("CONTRACT — exactly one of channel and recipientAgentIds", () => {
	test("both: INVALID_RECIPIENTS both-channel-and-agent-ids", async () => {
		const w = await world();
		const err = await errorOf(
			clioSends(w, { channel: HELIOS, recipientAgentIds: [w.iris.helios] }),
		);
		expect(err).toContain("INVALID_RECIPIENTS");
		expect(err).toContain("both-channel-and-agent-ids");
	});

	test("neither: INVALID_RECIPIENTS no-recipient", async () => {
		const w = await world();
		expect(await errorOf(clioSends(w, {}))).toContain("no-recipient");
	});

	test("an empty list: INVALID_RECIPIENTS empty-agent-ids", async () => {
		const w = await world();
		expect(await errorOf(clioSends(w, { recipientAgentIds: [] }))).toContain(
			"empty-agent-ids",
		);
	});

	test("more than the cap: INVALID_RECIPIENTS too-many-agent-ids", async () => {
		const w = await world();
		const many = Array.from({ length: 51 }, () => w.iris.helios as string);
		expect(await errorOf(clioSends(w, { recipientAgentIds: many }))).toContain(
			"too-many-agent-ids",
		);
	});

	test("an existing name-channel caller is unchanged (fleet routing)", async () => {
		const w = await world();
		await expect(clioSends(w, { channel: HELIOS })).resolves.toBeTruthy();
		expect(await counts(w)).toEqual({ messages: 1, receipts: 1 });
	});
});

describe("DIRECTORY — agent IDs for the caller's own organisation only", () => {
	test("token directory: iris names with iris IDs, null where no active agent row", async () => {
		const w = await world();
		const dir = await asService(w.t).query(
			api.orgRoster.getAgentDirectoryForAccessToken,
			{ tokenHash: "hash-clio" },
		);
		expect(dir).toEqual([
			{ name: "clio", agentId: w.iris.clio },
			{ name: HELIOS, agentId: w.iris.helios },
			{ name: "marie", agentId: w.iris.marie },
			{ name: "victor", agentId: w.iris.victor },
			{ name: "nadia", agentId: null }, // inactive: listed, not addressable
			// "ghost" (a name with no agent) and the deleted agent's stale ID are not
			// listed: the roster holds IDs, and only an existing agent has a label.
		]);
		expect(JSON.stringify(dir)).not.toContain(w.acmeHelios);
	});

	test("the legacy NAME roster is not read: retyping it changes nothing", async () => {
		const w = await world();
		const before = await asService(w.t).query(
			api.orgRoster.getAgentDirectoryForAccessToken,
			{ tokenHash: "hash-clio" },
		);
		await w.t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "iris-rh"))
				.first();
			if (m)
				await ctx.db.patch(m._id, {
					allowedOrchestrators: ["helios", HELIOS_NFD, "*"],
				});
		});
		const after = await asService(w.t).query(
			api.orgRoster.getAgentDirectoryForAccessToken,
			{ tokenHash: "hash-clio" },
		);
		expect(after).toEqual(before);
		expect(after.find((e) => e.name === "helios")).toBeUndefined();
	});

	test("the token door admits the MCP service account only", async () => {
		const w = await world();
		for (const caller of [anonymous(w.t), adminOf(w.t, "iris-rh")]) {
			expect(
				await errorOf(
					caller.query(api.orgRoster.getAgentDirectoryForAccessToken, {
						tokenHash: "hash-clio",
					}),
				),
			).toContain("RBAC_DENIED");
		}
	});

	test("an unknown token hash is refused, not an empty directory", async () => {
		const w = await world();
		expect(
			await errorOf(
				asService(w.t).query(api.orgRoster.getAgentDirectoryForAccessToken, {
					tokenHash: "nope",
				}),
			),
		).toContain("RBAC_DENIED");
	});

	test("Clerk session directory: the caller's own org; anonymous and org-less master refused", async () => {
		const w = await world();
		const mine = await adminOf(w.t, "acme").query(
			api.orgRoster.getMyAgentDirectory,
			{},
		);
		expect(mine).toEqual([{ name: HELIOS, agentId: w.acmeHelios }]);
		expect(
			await errorOf(
				anonymous(w.t).query(api.orgRoster.getMyAgentDirectory, {}),
			),
		).toContain("RBAC_DENIED");
		expect(
			await errorOf(
				asService(w.t).query(api.orgRoster.getMyAgentDirectory, {}),
			),
		).toContain("no-organisation");
	});

	test("an ID read from the directory is the one that routes", async () => {
		const w = await world();
		const dir = await asService(w.t).query(
			api.orgRoster.getAgentDirectoryForAccessToken,
			{ tokenHash: "hash-clio" },
		);
		const helios = dir.find((e) => e.name === HELIOS)?.agentId;
		expect(helios).toBeTruthy();
		await clioSends(w, { recipientAgentIds: [helios as string] });
		expect((await inbox(w, HELIOS, "iris-rh")).messages).toHaveLength(1);
	});
});
