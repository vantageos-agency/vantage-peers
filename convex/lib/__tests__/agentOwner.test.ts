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
import { api } from "../../_generated/api";
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
	deactivatedAt?: number,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("orgMembership", {
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			clerkUserId: personId,
			role: "member",
			createdAt: 1,
			updatedAt: 1,
			...(deactivatedAt !== undefined ? { deactivatedAt } : {}),
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
		await seedMember(t, "org-a", "person-1", 99);
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
