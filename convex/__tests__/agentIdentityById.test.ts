/// <reference types="vite/client" />
/**
 * Module M8 (VantagePeers Cloud): agent registry and agent credentials are
 * resolved BY AGENT ID. A name is a display label; it never selects a row and
 * never authorises one. Identity is decided by @vantageos/cloud-identity
 * (validatePresentedBearer, resolveActingPrincipal, assertTargetBelongsTo,
 * assertOrgAdmin); this repo keeps no identity primitive of its own.
 *
 * Every caller below is an ORDINARY org identity (org admin of its own org) or
 * the fleet service account on the one door that is service-account-only. No
 * proof here runs under the master bypass.
 *
 * Four properties, each with both poles:
 *   1. the agent's own record is resolved by ID, under a SCOPED identity;
 *   2. the same name in another org is never returned and never writable;
 *   3. a missing or garbled credential is a typed refusal, never an empty
 *      success;
 *   4. a rename touches the display name only and keeps every grant.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
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

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_role: "org:admin",
	} as Identity);

const memberOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		org_slug: org,
		org_role: "org:member",
	} as Identity);

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seedOrg(t: T, slug: string, roster: string[] = ["ada"]) {
	await t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: 1_700_000_000_000,
		}),
	);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		// convex-test hands a string payload back JSON-quoted.
		return typeof data === "string" ? data.replace(/^"/, "") : String(e);
	}
	return "NO-REFUSAL";
}

/** An agents id that is well formed and names no row (insert, then delete). */
async function deletedAgentId(t: T): Promise<Id<"agents">> {
	return await t.run(async (ctx) => {
		const id = await ctx.db.insert("agents", {
			orgSlug: "org-a",
			name: "ghost",
			normalizedName: "ghost",
			isActive: true,
			createdAt: 1,
		});
		await ctx.db.delete(id);
		return id;
	});
}

describe("M8 1. the agent's own record is resolved by ID under a scoped identity", () => {
	test("PRESENT: the org admin reads its agent by agentId and gets that row", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = adminOf(t, "org-a");
		const ada = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "ada",
		});
		const row = await admin.query(api.agents.getAgent, {
			orgSlug: "org-a",
			agentId: ada,
		});
		expect(row?._id).toBe(ada);
		expect(row?.name).toBe("ada");
	});

	test("ABSENT: a well formed id naming no row is an absence (null), not a refusal", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const ghost = await deletedAgentId(t);
		const row = await adminOf(t, "org-a").query(api.agents.getAgent, {
			orgSlug: "org-a",
			agentId: ghost,
		});
		expect(row).toBeNull();
	});

	test("REFUSED: an ordinary member (not admin) of the same org cannot read by id", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const ada = await adminOf(t, "org-a").mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "ada",
		});
		const code = await codeOf(
			memberOf(t, "org-a").query(api.agents.getAgent, {
				orgSlug: "org-a",
				agentId: ada,
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("REFUSED: the service account is not an org admin (no master bypass on the registry doors)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const ada = await adminOf(t, "org-a").mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "ada",
		});
		const code = await codeOf(
			asServiceAccount(t).query(api.agents.getAgent, {
				orgSlug: "org-a",
				agentId: ada,
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("a name is not an argument: the legacy by-name shape is rejected by the validator", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = adminOf(t, "org-a");
		await admin.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "ada" });
		const code = await codeOf(
			admin.query(api.agents.getAgent, {
				orgSlug: "org-a",
				name: "ada",
			} as unknown as { orgSlug: string; agentId: Id<"agents"> }),
		);
		expect(code).not.toBe("NO-REFUSAL");
	});
});

