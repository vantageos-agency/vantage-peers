/// <reference types="vite/client" />
/**
 * Retire surface for agents: deactivateAgent, revokeAgentCredential, and the
 * registerAgent reactivation guard. Before this, an org-admin could provision
 * an agent and its credential and could never un-provision either.
 *
 * Every identity here is an ORDINARY org-admin, never master — a proof
 * obtained under master exercises the bypass and establishes nothing.
 * Fixture seeds THREE agents (alpha, beta, gamma), each with an active
 * credential, so the negative pole can discriminate: assertions are made PER
 * NAME, never as an aggregate count.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const adminOf = (org: string) =>
	({ subject: `admin-of-${org}`, org_slug: org, org_role: "org:admin" }) as Identity;

async function seedOrg(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["existing-seat"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const NAMES = ["alpha", "beta", "gamma"] as const;

async function seedThreeAgents(t: T) {
	await seedOrg(t, "org-a");
	const admin = t.withIdentity(adminOf("org-a"));
	const secrets: Record<string, string> = {};
	for (const name of NAMES) {
		await admin.mutation(api.agents.registerAgent, { orgSlug: "org-a", name });
		const minted = await admin.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentName: name,
		});
		secrets[name] = minted.secret;
	}
	return { t, admin, secrets };
}

async function activeRowsByName(admin: ReturnType<T["withIdentity"]>) {
	const out: Record<string, number> = {};
	for (const name of NAMES) {
		const s = await admin.query(api.agentCredentials.getAgentCredentialStatus, {
			orgSlug: "org-a",
			agentName: name,
		});
		out[name] = s.activeRows;
	}
	return out;
}

describe("agent retire surface", () => {
	test("POLE 1: deactivateAgent flips ONLY the named row; the others stay active", async () => {
		const { admin } = await seedThreeAgents(createT());
		const res = await admin.mutation(api.agents.deactivateAgent, {
			orgSlug: "org-a",
			name: "beta",
		});
		expect(res).toEqual({ wasActive: true });

		const rows = await admin.query(api.agents.listAgentsByOrg, { orgSlug: "org-a" });
		const byName = Object.fromEntries(rows.map((r) => [r.name, r.isActive]));
		expect(byName.beta).toBe(false);
		expect(byName.alpha).toBe(true);
		expect(byName.gamma).toBe(true);
		// Patched, never deleted: the row is still there.
		expect(rows).toHaveLength(3);

		// Second call says so: already inactive is not "flipped".
		const again = await admin.mutation(api.agents.deactivateAgent, {
			orgSlug: "org-a",
			name: "beta",
		});
		expect(again).toEqual({ wasActive: false });
	});

	test("POLE 1b: deactivateAgent on an unknown name raises AGENT_NOT_FOUND", async () => {
		const { admin } = await seedThreeAgents(createT());
		await expect(
			admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "nobody" }),
		).rejects.toThrow(/AGENT_NOT_FOUND/);
	});

	test("POLE 2 + NEGATIVE: revokeAgentCredential returns the count; only that agent drops to 0, others stay at 1 (per name)", async () => {
		const { admin } = await seedThreeAgents(createT());
		expect(await activeRowsByName(admin)).toEqual({ alpha: 1, beta: 1, gamma: 1 });

		const res = await admin.mutation(api.agentCredentials.revokeAgentCredential, {
			orgSlug: "org-a",
			agentName: "beta",
		});
		expect(res).toEqual({ revoked: 1 });

		const after = await activeRowsByName(admin);
		expect(after.beta).toBe(0);
		expect(after.alpha).toBe(1);
		expect(after.gamma).toBe(1);

		// Nothing left to revoke is a COUNT of zero, distinct from "revoked 1".
		const again = await admin.mutation(api.agentCredentials.revokeAgentCredential, {
			orgSlug: "org-a",
			agentName: "beta",
		});
		expect(again).toEqual({ revoked: 0 });

		// Unknown agent is a refusal, not {revoked: 0}.
		await expect(
			admin.mutation(api.agentCredentials.revokeAgentCredential, {
				orgSlug: "org-a",
				agentName: "nobody",
			}),
		).rejects.toThrow(/AGENT_NOT_FOUND/);
	});

	test("POLE 3: a revoked secret is refused credential-not-recognised; the others' secrets still resolve", async () => {
		const { t, admin, secrets } = await seedThreeAgents(createT());
		await admin.mutation(api.agentCredentials.revokeAgentCredential, {
			orgSlug: "org-a",
			agentName: "beta",
		});

		await expect(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secrets.beta,
			}),
		).rejects.toThrow(/credential-not-recognised/);

		for (const name of ["alpha", "gamma"] as const) {
			const ok = await t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secrets[name],
			});
			expect(ok).toEqual({ orgSlug: "org-a", agentName: name });
		}
	});

	test("POLE 4: registerAgent on a deactivated agent does NOT silently reactivate; explicit reactivate:true does", async () => {
		const { admin } = await seedThreeAgents(createT());
		await admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "beta" });

		await expect(
			admin.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "beta" }),
		).rejects.toThrow(/AGENT_DEACTIVATED/);
		const still = await admin.query(api.agents.getAgent, { orgSlug: "org-a", name: "beta" });
		expect(still?.isActive).toBe(false);

		await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "beta",
			reactivate: true,
		});
		const back = await admin.query(api.agents.getAgent, { orgSlug: "org-a", name: "beta" });
		expect(back?.isActive).toBe(true);
	});

	test("POLE 4b: reactivating does not resurrect a REVOKED credential", async () => {
		const { admin } = await seedThreeAgents(createT());
		await admin.mutation(api.agentCredentials.revokeAgentCredential, {
			orgSlug: "org-a",
			agentName: "beta",
		});
		await admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "beta" });
		await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "beta",
			reactivate: true,
		});
		expect((await activeRowsByName(admin)).beta).toBe(0);
	});

	test("POLE 5: CROSS-ORG DENY — an ordinary org-admin of B is refused RBAC_DENIED on both mutations against A, and A is untouched", async () => {
		const { t, admin } = await seedThreeAgents(createT());
		await seedOrg(t, "org-b");
		const adminB = t.withIdentity(adminOf("org-b"));

		await expect(
			adminB.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "alpha" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			adminB.mutation(api.agentCredentials.revokeAgentCredential, {
				orgSlug: "org-a",
				agentName: "alpha",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const rows = await admin.query(api.agents.listAgentsByOrg, { orgSlug: "org-a" });
		for (const r of rows) expect(r.isActive).toBe(true);
		expect(await activeRowsByName(admin)).toEqual({ alpha: 1, beta: 1, gamma: 1 });
	});
});
