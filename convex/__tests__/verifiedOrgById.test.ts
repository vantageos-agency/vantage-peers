/// <reference types="vite/client" />
/**
 * Identity by ID, module M18 (task k170dkz2nye4es0fpszqcjvhe18g3jw5).
 *
 * Three residues, each keyed by a permanent ID instead of a label:
 *
 *  1. `verifiedOrg` (convex/lib/verifiedOrg.ts). The transport's org claim named
 *     the organisation by SLUG. A slug is renamable display text: an org that was
 *     renamed lost access (its old slug names nothing), and a slug another org
 *     took over reached the FORMER holder's rows (the row narrowing compared the
 *     slug stamp on the row). The claim now carries the org's permanent Clerk ID
 *     (`orgId`); Convex resolves the mapping by that ID and narrows rows by it.
 *     The slug-only form is still accepted (expand): the old MCP sends it.
 *  2. `fixPatterns:get`'s roster check matched the pattern's creator NAME against
 *     the bearer's roster of names: a client org's "eta" read the operator's
 *     "eta" patterns. The verified agent's ID is compared with the creator's ID.
 *  3. `callerActorOf` case 3 named the caller by an asserted label inside the org
 *     resolved from a SLUG. The org's permanent ID now selects the agents.
 *
 * Every pole runs under a SCOPED identity where the door admits one, and under
 * the fleet service account (the MCP transport) where the claim is believed;
 * never as a master reaching around the claim.
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import type { OrgScope } from "../lib/auth";
import { callerActorOf } from "../lib/taskActors";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

// Org A was called "acme"; it was RENAMED to "acme-new". Org B then took "acme".
const ORG_A_ID = "org_AAAA1111";
const ORG_B_ID = "org_BBBB2222";

async function seedRenamedAndReused(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: Date.now(),
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "acme-new", // A, after the rename
			clerkOrgId: ORG_A_ID,
			allowedOrchestrators: ["eta"],
			scopes: ["view-own-tasks"],
			displayName: "A",
			isActive: true,
			createdAt: Date.now(),
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "acme", // B, which took the freed slug
			clerkOrgId: ORG_B_ID,
			allowedOrchestrators: ["eta"],
			scopes: ["view-own-tasks"],
			displayName: "B",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedTasks(t: T, orgClerkId: string, n: number) {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (let i = 0; i < n; i++) {
			// Both orgs' rows still carry the OLD slug stamp "acme": A's were written
			// before the rename, B's after it. Only the permanent ID tells them apart.
			await ctx.db.insert("tasks", {
				title: `${orgClerkId} ${i}`,
				assignedTo: "someone",
				createdBy: "someone",
				priority: "low",
				status: "todo",
				orgId: "acme",
				clerkOrgId: orgClerkId,
				createdAt: now,
				updatedAt: now,
			} as never);
		}
	});
}

const rowsOf = async (t: T, ids: readonly Id<"tasks">[]) =>
	await t.run(async (ctx) => await Promise.all(ids.map((id) => ctx.db.get(id))));

describe("verifiedOrg keyed by the permanent org ID (bulkComplete preview)", () => {
	test("reused slug: the slug-only claim of the slug's CURRENT holder reaches its rows and NOT the former holder's", async () => {
		const t = createT();
		await seedRenamedAndReused(t);
		await seedTasks(t, ORG_A_ID, 3);
		await seedTasks(t, ORG_B_ID, 2);

		// The old MCP's wire: slug only. "acme" is B's now, A's rows carry the same stamp.
		const preview = await asService(t).mutation(api.tasks.bulkComplete, {
			filter: { status: "todo" },
			verifiedOrg: { orgSlug: "acme" },
		});
		expect(preview.count).toBe(2);
		const rows = await rowsOf(t, preview.sampleIds as Id<"tasks">[]);
		expect(rows.every((r) => r?.clerkOrgId === ORG_B_ID)).toBe(true);
	});

	test("renamed org keeps access: the ID claim reaches ITS rows although the slug in the claim is stale", async () => {
		const t = createT();
		await seedRenamedAndReused(t);
		await seedTasks(t, ORG_A_ID, 3);
		await seedTasks(t, ORG_B_ID, 2);

		// A's token still snapshots the slug it had at mint ("acme"), which is B's now.
		const preview = await asService(t).mutation(api.tasks.bulkComplete, {
			filter: { status: "todo" },
			verifiedOrg: { orgSlug: "acme", orgId: ORG_A_ID },
		});
		expect(preview.count).toBe(3);
		const rows = await rowsOf(t, preview.sampleIds as Id<"tasks">[]);
		expect(rows.every((r) => r?.clerkOrgId === ORG_A_ID)).toBe(true);
	});

	test("a claim whose ID names no active organisation is REFUSED, never resolved through its slug", async () => {
		const t = createT();
		await seedRenamedAndReused(t);
		await seedTasks(t, ORG_B_ID, 2);

		await expect(
			asService(t).mutation(api.tasks.bulkComplete, {
				filter: { status: "todo" },
				// The slug names a live org (B); the ID names nobody.
				verifiedOrg: { orgSlug: "acme", orgId: "org_UNKNOWN9999" },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an inactive organisation's ID is REFUSED", async () => {
		const t = createT();
		await seedRenamedAndReused(t);
		await t.run(async (ctx) => {
			const a = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", ORG_A_ID))
				.unique();
			if (a !== null) await ctx.db.patch(a._id, { isActive: false });
		});
		await expect(
			asService(t).mutation(api.tasks.bulkComplete, {
				filter: { status: "todo" },
				verifiedOrg: { orgSlug: "acme-new", orgId: ORG_A_ID },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("INACTIVE org by orgId is REFUSED on a scoped read (member-scope door), the active one is served", async () => {
		const t = createT();
		await seedRenamedAndReused(t);
		const read = (orgId: string, orgSlug: string) =>
			asService(t).query(api.businessUnits.list, {
				verifiedOrg: { orgSlug, orgId },
			});
		const served = await read(ORG_A_ID, "acme-new");
		expect(Array.isArray(served.items)).toBe(true);
		await t.run(async (ctx) => {
			const a = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", ORG_A_ID))
				.unique();
			if (a !== null) await ctx.db.patch(a._id, { isActive: false });
		});
		await expect(read(ORG_A_ID, "acme-new")).rejects.toThrow(/RBAC_DENIED/);
		// its stale slug now held by nobody active does not rescue it
		await expect(read(ORG_A_ID, "acme")).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an ordinary member naming an org by ID is still refused (the claim is the service account's only)", async () => {
		const t = createT();
		await seedRenamedAndReused(t);
		const member = t.withIdentity({
			subject: "member-of-b",
			org_slug: "acme",
			org_id: ORG_B_ID,
			org_role: "org:member",
		} as Identity);
		await expect(
			member.mutation(api.tasks.bulkComplete, {
				filter: { status: "todo" },
				verifiedOrg: { orgSlug: "acme", orgId: ORG_A_ID },
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("callerActorOf case 3 resolves the asserted label in the org by its permanent ID", () => {
	async function seedEtaInBothOrgs(t: T) {
		await seedRenamedAndReused(t);
		return await t.run(async (ctx) => {
			const a = await ctx.db.insert("agents", {
				orgSlug: "acme", // A's agents still carry the stamp of the slug A had
				clerkOrgId: ORG_A_ID,
				name: "eta",
				normalizedName: "eta",
				isActive: true,
				createdAt: 0,
			} as never);
			const b = await ctx.db.insert("agents", {
				orgSlug: "acme",
				clerkOrgId: ORG_B_ID,
				name: "eta",
				normalizedName: "eta",
				isActive: true,
				createdAt: 0,
			} as never);
			return { a, b };
		});
	}

	const masterScope = {
		isMaster: true,
		orgSlug: null,
	} as unknown as OrgScope;

	test("reused slug: the claim's ID selects A's eta, not the eta of whoever holds the slug now", async () => {
		const t = createT();
		const { a } = await seedEtaInBothOrgs(t);
		const actor = await t.run(
			async (ctx) =>
				await callerActorOf(ctx, masterScope, "eta", {
					verifiedOrgSlug: "acme",
					verifiedOrgId: ORG_A_ID,
				}),
		);
		expect(actor?.id).toBe(a);
	});

	test("renamed org: a stale slug that names nothing still resolves in the org the ID names", async () => {
		const t = createT();
		const { a } = await seedEtaInBothOrgs(t);
		const actor = await t.run(
			async (ctx) =>
				await callerActorOf(ctx, masterScope, "eta", {
					verifiedOrgSlug: "acme-gone",
					verifiedOrgId: ORG_A_ID,
				}),
		);
		expect(actor?.id).toBe(a);
	});

	test("legacy proof (slug only) still resolves in the slug's current holder: expand keeps the old MCP working", async () => {
		const t = createT();
		const { b } = await seedEtaInBothOrgs(t);
		const actor = await t.run(
			async (ctx) =>
				await callerActorOf(ctx, masterScope, "eta", {
					verifiedOrgSlug: "acme",
				}),
		);
		expect(actor?.id).toBe(b);
	});
});

describe("fixPatterns:get roster check by agent ID", () => {
	async function seed(t: T) {
		await seedFleetAgents(t, ["eta"]);
		const ids = await t.run(async (ctx) => {
			const operator = (await ctx.db.query("client_org_mapping").collect()).find(
				(m) => m.orgKind === "operator",
			);
			if (operator === undefined) throw new Error("no operator org seeded");
			const fleetEta = await ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", operator.clerkOrgSlug))
				.first();
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "client-co",
				clerkOrgId: "org_CLIENT3333",
				allowedOrchestrators: ["eta"],
				scopes: ["view-own-tasks"],
				displayName: "client",
				isActive: true,
				createdAt: Date.now(),
			});
			// A client org's agent bearing the SAME label as the operator's.
			const clientEta = await ctx.db.insert("agents", {
				orgSlug: "client-co",
				clerkOrgId: "org_CLIENT3333",
				name: "eta",
				normalizedName: "eta",
				isActive: true,
				createdAt: 0,
			} as never);
			return {
				fleetEta: fleetEta?._id as Id<"agents">,
				fleetSlug: operator.clerkOrgSlug,
				clientEta,
			};
		});
		const patternId = await asService(t).mutation(api.fixPatterns.create, {
			symptom: "s",
			rootCause: "r",
			tags: ["x"],
			stack: ["convex"],
			sourceProject: "vantage-peers",
			createdBy: "eta",
			severity: "minor",
		});
		return { ...ids, patternId };
	}

	test("REFUSED: a client org's eta (same label as the operator's) is answered null, as an absent id", async () => {
		const t = createT();
		const s = await seed(t);
		const got = await asService(t).query(api.fixPatterns.get, {
			patternId: s.patternId,
			callerIdentities: ["eta"],
			verifiedActor: { agentId: s.clientEta, orgSlug: "client-co" },
		});
		expect(got).toBeNull();
	});

	test("PRESENT: the operator's own eta reads the pattern it created", async () => {
		const t = createT();
		const s = await seed(t);
		const got = await asService(t).query(api.fixPatterns.get, {
			patternId: s.patternId,
			callerIdentities: ["eta"],
			verifiedActor: { agentId: s.fleetEta, orgSlug: s.fleetSlug },
		});
		expect(got?._id).toBe(s.patternId);
	});

	test("ABSENT: an unknown pattern id is null for the operator's eta too", async () => {
		const t = createT();
		const s = await seed(t);
		const missing = await t.run(async (ctx) => {
			const id = await ctx.db.insert("fixPatterns", {
				symptom: "gone",
				rootCause: "gone",
				tags: [],
				stack: [],
				sourceProject: "p",
				createdBy: "eta",
				severity: "minor",
				createdAt: 0,
				updatedAt: 0,
			});
			await ctx.db.delete(id);
			return id;
		});
		const got = await asService(t).query(api.fixPatterns.get, {
			patternId: missing,
			verifiedActor: { agentId: s.fleetEta, orgSlug: s.fleetSlug },
		});
		expect(got).toBeNull();
	});

	test("legacy wire (names only, no verified actor) still narrows by the roster: expand keeps the old MCP working", async () => {
		const t = createT();
		const s = await seed(t);
		const named = await asService(t).query(api.fixPatterns.get, {
			patternId: s.patternId,
			callerIdentities: ["eta"],
		});
		expect(named?._id).toBe(s.patternId);
		const other = await asService(t).query(api.fixPatterns.get, {
			patternId: s.patternId,
			callerIdentities: ["somebody-else"],
		});
		expect(other).toBeNull();
	});
});