describe("M8 2. the same name in another org is refused or not returned", () => {
	async function twoOrgs() {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const etaA = await adminOf(t, "org-a").mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "eta",
		});
		const etaB = await adminOf(t, "org-b").mutation(api.agents.registerAgent, {
			orgSlug: "org-b",
			name: "eta",
		});
		return { t, etaA, etaB };
	}

	test("PRESENT: two orgs each hold their own 'eta', with different ids", async () => {
		const { t, etaA, etaB } = await twoOrgs();
		expect(etaA).not.toBe(etaB);
		const a = await adminOf(t, "org-a").query(api.agents.getAgent, {
			orgSlug: "org-a",
			agentId: etaA,
		});
		expect(a?._id).toBe(etaA);
	});

	test("REFUSED: org A's admin naming org B's eta by id is refused, and nothing of B is returned", async () => {
		const { t, etaB } = await twoOrgs();
		const code = await codeOf(
			adminOf(t, "org-a").query(api.agents.getAgent, {
				orgSlug: "org-a",
				agentId: etaB,
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("REFUSED: org A's admin cannot rename, deactivate, address, mint or revoke org B's eta by id; B's row is untouched", async () => {
		const { t, etaB } = await twoOrgs();
		const admin = adminOf(t, "org-a");
		const attempts = [
			admin.mutation(api.agents.renameAgent, {
				orgSlug: "org-a",
				agentId: etaB,
				newName: "stolen",
			}),
			admin.mutation(api.agents.deactivateAgent, { orgSlug: "org-a", agentId: etaB }),
			admin.mutation(api.agents.setAgentAddress, {
				orgSlug: "org-a",
				agentId: etaB,
				address: "https://evil.example",
			}),
			admin.mutation(api.agentCredentials.mintAgentCredential, {
				orgSlug: "org-a",
				agentId: etaB,
			}),
			admin.mutation(api.agentCredentials.revokeAgentCredential, {
				orgSlug: "org-a",
				agentId: etaB,
			}),
		];
		for (const attempt of attempts) {
			expect(await codeOf(attempt)).toMatch(/^RBAC_DENIED/);
		}
		const row = await t.run((ctx) => ctx.db.get(etaB));
		expect(row?.name).toBe("eta");
		expect(row?.isActive).toBe(true);
		expect(row?.address).toBeUndefined();
		const creds = await t.run((ctx) =>
			ctx.db
				.query("agent_credentials")
				.withIndex("by_agent", (q) => q.eq("agentId", etaB))
				.collect(),
		);
		expect(creds).toHaveLength(0);
	});

	test("REFUSED: org A's admin passing org B's slug is refused (the admin check binds to its own org)", async () => {
		const { t, etaB } = await twoOrgs();
		const code = await codeOf(
			adminOf(t, "org-a").query(api.agents.getAgent, {
				orgSlug: "org-b",
				agentId: etaB,
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("a name is only a per-org uniqueness label: a second 'ETA' in org A is refused naming the existing id, never merged", async () => {
		const { t, etaA } = await twoOrgs();
		const refusal = await codeOf(
			adminOf(t, "org-a").mutation(api.agents.registerAgent, {
				orgSlug: "org-a",
				name: "ETA",
			}),
		);
		expect(refusal).toMatch(/^AGENT_NAME_TAKEN/);
		expect(refusal).toContain(etaA);
		const rows = await t.run((ctx) =>
			ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", "org-a"))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});
});

describe("M8 3. a missing or garbled credential is refused, never an empty success", () => {
	async function withCredential() {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = adminOf(t, "org-a");
		const ada = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "ada",
		});
		const minted = await admin.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentId: ada,
		});
		return { t, admin, ada, secret: minted.secret };
	}

	test("PRESENT: a live secret resolves to the agent's id, org and current label", async () => {
		const { t, ada, secret } = await withCredential();
		const resolved = await asServiceAccount(t).query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: secret },
		);
		expect(resolved).toEqual({ orgSlug: "org-a", agentName: "ada", agentId: ada });
	});

	test("REFUSED: an empty secret raises RBAC_DENIED (no-credential)", async () => {
		const { t } = await withCredential();
		const code = await codeOf(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: "",
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
		expect(code).toContain("no-credential");
	});

	test("REFUSED: a garbled secret (not a minted one, or containing whitespace) raises RBAC_DENIED", async () => {
		const { t, secret } = await withCredential();
		for (const garbled of [
			"not-a-minted-secret",
			`${secret} extra`,
			secret.slice(0, 20),
			secret.toUpperCase(),
		]) {
			const code = await codeOf(
				asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
					presentedSecret: garbled,
				}),
			);
			expect(code).toMatch(/^RBAC_DENIED/);
			expect(code).toContain("credential-not-recognised");
		}
	});

	test("REFUSED: a rotated-out secret and a secret of a deactivated agent are refused", async () => {
		const { t, admin, ada, secret } = await withCredential();
		await admin.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentId: ada,
		});
		expect(
			await codeOf(
				asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
					presentedSecret: secret,
				}),
			),
		).toMatch(/^RBAC_DENIED/);
	});

	test("REFUSED: a legacy credential row with no agentId is never selected by its label", async () => {
		const { t, ada, secret } = await withCredential();
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("agent_credentials")
				.withIndex("by_agent", (q) => q.eq("agentId", ada))
				.first();
			if (row === null) throw new Error("fixture: credential row missing");
			await ctx.db.patch(row._id, { agentId: undefined });
		});
		const code = await codeOf(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("REFUSED: a non-service caller is refused before the secret is examined", async () => {
		const { admin, secret } = await withCredential();
		const code = await codeOf(
			admin.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("REFUSED: mint and revoke with an id naming no row raise AGENT_NOT_FOUND; a garbled id is refused by the validator", async () => {
		const { t, admin } = await withCredential();
		const ghost = await deletedAgentId(t);
		expect(
			await codeOf(
				admin.mutation(api.agentCredentials.mintAgentCredential, {
					orgSlug: "org-a",
					agentId: ghost,
				}),
			),
		).toMatch(/^AGENT_NOT_FOUND/);
		expect(
			await codeOf(
				admin.mutation(api.agentCredentials.revokeAgentCredential, {
					orgSlug: "org-a",
					agentId: ghost,
				}),
			),
		).toMatch(/^AGENT_NOT_FOUND/);
		const garbled = "not-an-id" as unknown as Id<"agents">;
		for (const attempt of [
			admin.mutation(api.agentCredentials.mintAgentCredential, {
				orgSlug: "org-a",
				agentId: garbled,
			}),
			admin.mutation(api.agentCredentials.revokeAgentCredential, {
				orgSlug: "org-a",
				agentId: garbled,
			}),
		]) {
			expect(await codeOf(attempt)).toContain("Validator error");
		}
	});

	test("ABSENT: an existing agent with no credential reports a plain zero, distinct from every refusal", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = adminOf(t, "org-a");
		const bare = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "bare",
		});
		const status = await admin.query(api.agentCredentials.getAgentCredentialStatus, {
			orgSlug: "org-a",
			agentId: bare,
		});
		expect(status.hasActiveCredential).toBe(false);
		expect(status.activeRows).toBe(0);
	});
});

// "A renamed agent stays addressable" is owned by M1 (task k173a1jxyvgtsenh5y1j0sjehd8fzk6c), not asserted here.
describe("M8 4. a rename touches the display name only and keeps every grant", () => {
	test("PRESENT: after a rename the credential, the directory entry, the edges and the roster all still hold", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["ada", "clio"]);
		const admin = adminOf(t, "org-a");
		const ada = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "ada",
		});
		const clio = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "clio",
		});
		const { secret } = await admin.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentId: ada,
		});
		await admin.mutation(api.agentRelations.linkChild, {
			orgSlug: "org-a",
			parentAgentId: ada,
			childAgentId: clio,
		});

		await admin.mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			agentId: ada,
			newName: "ada2",
		});

		// The id is unchanged and carries the new label.
		const row = await admin.query(api.agents.getAgent, { orgSlug: "org-a", agentId: ada });
		expect(row?._id).toBe(ada);
		expect(row?.name).toBe("ada2");

		// The credential still resolves to the same agent id.
		const resolved = await asServiceAccount(t).query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: secret },
		);
		expect(resolved.agentId).toBe(ada);
		expect(resolved.agentName).toBe("ada2");
		const status = await admin.query(api.agentCredentials.getAgentCredentialStatus, {
			orgSlug: "org-a",
			agentId: ada,
		});
		expect(status.activeRows).toBe(1);

		// A roster names agents by LABEL until module M1 (task
		// k173a1jxyvgtsenh5y1j0sjehd8fzk6c) stores IDs. The label the renamed
		// agent left names nobody now: the directory lists it, not addressable,
		// and never resolves it to the renamed agent through a remembered label.
		const directory = await admin.query(api.orgRoster.getMyAgentDirectory, {});
		expect(directory).toEqual([
			{ name: "ada", agentId: null },
			{ name: "clio", agentId: clio },
		]);
		expect(directory.find((e) => e.agentId === ada)).toBeUndefined();

		// The row remembers no former label: a rename writes the display label only.
		const stored = await t.run((ctx) => ctx.db.get(ada));
		expect(Object.keys(stored ?? {})).not.toContain("formerNames");

		// The edge still reaches both agents, by id.
		const children = await admin.query(api.agentRelations.childrenOf, {
			orgSlug: "org-a",
			parentAgentId: ada,
		});
		expect(children).toHaveLength(1);
		const parents = await admin.query(api.agentRelations.parentsOf, {
			orgSlug: "org-a",
			childAgentId: clio,
		});
		expect(parents).toHaveLength(1);

		// No roster was rewritten: the mapping row is byte for byte what it was.
		const mapping = await t.run((ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-a"))
				.first(),
		);
		expect(mapping?.allowedOrchestrators).toEqual(["ada", "clio"]);
	});

	test("a roster label is resolved to the agent that carries it NOW: after a rename the old label names nobody, a new agent registered under it takes the entry, and an agent never on the roster stays unlisted", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["ada"]);
		const admin = adminOf(t, "org-a");
		const ada = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "ada",
		});
		const outsider = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "outsider",
		});
		await admin.mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			agentId: ada,
			newName: "ada2",
		});

		const before = await admin.query(api.orgRoster.getMyAgentDirectory, {});
		expect(before).toEqual([{ name: "ada", agentId: null }]);
		expect(before.find((e) => e.agentId === outsider)).toBeUndefined();

		// Someone now carries the label the roster names: that agent takes the
		// entry, the renamed one is never reached through it.
		const newAda = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "ada",
		});
		const after = await admin.query(api.orgRoster.getMyAgentDirectory, {});
		expect(after).toEqual([{ name: "ada", agentId: newAda }]);
		expect(newAda).not.toBe(ada);
	});

	test("PRESENT: deactivate and reactivate still reach the agent by id after a rename", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = adminOf(t, "org-a");
		const ada = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "ada",
		});
		await admin.mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			agentId: ada,
			newName: "ada2",
		});
		const off = await admin.mutation(api.agents.deactivateAgent, {
			orgSlug: "org-a",
			agentId: ada,
		});
		expect(off.deactivated).toBe(true);
		const on = await admin.mutation(api.agents.reactivateAgent, {
			orgSlug: "org-a",
			agentId: ada,
		});
		expect(on.reactivated).toBe(true);
	});

	test("REFUSED: renaming onto another agent's label (any case) is refused; the id keeps its old label", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = adminOf(t, "org-a");
		const ada = await admin.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "ada",
		});
		await admin.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "clio" });
		const code = await codeOf(
			admin.mutation(api.agents.renameAgent, {
				orgSlug: "org-a",
				agentId: ada,
				newName: "CLIO",
			}),
		);
		expect(code).toMatch(/^AGENT_NAME_TAKEN/);
		const row = await t.run((ctx) => ctx.db.get(ada));
		expect(row?.name).toBe("ada");
	});

	test("ABSENT: renaming an id that names no row raises AGENT_NOT_FOUND", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const ghost = await deletedAgentId(t);
		const code = await codeOf(
			adminOf(t, "org-a").mutation(api.agents.renameAgent, {
				orgSlug: "org-a",
				agentId: ghost,
				newName: "x",
			}),
		);
		expect(code).toMatch(/^AGENT_NOT_FOUND/);
	});
});
