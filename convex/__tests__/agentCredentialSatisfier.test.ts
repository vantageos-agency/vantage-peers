/// <reference types="vite/client" />
/**
 * The credential SATISFIER — proof that a presented per-agent credential decides
 * who a caller is, and that another organisation's credential decides nothing.
 *
 * VantagePeers Cloud (multi-tenant). Strict-mode readiness (see
 * mcp-server/src/auth.ts `checkActorBinding`): the door is only worth closing
 * when every legitimate caller can hold a credential.
 *
 * Identities (named per pole; none is master):
 *   - `admin-of-<org>`   org:admin, mints credentials
 *   - `reader-of-<org>`  ordinary org member, the scoped reader (organizationId claim)
 *   - the credential HOLDER is anonymous: it presents only the secret
 *
 * Poles:
 *   P1 resolves      — a credential resolves to ITS OWN (org, agent); a same-named
 *                      agent of another org resolves to that other org (negative control)
 *   P2 refused       — an absent credential at an agent-named write surface is
 *                      REFUSED with a code (AGENT_CREDENTIAL_REQUIRED), never served
 *   P3 operation     — same write, same target org, ONE variable apart (whose
 *                      credential is presented): org A's credential lands a message
 *                      that org A's reader sees; org B's credential is refused
 *                      ORG_MISMATCH and org A's reader sees nothing of it; org B's
 *                      reader sees nothing either way
 *   P4 strict census — the accepted/refused split under strict, derived from rows
 *
 * DELETION PROBE (run manually, not committed): removing the
 * `resolved.orgSlug !== targetOrgSlug` branch of requireAgentCredentialMatch
 * (convex/lib/auth.ts) turns P3's foreign-credential refusal into a landed
 * message, so P3 goes RED; removing the declaredAgent lookup turns P2 RED.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
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

async function seedOrg(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["b", "c", "recipient-role"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedProfile(t: T, orchestratorId: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

const readerOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `reader-of-${org}`,
		organizationId: org,
	} as Parameters<typeof t.withIdentity>[0]);

async function register(t: T, org: string, name: string) {
	await adminOf(t, org).mutation(api.agents.registerAgent, {
		orgSlug: org,
		name,
	});
}

async function mint(t: T, org: string, name: string): Promise<string> {
	await register(t, org, name);
	const minted = await adminOf(t, org).mutation(
		api.agentCredentials.mintAgentCredential,
		{ orgSlug: org, agentName: name },
	);
	return minted.secret;
}

describe("P1 — a presented credential resolves to its own identity", () => {
	test("same-named agents of two orgs each resolve to their OWN org; neither resolves to the other", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const aSecret = await mint(t, "org-a", "shared-name");
		const bSecret = await mint(t, "org-b", "shared-name");

		expect(aSecret).not.toBe(bSecret);
		expect(
			await asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: aSecret,
			}),
		).toEqual({ orgSlug: "org-a", agentName: "shared-name" });
		// NEGATIVE control: the other org's credential is NOT org A's identity.
		const bResolved = await asServiceAccount(t).query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: bSecret },
		);
		expect(bResolved).toEqual({ orgSlug: "org-b", agentName: "shared-name" });
		expect(bResolved?.orgSlug).not.toBe("org-a");
	});

	test("an unknown secret is REFUSED with a code, not answered with nothing", async () => {
		const t = createT();
		await expect(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: "0".repeat(64),
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*credential-not-recognised/);
	});
});

describe("P2 — an absent credential is refused with a code, not served", () => {
	test("a registered agent's name typed with NO credential -> AGENT_CREDENTIAL_REQUIRED", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");
		await mint(t, "org-a", "b");

		await expect(
			readerOf(t, "org-a").mutation(api.messages.sendMessage, {
				from: "b",
				channel: "recipient-role",
				content: "typed name, nothing presented",
			}),
		).rejects.toThrow(/AGENT_CREDENTIAL_REQUIRED/);
	});

	test("a wrong credential at the same surface -> AGENT_IDENTITY_MISMATCH (a code, not an empty success)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");
		await mint(t, "org-a", "b");

		await expect(
			readerOf(t, "org-a").mutation(api.messages.sendMessage, {
				from: "b",
				channel: "recipient-role",
				content: "garbage credential",
				agentCredentialSecret: "f".repeat(64),
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});
});

describe("P3 — operation pole: the credential decides, one variable apart", () => {
	test("org A's credential lands a message A's reader sees; org B's credential is refused and B's reader sees nothing", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");
		const aCred = await mint(t, "org-a", "b");
		const bCred = await mint(t, "org-b", "b");

		// Positive control FIRST: the surface discriminates — org A's own
		// credential, presented into org A, is accepted.
		const landed = await readerOf(t, "org-a").mutation(
			api.messages.sendMessage,
			{
				from: "b",
				channel: "recipient-role",
				content: "from org A's b",
				agentCredentialSecret: aCred,
			},
		);
		expect(landed).toBeTruthy();

		// Same call, same target org, same caller: ONE variable changed — whose
		// credential is presented. Refused, with its code.
		await expect(
			readerOf(t, "org-a").mutation(api.messages.sendMessage, {
				from: "b",
				channel: "recipient-role",
				content: "from org B's b, into org A",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/ORG_MISMATCH/);

		const seenByA = await readerOf(t, "org-a").query(
			api.messages.listMessages,
			{},
		);
		expect(seenByA.map((m) => m.content)).toEqual(["from org A's b"]);

		// Org B's reader, same read: nothing of org A's.
		const seenByB = await readerOf(t, "org-b").query(
			api.messages.listMessages,
			{},
		);
		expect(seenByB).toEqual([]);
	});
});

describe("P4 — strict census, derived from rows", () => {
	test("agents holding an active credential are accepted; the rest are named as refused", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await mint(t, "org-a", "has-cred");
		await register(t, "org-a", "no-cred");
		const rotated = await mint(t, "org-a", "rotated");
		await mint(t, "org-a", "rotated"); // rotation: the first plaintext is dead

		const census = await t.run(async (ctx) => {
			const agents = await ctx.db.query("agents").collect();
			const creds = await ctx.db.query("agent_credentials").collect();
			const held = new Set(
				creds
					.filter((c) => c.isActive)
					.map((c) => `${c.orgSlug}/${c.agentName}`),
			);
			const accepted: string[] = [];
			const refused: string[] = [];
			for (const a of agents.filter((x) => x.isActive)) {
				(held.has(`${a.orgSlug}/${a.name}`) ? accepted : refused).push(a.name);
			}
			return { accepted: accepted.sort(), refused: refused.sort() };
		});
		expect(census).toEqual({
			accepted: ["has-cred", "rotated"],
			refused: ["no-cred"],
		});
		// The rotated-out plaintext no longer satisfies anything.
		await expect(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: rotated,
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*credential-not-recognised/);
	});
});


/**
 * `resolveAgentCredential` is closed to everyone but the fleet's service
 * account (the MCP server's identity). Every call in this file is the MCP
 * login path, so it is made as that account; the DENY poles that matter for
 * the door itself live in closeDoorsCreds.test.ts.
 */
function asServiceAccount<X extends { withIdentity: (i: never) => unknown }>(
	t: X,
): ReturnType<X["withIdentity"]> {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as never) as ReturnType<X["withIdentity"]>;
}
