/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// routingPerOrg.test.ts — mission k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S1
// (task k1707fkmyaavn0v0fkdjg2mhs58jx8dr).
//
// Routing rows carry owner + reviewer per (org, repository); an absent repository
// is an EXPLICIT state, never a fallback to the fleet default. Poles:
//   getRoute            ADMIT same-org seat / DENY other-org seat (typed absence,
//                       no content) / REFUSED anonymous (RBAC_DENIED)
//   adoption            an ADOPTED org never reaches the fleet default; a
//                       NON-adopted org keeps today's behaviour
//   add                 an adopted org's mapping needs a reviewer
//   migration           dry-run lists the unstamped fleet rows, apply stamps them,
//                       a second apply is a no-op, revert restores them
// Every pole runs as a scoped SEAT identity (org claim + agent credential), never
// the master / service identity, except the migration (an internal, operator door).
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { actingWith, seedOrgAgents } from "../../tests/lib/seedFleetAgents";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

const ORCH = "eta";
const FLEET_REVIEWER = "fleetrev";
const secrets = new Map<string, string>();

const asOrg = (t: T, slug: string) => {
	const member = t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<T["withIdentity"]>[0]);
	const secret = secrets.get(`${slug}/${ORCH}`);
	return secret === undefined ? member : actingWith(member, secret);
};

// org-op: the operator org. org-a: ADOPTED. org-b: NOT adopted.
async function seed(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "reviewerDefault",
			value: [FLEET_REVIEWER],
			updatedAt: 0,
		});
		for (const slug of ["org-op", "org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [ORCH, "rev", "rev2"],
				scopes: ["view-own-tasks", "manage-repo-mappings"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
				...(slug === "org-op" ? { orgKind: "operator" as const } : {}),
			});
		}
		// org-a ADOPTED: listed by permanent id in the config key, never in `scopes`.
		await ctx.db.insert("taskClosureConfig", {
			key: "reviewRoutingAdoptedOrgs",
			value: [`id:${testClerkOrgId("org-a")}`],
			updatedAt: 0,
		});
		for (const [i, slug] of ["org-a", "org-b"].entries()) {
			await ctx.db.insert("githubOwnerBindings", {
				owner: slug,
				orgId: slug,
				installationId: i + 1,
				accountType: "Organization",
				githubUserLogin: `gh-${slug}`,
				boundBy: `admin-${slug}`,
				boundAt: 1,
				active: true,
			});
		}
		const stamp = (slug: string) => ({ orgId: slug, clerkOrgId: testClerkOrgId(slug) });
		const rows: Array<Record<string, unknown>> = [
			{ repo: "org-a/routed", orchestrator: ORCH, reviewer: "rev", fallbackReviewer: "rev2", ...stamp("org-a") },
			{ repo: "org-a/unreviewed", orchestrator: ORCH, ...stamp("org-a") },
			{ repo: "org-b/routed", orchestrator: ORCH, reviewer: "rev", ...stamp("org-b") },
			{ repo: "org-b/unreviewed", orchestrator: ORCH, ...stamp("org-b") },
			{ repo: "fleet/one", orchestrator: ORCH },
			{ repo: "fleet/two", orchestrator: ORCH },
		];
		for (const r of rows) {
			await ctx.db.insert("githubRepoMapping", {
				project: "p",
				active: true,
				...r,
			} as never);
		}
	});
	secrets.clear();
	for (const [k, val] of await seedOrgAgents(t, [
		["org-op", ORCH],
		["org-a", ORCH],
		["org-b", ORCH],
	])) {
		secrets.set(k, val);
	}
}

const reviewerOf = (t: T, repo: string) => t.query(internal.reviewRouting.resolveForRepo, { repo });
const mappingOf = (t: T, repo: string) =>
	t.run(async (ctx) =>
		ctx.db.query("githubRepoMapping").withIndex("by_repo", (q) => q.eq("repo", repo)).unique(),
	);

