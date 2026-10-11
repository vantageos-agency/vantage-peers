/// <reference types="vite/client" />
// allow-missing-refs: new file
/**
 * Module M10d (VantagePeers Cloud): profiles are keyed on the AGENT ID.
 *
 * A profile belongs to an `agents` row (`profiles.agentId`); its organisation is
 * the organisation of that agent. `orchestratorId` is a label two organisations
 * may both carry and never selects a row of another organisation. Identity is
 * decided by @vantageos/cloud-identity (filterTargetsBelongingTo, sameOrg,
 * resolveActingPrincipal); this repo keeps no identity primitive of its own.
 *
 * Every caller below is an ORDINARY org identity (member or org admin of its own
 * org) or the fleet service account in the one role it keeps: carrying an
 * agent's ID it has verified, or acting as the fleet. The refusal contract of
 * profiles:listProfiles is pinned unchanged (anonymous raises, a member is told
 * `{ refused: true, items: [] }`, the master gets a bare array).
 *
 * Three poles per door: REFUSED / ABSENT / PRESENT.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
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

async function seedOrg(
	t: T,
	slug: string,
	opts: { operator?: boolean; roster?: string[] } = {},
) {
	await t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: opts.roster ?? ["ada"],
			scopes: ["view-own-tasks", "view-stats-aggregated"],
			displayName: slug,
			isActive: true,
			createdAt: 1_700_000_000_000,
			...(opts.operator ? { orgKind: "operator" as const } : {}),
		}),
	);
}

async function registerAgent(t: T, org: string, name: string) {
	return await adminOf(t, org).mutation(api.agents.registerAgent, {
		orgSlug: org,
		name,
	});
}

async function mint(t: T, org: string, agentId: Id<"agents">) {
	const minted = await adminOf(t, org).mutation(
		api.agentCredentials.mintAgentCredential,
		{ orgSlug: org, agentId },
	);
	return minted.secret;
}

const STATIC = { role: "backend", workspace: "/work", capabilities: [] };

/** A profile row written directly, as the fleet's pre-M10d data or a stamped row. */
async function insertProfile(
	t: T,
	row: {
		orchestratorId: string;
		name: string;
		instanceId?: string;
		agentId?: Id<"agents">;
		currentTask?: string;
	},
) {
	return await t.run((ctx) =>
		ctx.db.insert("profiles", {
			orchestratorId: row.orchestratorId,
			...(row.instanceId !== undefined ? { instanceId: row.instanceId } : {}),
			...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
			name: row.name,
			static: STATIC,
			dynamic: {
				lastSeen: 1,
				sessionCount: 0,
				...(row.currentTask !== undefined
					? { currentTask: row.currentTask }
					: {}),
			},
		}),
	);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data.replace(/^"/, "") : String(e);
	}
	return "NO-REFUSAL";
}

/** Two orgs, each with an agent called "ada" and a profile of its own. */
async function twoOrgs() {
	const t = createT();
	await seedOrg(t, "org-a");
	await seedOrg(t, "org-b");
	const adaA = await registerAgent(t, "org-a", "ada");
	const adaB = await registerAgent(t, "org-b", "ada");
	const profileA = await insertProfile(t, {
		orchestratorId: "ada",
		name: "Ada of A",
		instanceId: "ada-vps",
		agentId: adaA,
		currentTask: "A secret",
	});
	const profileB = await insertProfile(t, {
		orchestratorId: "ada",
		name: "Ada of B",
		instanceId: "ada-vps",
		agentId: adaB,
	});
	return { t, adaA, adaB, profileA, profileB };
}

const actorOf = (agentId: Id<"agents">, orgSlug: string) => ({
	agentId,
	orgSlug,
});

