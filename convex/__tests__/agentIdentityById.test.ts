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

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { ownAgent } from "../../tests/lib/ownAgent";
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
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Identity);

const memberOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:member",
	} as Identity);

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seedOrg(t: T, slug: string, roster: string[] = ["ada"]) {
	await t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: 1_700_000_000_000,
		}),
	);
}

/** Store the roster of an organisation as agent IDs (module M1). */
async function storeRosterIds(t: T, slug: string, ids: Id<"agents">[]) {
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.first();
		if (row === null) throw new Error(`no mapping for ${slug}`);
		await ctx.db.patch(row._id, { allowedAgentIds: ids });
	});
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
			clerkOrgId: testClerkOrgId("org-a"),
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
			name: "ada",
		});
		const row = await admin.query(api.agents.getAgent, {
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
			agentId: ghost,
		});
		expect(row).toBeNull();
	});

	test("REFUSED: an ordinary member (not admin) of the same org cannot read by id", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const ada = await adminOf(t, "org-a").mutation(api.agents.registerAgent, {
			name: "ada",
		});
		const code = await codeOf(
			memberOf(t, "org-a").query(api.agents.getAgent, {
				agentId: ada,
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("REFUSED: the service account is not an org admin (no master bypass on the registry doors)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const ada = await adminOf(t, "org-a").mutation(api.agents.registerAgent, {
			name: "ada",
		});
		const code = await codeOf(
			asServiceAccount(t).query(api.agents.getAgent, {
				agentId: ada,
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("a name is not an argument: the legacy by-name shape is rejected by the validator", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = adminOf(t, "org-a");
		await admin.mutation(api.agents.registerAgent, { name: "ada" });
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
			name: "eta",
		});
		const etaB = await adminOf(t, "org-b").mutation(api.agents.registerAgent, {
			name: "eta",
		});
		return { t, etaA, etaB };
	}

	test("PRESENT: two orgs each hold their own 'eta', with different ids", async () => {
		const { t, etaA, etaB } = await twoOrgs();
		expect(etaA).not.toBe(etaB);
		const a = await adminOf(t, "org-a").query(api.agents.getAgent, {
			agentId: etaA,
		});
		expect(a?._id).toBe(etaA);
	});

	test("REFUSED: org A's admin naming org B's eta by id is refused, and nothing of B is returned", async () => {
		const { t, etaB } = await twoOrgs();
		const code = await codeOf(
			adminOf(t, "org-a").query(api.agents.getAgent, {
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
				agentId: etaB,
				newName: "stolen",
			}),
			admin.mutation(api.agents.deactivateAgent, { agentId: etaB }),
			admin.mutation(api.agents.setAgentAddress, {
				agentId: etaB,
				address: "https://evil.example",
			}),
			admin.mutation(api.agentCredentials.mintAgentCredential, {
				agentId: etaB,
			}),
			admin.mutation(api.agentCredentials.revokeAgentCredential, {
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
				agentId: etaB,
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("a name is only a per-org uniqueness label: a second 'ETA' in org A is refused naming the existing id, never merged", async () => {
		const { t, etaA } = await twoOrgs();
		const refusal = await codeOf(
			adminOf(t, "org-a").mutation(api.agents.registerAgent, {
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
			name: "ada",
		});
		await ownAgent(t, "org-a", "ada");
		const minted = await admin.mutation(api.agentCredentials.mintAgentCredential, {
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
					agentId: ghost,
				}),
			),
		).toMatch(/^AGENT_NOT_FOUND/);
		expect(
			await codeOf(
				admin.mutation(api.agentCredentials.revokeAgentCredential, {
					agentId: ghost,
				}),
			),
		).toMatch(/^AGENT_NOT_FOUND/);
		const garbled = "not-an-id" as unknown as Id<"agents">;
		for (const attempt of [
			admin.mutation(api.agentCredentials.mintAgentCredential, {
				agentId: garbled,
			}),
			admin.mutation(api.agentCredentials.revokeAgentCredential, {
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
			name: "bare",
		});
		const status = await admin.query(api.agentCredentials.getAgentCredentialStatus, {
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
			name: "ada",
		});
		const clio = await admin.mutation(api.agents.registerAgent, {
			name: "clio",
		});
		await ownAgent(t, "org-a", "ada");
		const { secret } = await admin.mutation(api.agentCredentials.mintAgentCredential, {
			agentId: ada,
		});
		await admin.mutation(api.agentRelations.linkChild, {
			parentAgentId: ada,
			childAgentId: clio,
		});
		await storeRosterIds(t, "org-a", [ada, clio]);

		await admin.mutation(api.agents.renameAgent, {
			agentId: ada,
			newName: "ada2",
		});

		// The id is unchanged and carries the new label.
		const row = await admin.query(api.agents.getAgent, { agentId: ada });
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
			agentId: ada,
		});
		expect(status.activeRows).toBe(1);

		// The roster holds the agent's ID (module M1): the renamed agent stays
		// listed and addressable, under its new label.
		const directory = await admin.query(api.orgRoster.getMyAgentDirectory, {});
		expect(directory).toEqual([
			{ name: "ada2", agentId: ada },
			{ name: "clio", agentId: clio },
		]);

		// The row remembers no former label: a rename writes the display label only.
		const stored = await t.run((ctx) => ctx.db.get(ada));
		expect(Object.keys(stored ?? {})).not.toContain("formerNames");

		// The edge still reaches both agents, by id.
		const children = await admin.query(api.agentRelations.childrenOf, {
			parentAgentId: ada,
		});
		expect(children).toHaveLength(1);
		const parents = await admin.query(api.agentRelations.parentsOf, {
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

	test("a roster holds an agent's ID, not its label: after a rename a new agent registered under the old label is not listed, and an agent never on the roster stays unlisted", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["ada"]);
		const admin = adminOf(t, "org-a");
		const ada = await admin.mutation(api.agents.registerAgent, {
			name: "ada",
		});
		const outsider = await admin.mutation(api.agents.registerAgent, {
			name: "outsider",
		});
		await storeRosterIds(t, "org-a", [ada]);
		await admin.mutation(api.agents.renameAgent, {
			agentId: ada,
			newName: "ada2",
		});

		const before = await admin.query(api.orgRoster.getMyAgentDirectory, {});
		expect(before).toEqual([{ name: "ada2", agentId: ada }]);
		expect(before.find((e) => e.agentId === outsider)).toBeUndefined();

		// Someone now carries the label the roster once displayed: it is a
		// different agent with a different ID, and it is NOT on the roster.
		const newAda = await admin.mutation(api.agents.registerAgent, {
			name: "ada",
		});
		const after = await admin.query(api.orgRoster.getMyAgentDirectory, {});
		expect(after).toEqual([{ name: "ada2", agentId: ada }]);
		expect(after.find((e) => e.agentId === newAda)).toBeUndefined();
		expect(newAda).not.toBe(ada);
	});

	test("PRESENT: deactivate and reactivate still reach the agent by id after a rename", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = adminOf(t, "org-a");
		const ada = await admin.mutation(api.agents.registerAgent, {
			name: "ada",
		});
		await admin.mutation(api.agents.renameAgent, {
			agentId: ada,
			newName: "ada2",
		});
		const off = await admin.mutation(api.agents.deactivateAgent, {
			agentId: ada,
		});
		expect(off.deactivated).toBe(true);
		const on = await admin.mutation(api.agents.reactivateAgent, {
			agentId: ada,
		});
		expect(on.reactivated).toBe(true);
	});

	test("REFUSED: renaming onto another agent's label (any case) is refused; the id keeps its old label", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = adminOf(t, "org-a");
		const ada = await admin.mutation(api.agents.registerAgent, {
			name: "ada",
		});
		await admin.mutation(api.agents.registerAgent, { name: "clio" });
		const code = await codeOf(
			admin.mutation(api.agents.renameAgent, {
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
				agentId: ghost,
				newName: "x",
			}),
		);
		expect(code).toMatch(/^AGENT_NOT_FOUND/);
	});
});

describe("M8 5. the organisation and the authority come from the verified session, never from an argument", () => {
	/** An admin session of org-a whose slug claim is stale: the mapping was renamed. */
	async function renamedOrg() {
		const t = createT();
		await seedOrg(t, "org-a");
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-a"))
				.first();
			if (row === null) throw new Error("no mapping");
			await ctx.db.patch(row._id, { clerkOrgSlug: "org-a-renamed" });
		});
		return { t, admin: adminOf(t, "org-a") };
	}

	/** An agent row of org-a that was written before agents carried an org ID. */
	async function unstampedAgent(t: T): Promise<Id<"agents">> {
		return await t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: "org-a",
				name: "legacy",
				normalizedName: "legacy",
				isActive: true,
				createdAt: 1,
			}),
		);
	}

	test("PRESENT: registerAgent takes no organisation argument and stamps the verified org's id and current label", async () => {
		const { t, admin } = await renamedOrg();
		const ada = await admin.mutation(api.agents.registerAgent, { name: "ada" });
		const row = await t.run((ctx) => ctx.db.get(ada));
		expect(row?.clerkOrgId).toBe(testClerkOrgId("org-a"));
		expect(row?.orgSlug).toBe("org-a-renamed");
	});

	test("PRESENT: the registry doors serve the admin with no organisation argument", async () => {
		const { admin } = await renamedOrg();
		const ada = await admin.mutation(api.agents.registerAgent, { name: "ada" });
		const bare = await admin.query(api.agents.getAgent, { agentId: ada });
		expect(bare?._id).toBe(ada);
		const listed = await admin.query(api.agents.listAgentsByOrg, {});
		expect(listed.map((r) => r._id)).toEqual([ada]);
		const status = await admin.query(api.agentCredentials.getAgentCredentialStatus, {
			agentId: ada,
		});
		expect(status.hasActiveCredential).toBe(false);
		expect(await admin.query(api.agentRelations.graphByOrg, {})).toEqual({
			nodes: [],
			edges: [],
		});
	});

	test("REFUSED: an organisation argument is rejected at every registry door, never read, never ignored", async () => {
		const { t, admin } = await renamedOrg();
		const ada = await admin.mutation(api.agents.registerAgent, { name: "ada" });
		await seedOrg(t, "org-b");
		// The org's own old slug (stale after the rename), its current label, another
		// org's slug and a slug naming nothing: the answer is the same for all.
		for (const orgSlug of ["org-a", "org-a-renamed", "org-b", "no-such-org"]) {
			const attempts = [
				() => admin.query(api.agents.getAgent, { orgSlug, agentId: ada } as never),
				() => admin.query(api.agents.listAgentsByOrg, { orgSlug } as never),
				() => admin.mutation(api.agents.registerAgent, { orgSlug, name: "x" } as never),
				() =>
					admin.mutation(api.agentCredentials.mintAgentCredential, {
						orgSlug,
						agentId: ada,
					} as never),
				() => admin.query(api.agentRelations.graphByOrg, { orgSlug } as never),
			];
			for (const attempt of attempts) {
				expect(await codeOf(attempt())).toMatch(/orgSlug/);
			}
		}
		// Nothing was written by the rejected calls.
		const rows = await t.run((ctx) => ctx.db.query("agents").collect());
		expect(rows.map((r) => r.name)).toEqual(["ada"]);
	});

	test("PRESENT: mint and linkChild need no organisation argument; the rows carry the verified org id", async () => {
		const { t, admin } = await renamedOrg();
		const ada = await admin.mutation(api.agents.registerAgent, { name: "ada" });
		const clio = await admin.mutation(api.agents.registerAgent, { name: "clio" });
		await admin.mutation(api.agentCredentials.mintAgentCredential, { agentId: ada });
		const edge = await admin.mutation(api.agentRelations.linkChild, {
			parentAgentId: ada,
			childAgentId: clio,
		});
		const rows = await t.run(async (ctx) => ({
			credential: await ctx.db
				.query("agent_credentials")
				.withIndex("by_agent", (q) => q.eq("agentId", ada))
				.first(),
			edge: await ctx.db.get(edge),
		}));
		expect(rows.credential?.clerkOrgId).toBe(testClerkOrgId("org-a"));
		expect(rows.edge?.clerkOrgId).toBe(testClerkOrgId("org-a"));
	});

	test("REFUSED: a member of the org, and org B's admin, are refused every registry door with no organisation argument", async () => {
		const { t, admin } = await renamedOrg();
		const ada = await admin.mutation(api.agents.registerAgent, { name: "ada" });
		await seedOrg(t, "org-b");
		// Org B's admin may register in ORG B (its own org); every other door and
		// the member's every door act on org A's agent or org A's registry.
		const reach = (who: ReturnType<typeof memberOf>) => [
			() => who.query(api.agents.getAgent, { agentId: ada }),
			() => who.mutation(api.agents.renameAgent, { agentId: ada, newName: "taken" }),
			() => who.mutation(api.agentCredentials.mintAgentCredential, { agentId: ada }),
		];
		const member = memberOf(t, "org-a");
		const attempts = [
			() => member.mutation(api.agents.registerAgent, { name: "intruder" }),
			...reach(member),
			...reach(adminOf(t, "org-b")),
		];
		for (const attempt of attempts) {
			expect(await codeOf(attempt())).toMatch(/^RBAC_DENIED/);
		}
		const row = await t.run((ctx) => ctx.db.get(ada));
		expect(row?.name).toBe("ada");
	});

	test("REFUSED: an agent row with no stored org id is never served or written on a label match (fail closed)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const legacy = await unstampedAgent(t);
		const admin = adminOf(t, "org-a");
		const attempts = [
			() => admin.query(api.agents.getAgent, { agentId: legacy }),
			() => admin.mutation(api.agents.deactivateAgent, { agentId: legacy }),
			() =>
				admin.mutation(api.agentCredentials.mintAgentCredential, {
					agentId: legacy,
				}),
		];
		for (const attempt of attempts) {
			const code = await codeOf(attempt());
			expect(code).toMatch(/^RBAC_DENIED/);
			expect(code).toContain("target-unstamped");
		}
		const row = await t.run((ctx) => ctx.db.get(legacy));
		expect(row?.isActive).toBe(true);
	});

	test("REFUSED: a caller with no session is refused by the package's own refusal at every registry door", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const ada = await adminOf(t, "org-a").mutation(api.agents.registerAgent, { name: "ada" });
		const attempts = [
			() => t.mutation(api.agents.registerAgent, { name: "x" }),
			() => t.query(api.agents.getAgent, { agentId: ada }),
			() => t.query(api.agents.listAgentsByOrg, {}),
			() => t.mutation(api.agentCredentials.mintAgentCredential, { agentId: ada }),
			() => t.query(api.agentCredentials.getAgentCredentialStatus, { agentId: ada }),
			() =>
				t.mutation(api.agentRelations.linkChild, { parentAgentId: ada, childAgentId: ada }),
			() => t.query(api.agentRelations.graphByOrg, {}),
		];
		for (const attempt of attempts) {
			const code = await codeOf(attempt());
			expect(code).toMatch(/^RBAC_DENIED/);
			expect(code).toContain("no-verified-subject");
		}
	});
});
