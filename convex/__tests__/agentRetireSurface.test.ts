/// <reference types="vite/client" />
/**
 * Retire surface for agents: deactivateAgent (also revokes), reactivateAgent,
 * revokeAgentCredential, and the registerAgent inactive-row refusal. Before this, an org-admin could provision
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

async function agentsActiveByName(admin: ReturnType<T["withIdentity"]>) {
		const rows = await admin.query(api.agents.listAgentsByOrg, { orgSlug: "org-a" });
		return Object.fromEntries(rows.map((r) => [r.name, r.isActive]));
	}

describe("agent retire surface", () => {
	test("POLE 1 + NEGATIVE: deactivateAgent retires ONLY beta in BOTH tables, in ONE call; alpha and gamma untouched per name", async () => {
		const { admin } = await seedThreeAgents(createT());
		const res = await admin.mutation(api.agents.deactivateAgent, {
			orgSlug: "org-a",
			name: "beta",
		});
		expect(res).toEqual({ deactivated: true, revoked: 1 });

		const byName = await agentsActiveByName(admin);
		expect(byName.beta).toBe(false);
		expect(byName.alpha).toBe(true);
		expect(byName.gamma).toBe(true);

		// No separate revoke call was made: credentials are already gone.
		const rows = await activeRowsByName(admin);
		expect(rows.beta).toBe(0);
		expect(rows.alpha).toBe(1);
		expect(rows.gamma).toBe(1);

		// Patched, never deleted.
		expect(Object.keys(byName)).toHaveLength(3);

		// Already retired: not "deactivated", and nothing left to revoke.
		const again = await admin.mutation(api.agents.deactivateAgent, {
			orgSlug: "org-a",
			name: "beta",
		});
		expect(again).toEqual({ deactivated: false, revoked: 0 });
	});

	test("POLE 1b: deactivateAgent on an unknown name raises AGENT_NOT_FOUND and touches nothing", async () => {
		const { admin } = await seedThreeAgents(createT());
		await expect(
			admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "nobody" }),
		).rejects.toThrow(/AGENT_NOT_FOUND/);
		expect(await activeRowsByName(admin)).toEqual({ alpha: 1, beta: 1, gamma: 1 });
	});

	test("POLE 1c: deactivateAgent on an already-inactive agent still revokes a credential that survived", async () => {
		const { t, admin } = await seedThreeAgents(createT());
		// Legacy state: agent switched off out-of-band, credential row still live.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("agents")
				.withIndex("by_org_name", (q) => q.eq("orgSlug", "org-a").eq("name", "beta"))
				.unique();
			if (row) await ctx.db.patch(row._id, { isActive: false });
		});
		const res = await admin.mutation(api.agents.deactivateAgent, {
			orgSlug: "org-a",
			name: "beta",
		});
		expect(res).toEqual({ deactivated: false, revoked: 1 });
		expect((await activeRowsByName(admin)).beta).toBe(0);
	});

	test("POLE 2 + NEGATIVE: revokeAgentCredential returns the count; only that agent drops to 0 (per name)", async () => {
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
		// Revoking a credential does not deactivate the agent.
		expect((await agentsActiveByName(admin)).beta).toBe(true);

		const again = await admin.mutation(api.agentCredentials.revokeAgentCredential, {
			orgSlug: "org-a",
			agentName: "beta",
		});
		expect(again).toEqual({ revoked: 0 });

		await expect(
			admin.mutation(api.agentCredentials.revokeAgentCredential, {
				orgSlug: "org-a",
				agentName: "nobody",
			}),
		).rejects.toThrow(/AGENT_NOT_FOUND/);
	});

	test("POLE 3: a secret of a deactivated agent is refused credential-not-recognised; the others' secrets still resolve", async () => {
		const { t, admin, secrets } = await seedThreeAgents(createT());
		await admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "beta" });

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

	test("POLE 3b: a secret revoked alone (agent still active) is refused credential-not-recognised", async () => {
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
	});

	test("POLE 4: registerAgent on an inactive agent refuses AGENT_INACTIVE and leaves it inactive", async () => {
		const { admin } = await seedThreeAgents(createT());
		await admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "beta" });

		const attempt = admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "beta",
		});
		await expect(attempt).rejects.toThrow(/AGENT_INACTIVE/);
		await expect(attempt).rejects.not.toThrow(/AGENT_DEACTIVATED/);
		expect((await agentsActiveByName(admin)).beta).toBe(false);
	});

	test("POLE 4b: reactivateAgent brings the row back; revoked credentials stay revoked; a freshly minted one resolves", async () => {
		const { t, admin, secrets } = await seedThreeAgents(createT());
		await admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "beta" });

		const res = await admin.mutation(api.agents.reactivateAgent, {
			orgSlug: "org-a",
			name: "beta",
		});
		expect(res).toEqual({ reactivated: true, revoked: 0 });

		const byName = await agentsActiveByName(admin);
		expect(byName.beta).toBe(true);
		expect(byName.alpha).toBe(true);
		expect(byName.gamma).toBe(true);

		// Old credential NOT resurrected.
		expect((await activeRowsByName(admin)).beta).toBe(0);
		await expect(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secrets.beta,
			}),
		).rejects.toThrow(/credential-not-recognised/);

		// A freshly minted one resolves.
		const fresh = await admin.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentName: "beta",
		});
		expect(
			await t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: fresh.secret,
			}),
		).toEqual({ orgSlug: "org-a", agentName: "beta" });

		// Already active: a NO-OP. The sweep is scoped to the inactive -> active
		// transition, so a doubled call writes NOTHING and the live credential
		// survives. At 00bd640a this returned { revoked: 1 } and cut the client
		// — an outage path dressed as idempotence.
		expect(
			await admin.mutation(api.agents.reactivateAgent, { orgSlug: "org-a", name: "beta" }),
		).toEqual({ reactivated: false, revoked: 0 });
		expect(
			await t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: fresh.secret,
			}),
		).toEqual({ orgSlug: "org-a", agentName: "beta" });
		await expect(
			admin.mutation(api.agents.reactivateAgent, { orgSlug: "org-a", name: "nobody" }),
		).rejects.toThrow(/AGENT_NOT_FOUND/);
	});

	test("POLE 6 (the one that matters): mint, deactivate, reactivate — the ORIGINAL secret is refused; a FRESH one resolves and the row is active", async () => {
		const { t, admin, secrets } = await seedThreeAgents(createT());
		await admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "beta" });
		await admin.mutation(api.agents.reactivateAgent, { orgSlug: "org-a", name: "beta" });

		await expect(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secrets.beta,
			}),
		).rejects.toThrow(/credential-not-recognised/);

		// Negative pole: without this, pole 6 passes by breaking reactivation.
		expect((await agentsActiveByName(admin)).beta).toBe(true);
		const fresh = await admin.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentName: "beta",
		});
		expect(
			await t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: fresh.secret,
			}),
		).toEqual({ orgSlug: "org-a", agentName: "beta" });
	});

	test("POLE 6b: reactivateAgent sweeps a credential that SURVIVED the retirement and reports the count; Y and Z untouched per name in both tables", async () => {
		const { t, admin, secrets } = await seedThreeAgents(createT());
		await admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "beta" });
		// CONSTRUCTED, not reached: no mutation path leaves an active credential
		// on an inactive agent (deactivateAgent sweeps), and this sweep exists
		// for exactly the escape no current path produces. Insert it directly.
		await t.run(async (ctx) => {
			await ctx.db.insert("agent_credentials", {
				orgSlug: "org-a",
				agentName: "beta",
				secretHash: "escaped-row-hash",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		expect((await activeRowsByName(admin)).beta).toBe(1);

		const res = await admin.mutation(api.agents.reactivateAgent, {
			orgSlug: "org-a",
			name: "beta",
		});
		expect(res).toEqual({ reactivated: true, revoked: 1 });

		const rows = await activeRowsByName(admin);
		expect(rows.beta).toBe(0);
		expect(rows.alpha).toBe(1);
		expect(rows.gamma).toBe(1);
		const byName = await agentsActiveByName(admin);
		expect(byName.beta).toBe(true);
		expect(byName.alpha).toBe(true);
		expect(byName.gamma).toBe(true);
		for (const n of ["alpha", "gamma"] as const) {
			expect(
				await t.query(api.agentCredentials.resolveAgentCredential, {
					presentedSecret: secrets[n],
				}),
			).toEqual({ orgSlug: "org-a", agentName: n });
		}
	});

	test("POLE 6c (INVERTED at the reviewer's verdict): reactivateAgent on an ALREADY-ACTIVE agent is a NO-OP and never cuts a live client", async () => {
		// This pole asserted the OPPOSITE at 00bd640a, and the opposite was an
		// OUTAGE PATH: a doubled call, or one naming a live agent by mistake,
		// silently revoked a working client's credential and the client just
		// stopped authenticating. The ruling that introduced the sweep is
		// scoped to a REACTIVATED agent; an agent that was never retired has
		// no escaped credential to catch, so the sweep buys nothing there.
		// The pole flips with the code rather than being deleted, because a
		// corpus that asserted the old behaviour is the evidence of what
		// changed.
		const { t, admin, secrets } = await seedThreeAgents(createT());
		const res = await admin.mutation(api.agents.reactivateAgent, {
			orgSlug: "org-a",
			name: "beta",
		});
		expect(res).toEqual({ reactivated: false, revoked: 0 });
		// Nothing moved, in either table, for ANY name.
		expect(await activeRowsByName(admin)).toEqual({ alpha: 1, beta: 1, gamma: 1 });
		const byName = await agentsActiveByName(admin);
		for (const n of NAMES) expect(byName[n]).toBe(true);
		// And the live client still authenticates — the outage this pole exists
		// to catch is a REFUSAL here, not a count.
		expect(
			await t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secrets.beta,
			}),
		).toEqual({ orgSlug: "org-a", agentName: "beta" });
	});

	// CROSS-ORG LEG of the negative pole. The same agent NAME exists in org-b
	// with a credential of its own. org-a's admin acting legitimately on
	// org-a/beta must leave org-b/beta alone. POLE 5 only proves B's admin is
	// refused on A; it does not prove this. Each test asserts BOTH directions:
	// A's beta WAS retired (so a no-op mutation cannot pass) and B's beta was
	// not.
	async function seedOrgBBeta(t: T) {
		await seedOrg(t, "org-b");
		const adminB = t.withIdentity(adminOf("org-b"));
		await adminB.mutation(api.agents.registerAgent, { orgSlug: "org-b", name: "beta" });
		const minted = await adminB.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-b",
			agentName: "beta",
		});
		return { adminB, secretB: minted.secret };
	}

	async function expectOrgBBetaUntouched(
		t: T,
		adminB: ReturnType<T["withIdentity"]>,
		secretB: string,
	) {
		const row = await adminB.query(api.agents.getAgent, { orgSlug: "org-b", name: "beta" });
		expect(row?.isActive).toBe(true);
		const st = await adminB.query(api.agentCredentials.getAgentCredentialStatus, {
			orgSlug: "org-b",
			agentName: "beta",
		});
		expect(st.activeRows).toBe(1);
		expect(
			await t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secretB,
			}),
		).toEqual({ orgSlug: "org-b", agentName: "beta" });
	}

	test("POLE 7a: same-named agent in another org — org-a deactivateAgent(beta) retires A/beta and leaves B/beta untouched", async () => {
		const { t, admin, secrets } = await seedThreeAgents(createT());
		const { adminB, secretB } = await seedOrgBBeta(t);

		expect(
			await admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "beta" }),
		).toEqual({ deactivated: true, revoked: 1 });

		// Positive leg: A/beta really was retired.
		expect((await agentsActiveByName(admin)).beta).toBe(false);
		expect((await activeRowsByName(admin)).beta).toBe(0);
		await expect(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secrets.beta,
			}),
		).rejects.toThrow(/credential-not-recognised/);
		// Negative leg: B/beta untouched.
		await expectOrgBBetaUntouched(t, adminB, secretB);
	});

	test("POLE 7b: same-named agent in another org — org-a revokeAgentCredential(beta) revokes A/beta and leaves B/beta untouched", async () => {
		const { t, admin, secrets } = await seedThreeAgents(createT());
		const { adminB, secretB } = await seedOrgBBeta(t);

		expect(
			await admin.mutation(api.agentCredentials.revokeAgentCredential, {
				orgSlug: "org-a",
				agentName: "beta",
			}),
		).toEqual({ revoked: 1 });

		expect((await activeRowsByName(admin)).beta).toBe(0);
		await expect(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secrets.beta,
			}),
		).rejects.toThrow(/credential-not-recognised/);
		await expectOrgBBetaUntouched(t, adminB, secretB);
	});

	test("POLE 7c: same-named agent in another org — org-a reactivateAgent(beta) sweep does not reach B/beta", async () => {
		const { t, admin } = await seedThreeAgents(createT());
		const { adminB, secretB } = await seedOrgBBeta(t);

		await admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "beta" });
		// Constructed: a surviving credential on inactive A/beta, so the
		// reactivation sweep has something to revoke and a widened sweep would
		// have a reason to reach B.
		await t.run(async (ctx) => {
			await ctx.db.insert("agent_credentials", {
				orgSlug: "org-a",
				agentName: "beta",
				secretHash: "escaped-row-hash-7c",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		expect(
			await admin.mutation(api.agents.reactivateAgent, { orgSlug: "org-a", name: "beta" }),
		).toEqual({ reactivated: true, revoked: 1 });

		// Positive leg: A/beta is back and its escaped row was swept.
		expect((await agentsActiveByName(admin)).beta).toBe(true);
		expect((await activeRowsByName(admin)).beta).toBe(0);
		await expectOrgBBetaUntouched(t, adminB, secretB);
	});

	test("POLE 5: CROSS-ORG DENY — an ordinary org-admin of B is refused RBAC_DENIED on all three mutations against A, and A is untouched", async () => {
		const { t, admin } = await seedThreeAgents(createT());
		await seedOrg(t, "org-b");
		const adminB = t.withIdentity(adminOf("org-b"));

		await expect(
			adminB.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", name: "alpha" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			adminB.mutation(api.agents.reactivateAgent, { orgSlug: "org-a", name: "alpha" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			adminB.mutation(api.agentCredentials.revokeAgentCredential, {
				orgSlug: "org-a",
				agentName: "alpha",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const byName = await agentsActiveByName(admin);
		for (const n of NAMES) expect(byName[n]).toBe(true);
		expect(await activeRowsByName(admin)).toEqual({ alpha: 1, beta: 1, gamma: 1 });
	});
});
