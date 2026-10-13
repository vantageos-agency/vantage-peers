/// <reference types="vite/client" />
/**
 * The agent's human OWNER, proven through @vantageos/cloud-identity 0.21.0
 * (`resolveCallerFromAgentCredential`). Task k1778c2hvae8e8vz9f5bbbbbb98g62hw.
 *
 * An agent row may carry `ownerPersonId`: the person it is bound to. The agent
 * credential row copies it from the AGENT ROW at mint (never from an argument),
 * and every resolution of the credential asks the package to prove the owner
 * against the agent's stored owner and the owner's active membership of the
 * agent's own organisation. VP decides nothing: it supplies plain indexed reads
 * by ID and says the package's refusal.
 *
 * POLES
 *   REFUSED  an owned agent whose owner person is deactivated: agent-owner-not-member
 *   REFUSED  an agent whose recorded owner is a person of ANOTHER org: agent-owner-not-member
 *   REFUSED  a credential minted for one owner, the agent since bound to another: agent-owner-mismatch
 *   ACCEPTED an owned agent with an active owner in its org
 *   ABSENT   an agent with no owner still resolves (an absence is not a refusal)
 */

import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../../tests/fixtures/testClerkOrgId";
import { convexTest } from "../../../tests/fixtures/convexTestWithServiceAccount";
import { agentIdOf } from "../../../tests/lib/agentIdOf";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { resolveAgentCallerOfPresentedSecret } from "../agentIdentity";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const admin = (org: string) =>
	({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	}) as Identity;

const serviceAccount = { subject: "test-service-account-user-id" } as Identity;

async function seedOrg(t: T, slug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: ["legacy"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: 1,
		});
	});
}

async function seedMember(
	t: T,
	org: string,
	personId: string,
	deactivated = false,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("orgMembership", {
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			clerkUserId: personId,
			role: "member",
			createdAt: 1,
			updatedAt: 1,
			...(deactivated ? { deactivatedAt: 99 } : {}),
		});
	});
}

async function ownedAgentWithCredential(
	t: T,
	org: string,
	name: string,
	ownerPersonId: string | undefined,
): Promise<{ agentId: Id<"agents">; secret: string }> {
	const a = t.withIdentity(admin(org));
	await a.mutation(api.agents.registerAgent, { orgSlug: org, name });
	const agentId = await agentIdOf(a, org, name);
	if (ownerPersonId !== undefined) {
		await t.run(async (ctx) => {
			await ctx.db.patch(agentId, { ownerPersonId });
		});
	}
	const minted = await a.mutation(api.agentCredentials.mintAgentCredential, {
		orgSlug: org,
		agentId,
	});
	return { agentId, secret: minted.secret };
}

const resolveAsMcp = (t: T, secret: string) =>
	t
		.withIdentity(serviceAccount)
		.query(api.agentCredentials.resolveAgentCredential, {
			presentedSecret: secret,
		});

