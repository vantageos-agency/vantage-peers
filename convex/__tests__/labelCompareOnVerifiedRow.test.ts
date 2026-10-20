/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * Deletion series slice 2a (task k1778c2hvae8e8vz9f5bbbbbb98g62hw): once the
 * actor is proven BY ID, no name takes part in an admit/refuse decision of the
 * inbox reader, and a proven sender is not re-screened by name.
 *
 * SITE 3 (convex/lib/inboxReader.ts agentReader): a `recipient` claim beside a
 *   verifiedActor decides nothing; the read is the VERIFIED row's own inbox,
 *   never the one the claim names.
 * SITE 4 (messages:sendMessage): a proven sender's `from` is no longer screened
 *   against the seat roster / other orgs' labels; the verified-actor compare
 *   still refuses another agent's label and nothing is written.
 * SITES 1 and 2 (requireAgentCredentialMatch, both branches) are UNCHANGED by
 *   this slice: tasks.ts reads the asserted name in ~40 doors after the check
 *   (isFleetSystemCaller, reviewArtifactAttachedBy, cancelledBy, ...), so the
 *   check stays; their poles below pin the behaviour kept.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { ownAgent } from "../../tests/lib/ownAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { requireAgentCredentialMatch } from "../lib/auth";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const NOW = 1_700_000_000_000;
const ORG_A = "org-a";
const ORG_B = "org-b";

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);
const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

type World = {
	t: T;
	alpha: Id<"agents">;
	bravo: Id<"agents">;
};

async function world(): Promise<World> {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		const mapping = (slug: string, names: string[]) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: names,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
		await mapping(ORG_A, ["alpha", "peer"]);
		await mapping(ORG_B, ["bravo"]);
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		for (const name of ["alpha", "peer"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: name,
				name,
				static: { role: name, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: NOW, sessionCount: 1 },
			});
		}
		const alpha = await agent(ORG_A, "alpha");
		await agent(ORG_A, "peer");
		const bravo = await agent(ORG_B, "bravo");
		return { alpha, bravo };
	});
	return { t, ...ids };
}

async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "NO_ERROR";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		return (text.replace(/^"/, "").split(":")[0]) ?? text;
	}
}

const serviceAccountProof = (agentId: Id<"agents">, orgSlug: string) => ({
	scope: { isMaster: true, masterSource: "service-account" as const },
	verifiedActor: { agentId, orgSlug },
});

describe("site 1: requireVerifiedActorMatch compares against the loaded row", () => {
	test("OWN: the verified agent's own label passes", async () => {
		const { t, alpha } = await world();
		const got = await t.run((ctx) =>
			outcome(
				requireAgentCredentialMatch(ctx, undefined, "alpha", null, serviceAccountProof(alpha, ORG_A)),
			),
		);
		expect(got).toBe("NO_ERROR");
	});
	test("OTHER: another agent's label is refused AGENT_IDENTITY_MISMATCH", async () => {
		const { t, alpha } = await world();
		const got = await t.run((ctx) =>
			outcome(
				requireAgentCredentialMatch(ctx, undefined, "bravo", null, serviceAccountProof(alpha, ORG_A)),
			),
		);
		expect(got).toBe("AGENT_IDENTITY_MISMATCH");
	});
	test("SPACING: case and padding pass, as before (NFC, lowercase, trim)", async () => {
		const { t, alpha } = await world();
		const got = await t.run((ctx) =>
			outcome(
				requireAgentCredentialMatch(ctx, undefined, "  ALPHA ", null, serviceAccountProof(alpha, ORG_A)),
			),
		);
		expect(got).toBe("NO_ERROR");
	});
});

describe("site 2: requireAgentCredentialMatch (secret) compares against the resolved row", () => {
	async function withSecret() {
		const w = await world();
		await adminOf(w.t, ORG_A).mutation(api.agents.registerAgent, {
			orgSlug: ORG_A,
			name: "clio",
		});
		const minted = await adminOf(w.t, ORG_A).mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: ORG_A, agentId: await agentIdOf(w.t, ORG_A, "clio") },
		);
		await ownAgent(w.t, ORG_A, "clio");
		return { ...w, secret: minted.secret };
	}
	const none = { scope: { isMaster: false }, verifiedActor: undefined };

	test("OWN: the credential holder under its own label passes", async () => {
		const { t, secret } = await withSecret();
		expect(
			await t.run((ctx) => outcome(requireAgentCredentialMatch(ctx, secret, "clio", ORG_A, none))),
		).toBe("NO_ERROR");
	});
	test("OTHER: the holder under another agent's label is refused AGENT_IDENTITY_MISMATCH", async () => {
		const { t, secret } = await withSecret();
		expect(
			await t.run((ctx) => outcome(requireAgentCredentialMatch(ctx, secret, "alpha", ORG_A, none))),
		).toBe("AGENT_IDENTITY_MISMATCH");
	});
	test("SPACING: case and padding pass, as before", async () => {
		const { t, secret } = await withSecret();
		expect(
			await t.run((ctx) => outcome(requireAgentCredentialMatch(ctx, secret, " CLIO", ORG_A, none))),
		).toBe("NO_ERROR");
	});
});