describe("M10d 1. getProfile reads by the agent ID of the caller's own organisation", () => {
	test("PRESENT: a member reads the profile of its own org's agent, never the same-named other one", async () => {
		const { t, profileA, profileB } = await twoOrgs();
		const b = await memberOf(t, "org-b").query(api.profiles.getProfile, {
			orchestratorId: "ada",
		});
		expect(b?._id).toBe(profileB);
		const a = await memberOf(t, "org-a").query(api.profiles.getProfile, {
			orchestratorId: "ada",
		});
		expect(a?._id).toBe(profileA);
	});

	test("ABSENT: the other org holds the only 'ada' profile, so the member gets an absence (null), not that row", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const adaA = await registerAgent(t, "org-a", "ada");
		await registerAgent(t, "org-b", "ada");
		await insertProfile(t, {
			orchestratorId: "ada",
			name: "Ada of A",
			agentId: adaA,
			currentTask: "A secret",
		});
		const got = await memberOf(t, "org-b").query(api.profiles.getProfile, {
			orchestratorId: "ada",
		});
		expect(got).toBeNull();
	});

	test("by instanceId two orgs may share an instance label; each member gets its own row", async () => {
		const { t, profileA, profileB } = await twoOrgs();
		const b = await memberOf(t, "org-b").query(api.profiles.getProfile, {
			instanceId: "ada-vps",
		});
		expect(b?._id).toBe(profileB);
		const a = await memberOf(t, "org-a").query(api.profiles.getProfile, {
			instanceId: "ada-vps",
		});
		expect(a?._id).toBe(profileA);
	});

	test("REFUSED: a row with no agent (written before M10d) is served to no member", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await registerAgent(t, "org-b", "ada");
		const legacy = await insertProfile(t, {
			orchestratorId: "ada",
			name: "Fleet ada",
			instanceId: "ada-vps",
		});
		const byLabel = await memberOf(t, "org-b").query(api.profiles.getProfile, {
			orchestratorId: "ada",
		});
		expect(byLabel).toBeNull();
		const byInstance = await memberOf(t, "org-b").query(api.profiles.getProfile, {
			instanceId: "ada-vps",
		});
		expect(byInstance).toBeNull();
		// The master keeps its existing grant on the same row.
		const master = await asServiceAccount(t).query(api.profiles.getProfile, {
			orchestratorId: "ada",
		});
		expect(master?._id).toBe(legacy);
	});

	test("REFUSED: a member whose roster lacks the label is still refused by RAISING (narrowing kept)", async () => {
		const { t } = await twoOrgs();
		await seedOrg(t, "org-c", { roster: ["other"] });
		const code = await codeOf(
			memberOf(t, "org-c").query(api.profiles.getProfile, {
				orchestratorId: "ada",
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("REFUSED: an anonymous caller is refused by RAISING", async () => {
		const { t } = await twoOrgs();
		const code = await codeOf(
			t.query(api.profiles.getProfile, { orchestratorId: "ada" }),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("PRESENT: the service account carrying the verified agent B reads B's row; carrying A reads A's", async () => {
		const { t, adaA, adaB, profileA, profileB } = await twoOrgs();
		const sa = asServiceAccount(t);
		const b = await sa.query(api.profiles.getProfile, {
			orchestratorId: "ada",
			verifiedActor: actorOf(adaB, "org-b"),
		});
		expect(b?._id).toBe(profileB);
		const a = await sa.query(api.profiles.getProfile, {
			orchestratorId: "ada",
			verifiedActor: actorOf(adaA, "org-a"),
		});
		expect(a?._id).toBe(profileA);
	});

	test("ABSENT: the verified agent's org holds no such profile -> null, though another org's row carries the name", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const adaA = await registerAgent(t, "org-a", "ada");
		const adaB = await registerAgent(t, "org-b", "ada");
		await insertProfile(t, { orchestratorId: "ada", name: "A", agentId: adaA });
		const got = await asServiceAccount(t).query(api.profiles.getProfile, {
			orchestratorId: "ada",
			verifiedActor: actorOf(adaB, "org-b"),
		});
		expect(got).toBeNull();
	});

	test("REFUSED: verifiedActor is believed from the service account only", async () => {
		const { t, adaA } = await twoOrgs();
		const code = await codeOf(
			memberOf(t, "org-b").query(api.profiles.getProfile, {
				orchestratorId: "ada",
				verifiedActor: actorOf(adaA, "org-a"),
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("PRESENT: the master with no acting agent keeps its existing grant (first row by label)", async () => {
		const { t } = await twoOrgs();
		const got = await asServiceAccount(t).query(api.profiles.getProfile, {
			orchestratorId: "ada",
		});
		expect(got?.orchestratorId).toBe("ada");
	});
});

describe("M10d 2. getProfileWithMemories judges its profile half by the same stored IDs", () => {
	test("PRESENT / ABSENT: the member gets its own org's profile, or null when only the other org has one", async () => {
		const { t, profileB } = await twoOrgs();
		const own = await memberOf(t, "org-b").query(
			api.profiles.getProfileWithMemories,
			{ orchestratorId: "ada", namespace: "team/org-b" },
		);
		expect(own.profile?._id).toBe(profileB);

		const t2 = createT();
		await seedOrg(t2, "org-a");
		await seedOrg(t2, "org-b");
		const adaA = await registerAgent(t2, "org-a", "ada");
		await registerAgent(t2, "org-b", "ada");
		await insertProfile(t2, { orchestratorId: "ada", name: "A", agentId: adaA });
		const none = await memberOf(t2, "org-b").query(
			api.profiles.getProfileWithMemories,
			{ orchestratorId: "ada", namespace: "team/org-b" },
		);
		expect(none.profile).toBeNull();
	});

	test("REFUSED: a row with no agent is not the profile half a member is served", async () => {
		const t = createT();
		await seedOrg(t, "org-b");
		await registerAgent(t, "org-b", "ada");
		await insertProfile(t, { orchestratorId: "ada", name: "Fleet ada" });
		const got = await memberOf(t, "org-b").query(
			api.profiles.getProfileWithMemories,
			{ orchestratorId: "ada", namespace: "team/org-b" },
		);
		expect(got.profile).toBeNull();
	});

	test("REFUSED: a namespace of another org still yields nothing (profile null, no memories)", async () => {
		const { t } = await twoOrgs();
		const got = await memberOf(t, "org-b").query(
			api.profiles.getProfileWithMemories,
			{ orchestratorId: "ada", namespace: "team/org-a" },
		);
		expect(got.profile).toBeNull();
		expect(got.memories).toEqual([]);
	});
});

describe("M10d 2b. the dashboard summary serves a member the profiles of its own org's agents", () => {
	test("PRESENT / REFUSED: member B sees B's profile and never the same-named A profile; ABSENT: an org with no profile sees none", async () => {
		const { t, profileB } = await twoOrgs();
		const b = await memberOf(t, "org-b").query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(b.activeOrchestrators.map((p) => p._id)).toEqual([profileB]);

		await seedOrg(t, "org-c");
		await registerAgent(t, "org-c", "ada");
		const c = await memberOf(t, "org-c").query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(c.activeOrchestrators).toEqual([]);
	});
});

describe("M10d 3. listProfiles keeps its refusal contract and narrows by the acting agent's ID", () => {
	test("contract: anonymous RAISES, a member gets { refused: true, items: [] }", async () => {
		const { t } = await twoOrgs();
		expect(await codeOf(t.query(api.profiles.listProfiles, {}))).toMatch(
			/^RBAC_DENIED/,
		);
		const member = await memberOf(t, "org-b").query(
			api.profiles.listProfiles,
			{},
		);
		expect(member).toEqual({ refused: true, items: [] });
	});

	test("contract: the fleet master is served a bare array of every row", async () => {
		const { t } = await twoOrgs();
		const all = await asServiceAccount(t).query(api.profiles.listProfiles, {});
		expect(Array.isArray(all)).toBe(true);
		expect(all as unknown[]).toHaveLength(2);
	});

	test("PRESENT: the master carrying agent B lists only B's org rows", async () => {
		const { t, adaB, profileB } = await twoOrgs();
		const rows = await asServiceAccount(t).query(api.profiles.listProfiles, {
			verifiedActor: actorOf(adaB, "org-b"),
		});
		expect(Array.isArray(rows)).toBe(true);
		expect((rows as Array<{ _id: Id<"profiles"> }>).map((r) => r._id)).toEqual([
			profileB,
		]);
	});

	test("ABSENT: an acting agent of an org with no profile gets a bare empty array (no refused key)", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const adaA = await registerAgent(t, "org-a", "ada");
		const adaB = await registerAgent(t, "org-b", "ada");
		await insertProfile(t, { orchestratorId: "ada", name: "A", agentId: adaA });
		const rows = await asServiceAccount(t).query(api.profiles.listProfiles, {
			verifiedActor: actorOf(adaB, "org-b"),
		});
		expect(rows).toEqual([]);
	});
});

describe("M10d 4. a profile is written only by its own agent", () => {
	test("PRESENT: agent B (verifiedActor) writes ITS row; the same-named agent A's row is untouched", async () => {
		const { t, adaB, profileA, profileB } = await twoOrgs();
		const id = await asServiceAccount(t).mutation(api.profiles.upsertProfile, {
			orchestratorId: "ada",
			instanceId: "ada-vps",
			name: "Ada B renamed",
			verifiedActor: actorOf(adaB, "org-b"),
		});
		expect(id).toBe(profileB);
		const rowA = await t.run((ctx) => ctx.db.get(profileA));
		expect(rowA?.name).toBe("Ada of A");
		const rowB = await t.run((ctx) => ctx.db.get(profileB));
		expect(rowB?.name).toBe("Ada B renamed");
	});

	test("ABSENT: agent B has no row yet, so a write CREATES its own, stamped with B's ID; A's row is untouched", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const adaA = await registerAgent(t, "org-a", "ada");
		const adaB = await registerAgent(t, "org-b", "ada");
		const profileA = await insertProfile(t, {
			orchestratorId: "ada",
			name: "Ada of A",
			agentId: adaA,
		});
		const id = await asServiceAccount(t).mutation(api.profiles.upsertProfile, {
			orchestratorId: "ada",
			name: "Ada of B",
			verifiedActor: actorOf(adaB, "org-b"),
		});
		expect(id).not.toBe(profileA);
		const created = await t.run((ctx) => ctx.db.get(id));
		expect(created?.agentId).toBe(adaB);
		const rowA = await t.run((ctx) => ctx.db.get(profileA));
		expect(rowA?.name).toBe("Ada of A");
		expect(rowA?.agentId).toBe(adaA);
	});

	test("PRESENT: a member session presenting its own agent's credential writes its row", async () => {
		const { t, adaB, profileB } = await twoOrgs();
		const secret = await mint(t, "org-b", adaB);
		const id = await memberOf(t, "org-b").mutation(api.profiles.upsertProfile, {
			orchestratorId: "ada",
			instanceId: "ada-vps",
			name: "via credential",
			agentCredentialSecret: secret,
		});
		expect(id).toBe(profileB);
	});

	test("REFUSED: a member of org A presenting B's credential cannot write, and B's row is untouched", async () => {
		const { t, adaB, profileB } = await twoOrgs();
		const secret = await mint(t, "org-b", adaB);
		const code = await codeOf(
			memberOf(t, "org-a").mutation(api.profiles.upsertProfile, {
				orchestratorId: "ada",
				name: "hijack",
				agentCredentialSecret: secret,
			}),
		);
		expect(code).toMatch(/^ORG_MISMATCH/);
		const rowB = await t.run((ctx) => ctx.db.get(profileB));
		expect(rowB?.name).toBe("Ada of B");
	});

	test("REFUSED: a member with no agent proof cannot write (profiles stay master-only without one)", async () => {
		const { t, profileB } = await twoOrgs();
		const code = await codeOf(
			memberOf(t, "org-b").mutation(api.profiles.upsertProfile, {
				orchestratorId: "ada",
				name: "no proof",
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
		const rowB = await t.run((ctx) => ctx.db.get(profileB));
		expect(rowB?.name).toBe("Ada of B");
	});

	test("REFUSED: verifiedActor from a non-service caller is refused, not ignored", async () => {
		const { t, adaA, profileA } = await twoOrgs();
		const code = await codeOf(
			memberOf(t, "org-b").mutation(api.profiles.upsertProfile, {
				orchestratorId: "ada",
				name: "forged",
				verifiedActor: actorOf(adaA, "org-a"),
			}),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
		const rowA = await t.run((ctx) => ctx.db.get(profileA));
		expect(rowA?.name).toBe("Ada of A");
	});

	test("the orchestratorId argument selects nothing: an agent naming another label writes ITS row, under its own label", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const adaA = await registerAgent(t, "org-a", "ada");
		const adaB = await registerAgent(t, "org-b", "ada");
		const profileA = await insertProfile(t, {
			orchestratorId: "pi",
			name: "Pi of A",
			agentId: adaA,
		});
		const id = await asServiceAccount(t).mutation(api.profiles.upsertProfile, {
			orchestratorId: "pi",
			name: "not mine",
			verifiedActor: actorOf(adaB, "org-b"),
		});
		expect(id).not.toBe(profileA);
		const created = await t.run((ctx) => ctx.db.get(id));
		expect(created?.agentId).toBe(adaB);
		expect(created?.orchestratorId).toBe("ada");
		expect((await t.run((ctx) => ctx.db.get(profileA)))?.name).toBe("Pi of A");
	});

	test("REFUSED: two proofs on one call are refused", async () => {
		const { t, adaB } = await twoOrgs();
		const secret = await mint(t, "org-b", adaB);
		const code = await codeOf(
			asServiceAccount(t).mutation(api.profiles.upsertProfile, {
				orchestratorId: "ada",
				verifiedActor: actorOf(adaB, "org-b"),
				agentCredentialSecret: secret,
			}),
		);
		expect(code).toMatch(/^AGENT_PROOF_CONFLICT/);
	});

	test("REFUSED: an anonymous caller is refused", async () => {
		const { t } = await twoOrgs();
		const code = await codeOf(
			t.mutation(api.profiles.upsertProfile, { orchestratorId: "ada" }),
		);
		expect(code).toMatch(/^RBAC_DENIED/);
	});

	test("updateDynamic PRESENT: agent B updates only its own row", async () => {
		const { t, adaB, profileA, profileB } = await twoOrgs();
		await asServiceAccount(t).mutation(api.profiles.updateDynamic, {
			orchestratorId: "ada",
			instanceId: "ada-vps",
			currentTask: "B work",
			verifiedActor: actorOf(adaB, "org-b"),
		});
		const rowB = await t.run((ctx) => ctx.db.get(profileB));
		expect(rowB?.dynamic.currentTask).toBe("B work");
		const rowA = await t.run((ctx) => ctx.db.get(profileA));
		expect(rowA?.dynamic.currentTask).toBe("A secret");
	});

	test("updateDynamic ABSENT: agent B with no row auto-creates its own, stamped with B's ID; A's row is untouched", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const adaA = await registerAgent(t, "org-a", "ada");
		const adaB = await registerAgent(t, "org-b", "ada");
		const profileA = await insertProfile(t, {
			orchestratorId: "ada",
			name: "Ada of A",
			agentId: adaA,
			currentTask: "A secret",
		});
		await asServiceAccount(t).mutation(api.profiles.updateDynamic, {
			orchestratorId: "ada",
			currentTask: "B work",
			verifiedActor: actorOf(adaB, "org-b"),
		});
		const rows = await t.run((ctx) => ctx.db.query("profiles").collect());
		expect(rows).toHaveLength(2);
		const created = rows.find((r) => r.agentId === adaB);
		expect(created?.dynamic.currentTask).toBe("B work");
		const rowA = await t.run((ctx) => ctx.db.get(profileA));
		expect(rowA?.dynamic.currentTask).toBe("A secret");
	});

	test("updateDynamic REFUSED: a member with no proof", async () => {
		const { t, profileB } = await twoOrgs();
		expect(
			await codeOf(
				memberOf(t, "org-b").mutation(api.profiles.updateDynamic, {
					orchestratorId: "ada",
					currentTask: "no proof",
				}),
			),
		).toMatch(/^RBAC_DENIED/);
		const rowB = await t.run((ctx) => ctx.db.get(profileB));
		expect(rowB?.dynamic.currentTask).toBeUndefined();
	});
});

describe("M10d 5. the fleet service account keeps its existing grants", () => {
	test("PRESENT: a fleet write with no acting agent works as before and stamps the operator org's agent of that label", async () => {
		const t = createT();
		await seedOrg(t, "fleet-org", { operator: true, roster: ["sigma"] });
		const sigma = await registerAgent(t, "fleet-org", "sigma");
		const id = await asServiceAccount(t).mutation(api.profiles.upsertProfile, {
			orchestratorId: "sigma",
			name: "Sigma",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.agentId).toBe(sigma);
		await asServiceAccount(t).mutation(api.profiles.updateDynamic, {
			orchestratorId: "sigma",
			currentTask: "fleet work",
		});
		const after = await t.run((ctx) => ctx.db.get(id));
		expect(after?.dynamic.currentTask).toBe("fleet work");
	});

	test("ABSENT: a fleet label naming no operator-org agent is written unstamped, never guessed", async () => {
		const t = createT();
		await seedOrg(t, "fleet-org", { operator: true, roster: ["sigma"] });
		const id = await asServiceAccount(t).mutation(api.profiles.upsertProfile, {
			orchestratorId: "nobody",
			name: "Nobody",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.agentId).toBeUndefined();
	});
});

describe("M10d 6. backfill_profile_agent_ids (step 1)", () => {
	const run = internal.migrations.backfill_profile_agent_ids.run;

	async function legacyFleet() {
		const t = createT();
		await seedOrg(t, "fleet-org", { operator: true, roster: ["sigma"] });
		await seedOrg(t, "org-a", { roster: ["ada", "sigma"] });
		const sigma = await registerAgent(t, "fleet-org", "sigma");
		await registerAgent(t, "org-a", "ghostly");
		const fleetRow = await insertProfile(t, {
			orchestratorId: "sigma",
			name: "Sigma",
		});
		const unknownRow = await insertProfile(t, {
			orchestratorId: "nobody",
			name: "Nobody",
		});
		return { t, sigma, fleetRow, unknownRow };
	}

	test("dry run by default: inventory first, nothing written", async () => {
		const { t, fleetRow, unknownRow } = await legacyFleet();
		const r = await t.mutation(run, {});
		expect(r.dryRun).toBe(true);
		expect(r.preState).toEqual({ with: 0, without: 2 });
		expect(r.toFill).toBe(1);
		expect(r.filled).toBe(0);
		expect(r.blocked.map((b) => [b.profileId, b.reason])).toEqual([
			[unknownRow, "unknownAgent"],
		]);
		const row = await t.run((ctx) => ctx.db.get(fleetRow));
		expect(row?.agentId).toBeUndefined();
	});

	test("write: fills the resolvable row, leaves the unknown one unset and listed, and a second run changes nothing", async () => {
		const { t, sigma, fleetRow, unknownRow } = await legacyFleet();
		const r = await t.mutation(run, { dryRun: false });
		expect(r.filled).toBe(1);
		expect(r.blocked).toHaveLength(1);
		expect((await t.run((ctx) => ctx.db.get(fleetRow)))?.agentId).toBe(sigma);
		expect((await t.run((ctx) => ctx.db.get(unknownRow)))?.agentId).toBeUndefined();
		const again = await t.mutation(run, { dryRun: false });
		expect(again.preState).toEqual({ with: 1, without: 1 });
		expect(again.filled).toBe(0);
	});

	test("an ambiguous label is blocked, never guessed", async () => {
		const t = createT();
		await seedOrg(t, "fleet-org", { operator: true, roster: ["sigma"] });
		await t.run(async (ctx) => {
			for (const name of ["Sigma", "sigma"]) {
				await ctx.db.insert("agents", {
					orgSlug: "fleet-org",
					clerkOrgId: testClerkOrgId("fleet-org"),
					name,
					normalizedName: "sigma",
					isActive: true,
					createdAt: 1,
				});
			}
		});
		const row = await insertProfile(t, { orchestratorId: "sigma", name: "S" });
		const r = await t.mutation(run, { dryRun: false });
		expect(r.blocked.map((b) => b.reason)).toEqual(["ambiguousAgent"]);
		expect((await t.run((ctx) => ctx.db.get(row)))?.agentId).toBeUndefined();
	});

	test("a backfilled row is then served to the fleet agent that owns it, and to no other org", async () => {
		const { t, sigma, fleetRow } = await legacyFleet();
		await t.mutation(run, { dryRun: false });
		const served = await asServiceAccount(t).query(api.profiles.getProfile, {
			orchestratorId: "sigma",
			verifiedActor: actorOf(sigma, "fleet-org"),
		});
		expect(served?._id).toBe(fleetRow);
		await registerAgent(t, "org-a", "sigma");
		const other = await memberOf(t, "org-a").query(api.profiles.getProfile, {
			orchestratorId: "sigma",
		});
		expect(other).toBeNull();
	});
});