describe("agent owner: the package proves the owner on every resolution", () => {
	test("REFUSED (pole 1): an owned agent whose owner person is deactivated is agent-owner-not-member", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1", true);
		const { secret } = await ownedAgentWithCredential(t, "org-a", "ada", "person-1");
		await expect(resolveAsMcp(t, secret)).rejects.toThrow(
			/RBAC_DENIED[\s\S]*agent-owner-not-member/,
		);
		const verdict = await t.run(async (ctx) =>
			resolveAgentCallerOfPresentedSecret(ctx, secret, "test:agentOwner"),
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toBe("agent-owner-not-member");
	});

	test("REFUSED (pole 2): an agent whose recorded owner is a person of ANOTHER org is agent-owner-not-member", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedMember(t, "org-b", "person-b");
		const { secret } = await ownedAgentWithCredential(t, "org-a", "ada", "person-b");
		await expect(resolveAsMcp(t, secret)).rejects.toThrow(
			/RBAC_DENIED[\s\S]*agent-owner-not-member/,
		);
	});

	test("ACCEPTED (pole 3): an owned agent with an active owner in its org resolves, owner carried", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1");
		const { agentId, secret } = await ownedAgentWithCredential(
			t,
			"org-a",
			"ada",
			"person-1",
		);
		expect(await resolveAsMcp(t, secret)).toMatchObject({
			orgSlug: "org-a",
			agentName: "ada",
			agentId,
			ownerPersonId: "person-1",
		});
		const verdict = await t.run(async (ctx) =>
			resolveAgentCallerOfPresentedSecret(ctx, secret, "test:agentOwner"),
		);
		expect(verdict.ok).toBe(true);
		if (verdict.ok) {
			expect(verdict.principal.ownerPersonId).toBe("person-1");
			expect(verdict.agent._id).toBe(agentId);
		}
	});

	test("the credential row copies the owner from the AGENT ROW at mint", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1");
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", "person-1");
		const rows = await t.run(async (ctx) =>
			ctx.db
				.query("agent_credentials")
				.withIndex("by_agent", (q) => q.eq("agentId", agentId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].ownerPersonId).toBe("person-1");
	});

	test("REFUSED: a credential minted for one owner, the agent since bound to another, is agent-owner-mismatch", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1");
		await seedMember(t, "org-a", "person-2");
		const { agentId, secret } = await ownedAgentWithCredential(
			t,
			"org-a",
			"ada",
			"person-1",
		);
		await t.run(async (ctx) => {
			await ctx.db.patch(agentId, { ownerPersonId: "person-2" });
		});
		await expect(resolveAsMcp(t, secret)).rejects.toThrow(
			/RBAC_DENIED[\s\S]*agent-owner-mismatch/,
		);
	});

	test("ABSENT: an agent with no owner still resolves; an absence is not a refusal", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const { agentId, secret } = await ownedAgentWithCredential(
			t,
			"org-a",
			"ada",
			undefined,
		);
		const out = await resolveAsMcp(t, secret);
		expect(out).toMatchObject({ orgSlug: "org-a", agentId });
		expect(out).not.toHaveProperty("ownerPersonId");
	});
});

const futureExpiry = () => Date.now() + 3_600_000;

async function seatTokenFor(
	t: T,
	org: string,
	agentId: Id<"agents">,
	tokenHash: string,
	ownerPersonId?: string,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash,
			clientId: "client-1",
			userId: "ada",
			scopes: ["mcp:full"],
			scopeProfile: `ada-${org}`,
			fromAllowList: ["ada"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: futureExpiry(),
			createdAt: 1,
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			agentId,
			agentOrgId: org,
			...(ownerPersonId !== undefined ? { ownerPersonId } : {}),
		});
	});
}

const tokenAsMcp = (t: T, tokenHash: string) =>
	t
		.withIdentity(serviceAccount)
		.query(api.oauth.getAccessTokenByHash, { tokenHash });

describe("agent owner: a seat token is proven by the same package call", () => {
	test("ACCEPTED: a token whose agent has an active owner reports the seat and the owner", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1");
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", "person-1");
		await seatTokenFor(t, "org-a", agentId, "hash-ok", "person-1");
		const out = await tokenAsMcp(t, "hash-ok");
		expect(out?.seatAgent).toMatchObject({
			agentId,
			ownerPersonId: "person-1",
		});
	});

	test("REFUSED: a token whose agent owner is deactivated is not served at all", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1", true);
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", "person-1");
		await seatTokenFor(t, "org-a", agentId, "hash-deactivated", "person-1");
		expect(await tokenAsMcp(t, "hash-deactivated")).toBeNull();
	});

	test("REFUSED: a token still carrying the previous owner is refused (agent-owner-mismatch)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1");
		await seedMember(t, "org-a", "person-2");
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", "person-2");
		await seatTokenFor(t, "org-a", agentId, "hash-stale", "person-1");
		expect(await tokenAsMcp(t, "hash-stale")).toBeNull();
	});

	test("ABSENT: a token of an unowned agent is served as before", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", undefined);
		await seatTokenFor(t, "org-a", agentId, "hash-unowned");
		const out = await tokenAsMcp(t, "hash-unowned");
		expect(out?.seatAgent).toMatchObject({ agentId });
		expect(out?.seatAgent).not.toHaveProperty("ownerPersonId");
	});
});