describe("site 3: agentReader reads the verified row's own inbox whatever recipient is named", () => {
	async function inboxWorld() {
		const w = await world();
		await w.t.run(async (ctx) => {
			const put = async (key: string, recipient: string, recipientId: Id<"agents">) => {
				const messageId = await ctx.db.insert("messages", {
					from: "bravo",
					channel: recipient,
					content: key,
					tenantId: ORG_A,
					tenantOrgId: testClerkOrgId(ORG_A),
					createdAt: NOW,
				});
				await ctx.db.insert("messageReceipts", {
					messageId,
					recipient,
					recipientId,
					tenantId: ORG_A,
					tenantOrgId: testClerkOrgId(ORG_A),
					readAt: undefined,
				});
			};
			await put("FOR-ALPHA", "alpha", w.alpha);
			const peer = (await ctx.db.query("agents").collect()).find(
				(r) => r.orgSlug === ORG_A && r.name === "peer",
			);
			if (peer === undefined) throw new Error("fixture: no peer");
			await put("FOR-PEER", "peer", peer._id);
		});
		return w;
	}
	const read = async (t: T, agentId: Id<"agents">, recipient: string | undefined) =>
		(
			await asServiceAccount(t).query(api.messages.checkNewMessages, {
				...(recipient !== undefined ? { recipient } : {}),
				verifiedActor: { agentId, orgSlug: ORG_A },
			} as never)
		)
			.map((m: { content: string }) => m.content)
			.sort();

	test("OWN: the reader's own label reads its own inbox", async () => {
		const { t, alpha } = await inboxWorld();
		expect(await read(t, alpha, "alpha")).toEqual(["FOR-ALPHA"]);
	});
	test("OTHER: another agent's label acts AS the verified row: its own inbox, never peer's", async () => {
		const { t, alpha } = await inboxWorld();
		expect(await read(t, alpha, "peer")).toEqual(["FOR-ALPHA"]);
	});
	test("OTHER: a label naming nobody still reads the verified row's inbox", async () => {
		const { t, alpha } = await inboxWorld();
		expect(await read(t, alpha, "nobody-at-all")).toEqual(["FOR-ALPHA"]);
	});
	test("SPACING / no recipient: the same inbox", async () => {
		const { t, alpha } = await inboxWorld();
		expect(await read(t, alpha, " ALPHA ")).toEqual(["FOR-ALPHA"]);
		expect(await read(t, alpha, undefined)).toEqual(["FOR-ALPHA"]);
	});
	test("TENANT: naming another org as the tenant is still refused", async () => {
		const { t, alpha } = await inboxWorld();
		await expect(
			asServiceAccount(t).query(api.messages.checkNewMessages, {
				tenantId: ORG_B,
				verifiedActor: { agentId: alpha, orgSlug: ORG_A },
			} as never),
		).rejects.toThrow(/RBAC_DENIED.*tenant-not-the-readers-org/);
	});
	// The reader's label is load-bearing (ownsSentMessage keys a legacy
	// name-keyed delete on it), so a claimed label must never become it.
	test("a claimed label never lets the verified row delete a peer's legacy (name-keyed) message", async () => {
		const { t, alpha } = await inboxWorld();
		const legacy = await t.run(async (ctx) =>
			ctx.db.insert("messages", {
				from: "peer",
				channel: "alpha",
				content: "PEER-SENT-LEGACY",
				tenantId: ORG_A,
				tenantOrgId: testClerkOrgId(ORG_A),
				createdAt: NOW,
			}),
		);
		await asServiceAccount(t)
			.mutation(api.messages.deleteMessage, {
				messageId: legacy,
				callerOrchestrator: "peer",
				verifiedActor: { agentId: alpha, orgSlug: ORG_A },
			} as never)
			.catch(() => undefined);
		expect((await t.run(async (ctx) => ctx.db.get(legacy)))?.content).toBe("PEER-SENT-LEGACY");
	});
});

describe("site 4: sendMessage does not re-screen a proven sender by name", () => {
	const sendAs = async (from: string) => {
		const { t, alpha } = await world();
		return await outcome(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from,
				channel: "peer",
				content: "x",
				seatOrgSlug: ORG_A,
				verifiedActor: { agentId: alpha, orgSlug: ORG_A },
			}),
		);
	};

	test("OWN: the verified sender under its own label is delivered", async () => {
		expect(await sendAs("alpha")).toBe("NO_ERROR");
	});
	test("OTHER: another org's identity is refused by the proof compare and nothing is written", async () => {
		const { t, alpha } = await world();
		const got = await outcome(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "bravo",
				channel: "peer",
				content: "x",
				seatOrgSlug: ORG_A,
				verifiedActor: { agentId: alpha, orgSlug: ORG_A },
			}),
		);
		expect(got).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await t.run(async (ctx) => (await ctx.db.query("messages").collect()).length)).toBe(0);
	});
	test("SPACING: case and padding pass, as before", async () => {
		expect(await sendAs(" ALPHA")).toBe("NO_ERROR");
	});
	test("UNPROVEN: with no proof, the seat screening still refuses a foreign identity", async () => {
		const { t } = await world();
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "bravo",
				channel: "peer",
				content: "x",
				seatOrgSlug: ORG_A,
			}),
		).rejects.toThrow(/seat-sender-foreign-identity/);
	});
});