describe("an ADOPTED org never reaches the fleet default; a non-adopted org keeps it", () => {
	test("ADOPTED: an unmapped repo of the org is REVIEWER_UNRESOLVED, not the fleet default", async () => {
		const t = makeT();
		await seed(t);
		expect(await reviewerOf(t, "org-a/never-mapped")).toBeNull();
	});

	test("ADOPTED: a mapped repo with no reviewer is REVIEWER_UNRESOLVED, not the fleet default", async () => {
		const t = makeT();
		await seed(t);
		expect(await reviewerOf(t, "org-a/unreviewed")).toBeNull();
	});

	test("ADOPTED: a mapped repo with its own reviewer resolves to that reviewer", async () => {
		const t = makeT();
		await seed(t);
		expect(await reviewerOf(t, "org-a/routed")).toBe("rev");
	});

	test("ADOPTED: the approvers of a repo are the row's own, never the fleet default", async () => {
		const t = makeT();
		await seed(t);
		expect((await t.query(internal.reviewRouting.acceptedForRepo, { repo: "org-a/routed" })).sort()).toEqual([
			"rev",
			"rev2",
		]);
		expect(await t.query(internal.reviewRouting.acceptedForRepo, { repo: "org-a/unreviewed" })).toEqual([]);
	});

	test("NOT ADOPTED: today's behaviour is unchanged (fleet default for an unmapped repo and a row with no reviewer)", async () => {
		const t = makeT();
		await seed(t);
		expect(await reviewerOf(t, "org-b/never-mapped")).toBe(FLEET_REVIEWER);
		expect(await reviewerOf(t, "org-b/unreviewed")).toBe(FLEET_REVIEWER);
		expect(await reviewerOf(t, "org-b/routed")).toBe("rev");
		expect(await reviewerOf(t, "no-org/at-all")).toBe(FLEET_REVIEWER);
	});

	test("ADOPTED operator org: an unstamped fleet row is judged as the operator org's", async () => {
		const t = makeT();
		await seed(t);
		await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-op",
			adopted: true,
		});
		expect(await reviewerOf(t, "fleet/one")).toBeNull();
	});

	test("the adoption flag is data: set, idempotent, cleared", async () => {
		const t = makeT();
		await seed(t);
		const set = await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-b",
			adopted: true,
		});
		expect(set.changed).toBe(true);
		expect(set.previous).toEqual([`id:${testClerkOrgId("org-a")}`]);
		expect(set.current).toEqual([`id:${testClerkOrgId("org-a")}`, `id:${testClerkOrgId("org-b")}`]);
		expect(await reviewerOf(t, "org-b/unreviewed")).toBeNull();
		const again = await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-b",
			adopted: true,
		});
		expect(again.changed).toBe(false);
		await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-b",
			adopted: false,
		});
		expect(await reviewerOf(t, "org-b/unreviewed")).toBe(FLEET_REVIEWER);
		// removal leaves org-a's entry alone
		expect(await reviewerOf(t, "org-a/unreviewed")).toBeNull();
	});

	test("a mapping row with no permanent id is listed by slug, and removal is idempotent", async () => {
		const t = makeT();
		await seed(t);
		await t.run(async (ctx) => {
			const b = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-b"))
				.unique();
			if (b) await ctx.db.patch(b._id, { clerkOrgId: undefined });
		});
		const set = await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-b",
			adopted: true,
		});
		expect(set.current).toContain("slug:org-b");
		const off = await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-b",
			adopted: false,
		});
		expect(off.changed).toBe(true);
		const offAgain = await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-b",
			adopted: false,
		});
		expect(offAgain.changed).toBe(false);
	});

	test("adopt by slug, then the mapping gains an id: still adopted (no fleet default reopens)", async () => {
		const t = makeT();
		await seed(t);
		await t.run(async (ctx) => {
			const b = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-b"))
				.unique();
			if (b) await ctx.db.patch(b._id, { clerkOrgId: undefined });
		});
		await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-b",
			adopted: true,
		});
		expect(await reviewerOf(t, "org-b/never-mapped")).toBeNull();
		await t.mutation(internal.clientOrgMapping.setClerkOrgId, {
			clerkOrgSlug: "org-b",
			clerkOrgId: testClerkOrgId("org-b"),
		});
		expect(await reviewerOf(t, "org-b/never-mapped")).toBeNull();
		expect(await reviewerOf(t, "org-b/unreviewed")).toBeNull();
		expect(await t.query(internal.reviewRouting.acceptedForRepo, { repo: "org-b/routed" })).toEqual(["rev"]);
		// the list now names the org by its permanent id, and removal still clears it
		const list = await t.run(async (ctx) =>
			ctx.db.query("taskClosureConfig").withIndex("by_key", (q) => q.eq("key", "reviewRoutingAdoptedOrgs")).unique(),
		);
		expect(list?.value).toContain(`id:${testClerkOrgId("org-b")}`);
		expect(list?.value).not.toContain("slug:org-b");
		await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-b",
			adopted: false,
		});
		expect(await reviewerOf(t, "org-b/never-mapped")).toBe(FLEET_REVIEWER);
	});

	test("READER: a stale `slug:` entry is still honoured once the row has an id", async () => {
		const t = makeT();
		await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "reviewRoutingAdoptedOrgs",
				value: ["slug:org-b"],
				updatedAt: 0,
			});
		});
		expect(await reviewerOf(t, "org-b/never-mapped")).toBeNull();
		expect(await t.query(internal.reviewRouting.acceptedForRepo, { repo: "org-b/unreviewed" })).toEqual([]);
	});

	test("the flag is NOT in the org's authority: no scopes entry carries it, before or after adoption", async () => {
		const t = makeT();
		await seed(t);
		const svc = t.withIdentity({ subject: "test-service-account-user-id" });
		await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "org-b",
			adopted: true,
		});
		for (const slug of ["org-a", "org-b"]) {
			// the grant projection every token / Clerk-JWT context copies its scopes from
			const grant = await svc.query(api.clientOrgMapping.getByClerkSlug, { orgSlug: slug });
			expect(grant?.scopes).toEqual(["view-own-tasks", "manage-repo-mappings"]);
			const byId = await svc.query(api.clientOrgMapping.getByClerkOrgId, {
				clerkOrgId: testClerkOrgId(slug),
			});
			expect(byId?.scopes).toEqual(["view-own-tasks", "manage-repo-mappings"]);
			const row = await t.run(async (ctx) =>
				ctx.db
					.query("client_org_mapping")
					.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
					.unique(),
			);
			expect(row?.scopes).toEqual(["view-own-tasks", "manage-repo-mappings"]);
		}
	});
});