describe("agent owner: the operator functions that bind and unbind an owner", () => {
	const bind = (t: T, agentId: Id<"agents">, ownerPersonId?: string) =>
		t.mutation(internal.agents.setAgentOwner, {
			agentId,
			...(ownerPersonId !== undefined ? { ownerPersonId } : {}),
		});

	test("setAgentOwner: binds an active person of the agent's org; the active credential is re-stamped from the agent row", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1");
		const { agentId, secret } = await ownedAgentWithCredential(
			t,
			"org-a",
			"ada",
			undefined,
		);
		expect(await bind(t, agentId, "person-1")).toEqual({
			ownerPersonId: "person-1",
			credentialsRestamped: 1,
		});
		expect(await resolveAsMcp(t, secret)).toMatchObject({
			ownerPersonId: "person-1",
		});
	});

	test("setAgentOwner: a person unknown to the agent's org is refused and nothing is written", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", undefined);
		await expect(bind(t, agentId, "stranger")).rejects.toThrow();
		const row = await t.run(async (ctx) => ctx.db.get(agentId));
		expect(row?.ownerPersonId).toBeUndefined();
	});

	test("setAgentOwner: a person of ANOTHER org is refused", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedMember(t, "org-b", "person-b");
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", undefined);
		await expect(bind(t, agentId, "person-b")).rejects.toThrow();
		const row = await t.run(async (ctx) => ctx.db.get(agentId));
		expect(row?.ownerPersonId).toBeUndefined();
	});

	test("setAgentOwner: a deactivated person is refused", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1", true);
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", undefined);
		await expect(bind(t, agentId, "person-1")).rejects.toThrow();
	});

	test("setAgentOwner: unbinding clears the owner on the agent and its active credential", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1");
		const { agentId, secret } = await ownedAgentWithCredential(
			t,
			"org-a",
			"ada",
			"person-1",
		);
		expect(await bind(t, agentId)).toEqual({
			ownerPersonId: null,
			credentialsRestamped: 1,
		});
		const out = await resolveAsMcp(t, secret);
		expect(out).not.toHaveProperty("ownerPersonId");
	});

	test("setAgentOwner: an agent that does not exist is AGENT_NOT_FOUND", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", undefined);
		await t.run(async (ctx) => {
			await ctx.db.delete(agentId);
		});
		await expect(bind(t, agentId)).rejects.toThrow(/AGENT_NOT_FOUND/);
	});
});

describe("agent owner: backfillAgentOwnerIds copies the owner from the agent row, idempotently", () => {
	async function world() {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedMember(t, "org-a", "person-1");
		const { agentId } = await ownedAgentWithCredential(t, "org-a", "ada", undefined);
		await t.run(async (ctx) => {
			await ctx.db.patch(agentId, { ownerPersonId: "person-1" });
		});
		await seatTokenFor(t, "org-a", agentId, "hash-backfill");
		return { t, agentId };
	}
	const run = (t: T, table: "agent_credentials" | "oauth_access_tokens", dryRun: boolean) =>
		t.mutation(internal.migrations.agentOwnerRows.backfillAgentOwnerIds, {
			table,
			dryRun,
			cursor: null,
		});

	test("dry run reports and writes nothing; a real run writes; the next run updates nothing", async () => {
		const { t, agentId } = await world();
		for (const table of ["agent_credentials", "oauth_access_tokens"] as const) {
			const dry = await run(t, table, true);
			expect(dry).toMatchObject({ scanned: 1, updated: 1, inSync: 0 });
		}
		const credentialBefore = await t.run(async (ctx) =>
			ctx.db
				.query("agent_credentials")
				.withIndex("by_agent", (q) => q.eq("agentId", agentId))
				.unique(),
		);
		expect(credentialBefore?.ownerPersonId).toBeUndefined();
		for (const table of ["agent_credentials", "oauth_access_tokens"] as const) {
			expect(await run(t, table, false)).toMatchObject({ updated: 1 });
			expect(await run(t, table, false)).toMatchObject({
				scanned: 1,
				updated: 0,
				inSync: 1,
			});
		}
		const credentialAfter = await t.run(async (ctx) =>
			ctx.db
				.query("agent_credentials")
				.withIndex("by_agent", (q) => q.eq("agentId", agentId))
				.unique(),
		);
		expect(credentialAfter?.ownerPersonId).toBe("person-1");
	});

	test("a row naming no agent is counted and left untouched", async () => {
		const { t, agentId } = await world();
		await t.run(async (ctx) => {
			await ctx.db.delete(agentId);
		});
		expect(await run(t, "oauth_access_tokens", false)).toMatchObject({
			scanned: 1,
			updated: 0,
			missingAgent: 1,
		});
	});
});