describe("githubRepoMapping:getRoute", () => {
	test("ADMIT: a same-org seat reads owner, reviewer and fallback", async () => {
		const t = makeT();
		await seed(t);
		expect(await asOrg(t, "org-a").query(api.githubRepoMapping.getRoute, { repo: "org-a/routed" })).toEqual({
			state: "routed",
			owner: ORCH,
			reviewer: "rev",
			fallbackReviewer: "rev2",
		});
	});

	test("ADMIT: a row with no reviewer is `unreviewed` and names its owner", async () => {
		const t = makeT();
		await seed(t);
		expect(await asOrg(t, "org-a").query(api.githubRepoMapping.getRoute, { repo: "org-a/unreviewed" })).toEqual({
			state: "unreviewed",
			owner: ORCH,
		});
	});

	test("ABSENT: a repo the org has no row for is a typed absence", async () => {
		const t = makeT();
		await seed(t);
		expect(await asOrg(t, "org-a").query(api.githubRepoMapping.getRoute, { repo: "org-a/none" })).toEqual({
			state: "absent",
		});
	});

	test("DENY: another org's seat gets an absence that carries none of the row's content", async () => {
		const t = makeT();
		await seed(t);
		const b = asOrg(t, "org-b");
		for (const repo of ["org-a/routed", "org-a/unreviewed", "fleet/one"]) {
			expect(await b.query(api.githubRepoMapping.getRoute, { repo })).toEqual({ state: "absent" });
		}
	});

	test("REFUSED: a caller with no credential is raised at, naming the door", async () => {
		const t = makeT();
		await seed(t);
		const err = await t
			.query(api.githubRepoMapping.getRoute, { repo: "org-a/routed" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect(String((err as ConvexError<string>).data)).toContain("RBAC_DENIED");
		expect(String((err as ConvexError<string>).data)).toContain("githubRepoMapping:getRoute");
	});

	test("an org argument is not accepted: the org is the verified one", async () => {
		const t = makeT();
		await seed(t);
		const err = await asOrg(t, "org-b")
			.query(api.githubRepoMapping.getRoute, { repo: "org-a/routed", orgId: "org-a" } as never)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("githubRepoMapping:add for an adopted org requires a reviewer", () => {
	test("REFUSED: org-a adds a mapping with no reviewer", async () => {
		const t = makeT();
		await seed(t);
		const err = await asOrg(t, "org-a")
			.mutation(api.githubRepoMapping.add, { repo: "org-a/new", orchestrator: ORCH, project: "p" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect(String((err as ConvexError<string>).data)).toContain("REVIEWER_REQUIRED");
		expect(await mappingOf(t, "org-a/new")).toBeNull();
	});

	test("ADMIT: org-a adds a mapping with a reviewer", async () => {
		const t = makeT();
		await seed(t);
		await asOrg(t, "org-a").mutation(api.githubRepoMapping.add, {
			repo: "org-a/new",
			orchestrator: ORCH,
			project: "p",
			reviewer: "rev",
		});
		expect((await mappingOf(t, "org-a/new"))?.reviewer).toBe("rev");
	});

	test("REFUSED: org-a re-adds an existing row that has no reviewer, still naming none", async () => {
		const t = makeT();
		await seed(t);
		const err = await asOrg(t, "org-a")
			.mutation(api.githubRepoMapping.add, { repo: "org-a/unreviewed", orchestrator: ORCH, project: "p" })
			.catch((e: unknown) => e);
		expect(String((err as ConvexError<string>).data)).toContain("REVIEWER_REQUIRED");
	});

	test("ADMIT: org-a updates a row that already has a reviewer without restating it", async () => {
		const t = makeT();
		await seed(t);
		await asOrg(t, "org-a").mutation(api.githubRepoMapping.add, {
			repo: "org-a/routed",
			orchestrator: ORCH,
			project: "renamed",
		});
		const row = await mappingOf(t, "org-a/routed");
		expect(row?.project).toBe("renamed");
		expect(row?.reviewer).toBe("rev");
	});

	test("NOT ADOPTED: org-b adds a mapping with no reviewer, as today", async () => {
		const t = makeT();
		await seed(t);
		await asOrg(t, "org-b").mutation(api.githubRepoMapping.add, {
			repo: "org-b/new",
			orchestrator: ORCH,
			project: "p",
		});
		expect((await mappingOf(t, "org-b/new"))?.reviewer).toBeUndefined();
	});
});

describe("migration: stamp the fleet's unstamped routing rows with the operator org", () => {
	const run = (t: T, args: { apply?: boolean } = {}) =>
		t.mutation(internal.migrations.stampFleetRepoMappings.run, args);

	test("DRY RUN (default): lists the unstamped rows and writes nothing", async () => {
		const t = makeT();
		await seed(t);
		const r = await run(t);
		expect(r.mode).toBe("dry-run");
		expect(r.operatorOrgId).toBe("org-op");
		expect(r.unstamped).toBe(2);
		expect(r.sample.sort()).toEqual(["fleet/one", "fleet/two"]);
		expect(r.stampedIds).toEqual([]);
		expect((await mappingOf(t, "fleet/one"))?.orgId).toBeUndefined();
	});

	test("APPLY stamps orgId and clerkOrgId of the operator org; a second apply is a no-op", async () => {
		const t = makeT();
		await seed(t);
		const first = await run(t, { apply: true });
		expect(first.mode).toBe("applied");
		expect(first.stampedIds).toHaveLength(2);
		const row = await mappingOf(t, "fleet/one");
		expect(row?.orgId).toBe("org-op");
		expect(row?.clerkOrgId).toBe(testClerkOrgId("org-op"));
		const second = await run(t, { apply: true });
		expect(second.unstamped).toBe(0);
		expect(second.stampedIds).toEqual([]);
		// another org's row is never touched
		expect((await mappingOf(t, "org-a/routed"))?.orgId).toBe("org-a");
	});

	test("an operator seat reads its stamped fleet row through getRoute; before the stamp it is absent", async () => {
		const t = makeT();
		await seed(t);
		const op = asOrg(t, "org-op");
		expect(await op.query(api.githubRepoMapping.getRoute, { repo: "fleet/one" })).toEqual({ state: "absent" });
		await run(t, { apply: true });
		expect(await op.query(api.githubRepoMapping.getRoute, { repo: "fleet/one" })).toEqual({
			state: "unreviewed",
			owner: ORCH,
		});
	});

	test("REVERT unstamps exactly the rows the apply recorded", async () => {
		const t = makeT();
		await seed(t);
		const applied = await run(t, { apply: true });
		const reverted = await t.mutation(internal.migrations.stampFleetRepoMappings.revert, {
			ids: applied.stampedIds,
		});
		expect(reverted.reverted).toBe(2);
		expect((await mappingOf(t, "fleet/one"))?.orgId).toBeUndefined();
		expect((await mappingOf(t, "fleet/one"))?.clerkOrgId).toBeUndefined();
		expect((await mappingOf(t, "org-a/routed"))?.orgId).toBe("org-a");
	});

	test("REFUSED: no single operator org means nothing is stamped", async () => {
		const t = makeT();
		await seed(t);
		await t.run(async (ctx) => {
			const op = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-op"))
				.unique();
			if (op) await ctx.db.patch(op._id, { isActive: false });
		});
		const err = await run(t, { apply: true }).catch((e: unknown) => e);
		expect(String((err as ConvexError<string>).data)).toContain("OPERATOR_ORG_NOT_FOUND");
		expect((await mappingOf(t, "fleet/one"))?.orgId).toBeUndefined();
	});
});
