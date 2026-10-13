/// <reference types="vite/client" />
/**
 * BATCH E, repo mappings and owner bindings: a bearer that is not the fleet
 * master acts for its VERIFIED organisation (`verifiedOrg`), never as the fleet.
 *
 * `githubRepoMapping:getByRepo / add / remove` and `githubOwnerBinding:listBindings`
 * resolve their caller through the organisation-scope resolver, where the fleet
 * service account is MASTER. Without a claim, a non-master bearer reaching Convex
 * as the service account would read every organisation's rows and write FLEET
 * rows. Each door now declares `verifiedOrg` (convex/lib/verifiedOrg.ts), believed
 * from the service account only, and then runs as that organisation's member.
 *
 * POLES (every one under an ordinary org member or the fleet service account)
 *   PRESENT      - the claim confines the read/write to the claimed org's rows;
 *                  a claimless service-account call is the fleet master, unchanged.
 *   REFUSED      - a claim presented by anything but the service account; a claim
 *                  naming no active org; an anonymous caller.
 *   ABSENT       - an org with no rows reads an empty success / null, never a refusal.
 *   CROSS-ORG    - org A's claim never reads, overwrites or deletes org B's row, or
 *                  the fleet's.
 * And `githubRepoMapping:list` pages by creation time: a deleted anchor row does
 * not empty the next page.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

// The first test of a file pays the cold start of the whole Convex module graph.
vi.setConfig({ testTimeout: 30_000 });

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const A = "org-a";
const B = "org-b";
const OP = "fleet-op";
// A client organisation that owns no binding and no mapping row.
const EMPTY = "org-empty";
const NOW = 1_700_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, org: string, role = "org:admin") =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Identity);
const claim = (org: string) => ({ verifiedOrg: { orgSlug: org } });

async function seedWorld(t: T) {
	await t.run(async (ctx) => {
		const mapping = (slug: string, scopes: string[], kind?: "operator") =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: slug === OP ? [] : ["alpha"],
				scopes,
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(kind ? { orgKind: kind } : {}),
			});
		// A holds the scope to manage repo mappings; B does not.
		await mapping(A, ["manage-repo-mappings"]);
		await mapping(B, []);
		await mapping(EMPTY, []);
		await mapping(OP, [], "operator");
		await seedRosterAgent(ctx, A, "alpha");
		await seedRosterAgent(ctx, B, "alpha");
		// GitHub-verified owner bindings: A owns "org-a/*", B owns "org-b/*".
		for (const [slug, installationId] of [
			[A, 1],
			[B, 2],
		] as const) {
			await ctx.db.insert("githubOwnerBindings", {
				owner: slug,
				orgId: slug,
				installationId,
				accountType: "Organization",
				githubUserLogin: `gh-${slug}`,
				boundBy: `admin-${slug}`,
				boundAt: 1,
				active: true,
			});
		}
		const row = (repo: string, org?: string) =>
			ctx.db.insert("githubRepoMapping", {
				repo,
				orchestrator: "alpha",
				project: repo.replace("/", "-"),
				active: true,
				...(org
					? { orgId: org, clerkOrgId: testClerkOrgId(org) }
					: {}),
			});
		await row("org-a/app", A);
		await row("org-b/app", B);
		await row("fleet/core");
	});
}

const rowOf = (t: T, repo: string) =>
	t.run((ctx) =>
		ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", repo))
			.unique(),
	);

describe("githubRepoMapping:getByRepo", () => {
	test("PRESENT: the claim reads the claimed org's row", async () => {
		const t = createT();
		await seedWorld(t);
		const row = await asService(t).query(api.githubRepoMapping.getByRepo, {
			repo: "org-a/app",
			...claim(A),
		});
		expect(row?.repo).toBe("org-a/app");
	});

	test("PRESENT: a claimless service account is the fleet master and reads any row", async () => {
		const t = createT();
		await seedWorld(t);
		const row = await asService(t).query(api.githubRepoMapping.getByRepo, {
			repo: "org-b/app",
		});
		expect(row?.repo).toBe("org-b/app");
	});

	test("CROSS-ORG: org A's claim never reads org B's row or the fleet's", async () => {
		const t = createT();
		await seedWorld(t);
		for (const repo of ["org-b/app", "fleet/core"]) {
			await expect(
				asService(t).query(api.githubRepoMapping.getByRepo, {
					repo,
					...claim(A),
				}),
			).rejects.toThrow(/RBAC_DENIED/);
		}
	});

	test("REFUSED: a claim presented by an org member is never believed", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asMember(t, A).query(api.githubRepoMapping.getByRepo, {
				repo: "org-b/app",
				...claim(B),
			}),
		).rejects.toThrow(/verified-org-not-trusted/);
	});

	test("REFUSED: a claim naming no active org", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asService(t).query(api.githubRepoMapping.getByRepo, {
				repo: "org-a/app",
				...claim("no-such-org"),
			}),
		).rejects.toThrow(/org-not-active/);
	});

	test("REFUSED: an anonymous caller is raised at, not served an absence", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			t.query(api.githubRepoMapping.getByRepo, { repo: "org-a/app" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("ABSENT: a repo with no row reads null under the claim", async () => {
		const t = createT();
		await seedWorld(t);
		const row = await asService(t).query(api.githubRepoMapping.getByRepo, {
			repo: "org-a/never-mapped",
			...claim(A),
		});
		expect(row).toBeNull();
	});
});

describe("githubRepoMapping:add", () => {
	const args = { repo: "org-a/new", orchestrator: "alpha", project: "new" };

	test("PRESENT: the claim writes a row owned by the claimed org, never a fleet row", async () => {
		const t = createT();
		await seedWorld(t);
		await asService(t).mutation(api.githubRepoMapping.add, {
			...args,
			...claim(A),
		});
		const row = await rowOf(t, "org-a/new");
		expect(row?.orgId).toBe(A);
		expect(row?.clerkOrgId).toBe(testClerkOrgId(A));
	});

	test("PRESENT: a claimless service account writes a FLEET row, unchanged", async () => {
		const t = createT();
		await seedWorld(t);
		await asService(t).mutation(api.githubRepoMapping.add, {
			repo: "fleet/new",
			orchestrator: "alpha",
			project: "new",
		});
		const row = await rowOf(t, "fleet/new");
		expect(row).not.toBeNull();
		expect(row?.orgId).toBeUndefined();
	});

	test("REFUSED: an org without the manage-repo-mappings scope writes nothing", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asService(t).mutation(api.githubRepoMapping.add, {
				repo: "org-b/new",
				orchestrator: "alpha",
				project: "new",
				...claim(B),
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await rowOf(t, "org-b/new")).toBeNull();
	});

	test("REFUSED: a claim presented by an org member is never believed", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asMember(t, A).mutation(api.githubRepoMapping.add, {
				...args,
				...claim(A),
			}),
		).rejects.toThrow(/verified-org-not-trusted/);
	});

	test("CROSS-ORG: org A's claim cannot overwrite org B's row or the fleet's", async () => {
		const t = createT();
		await seedWorld(t);
		const before = await rowOf(t, "org-b/app");
		for (const repo of ["org-b/app", "fleet/core"]) {
			await expect(
				asService(t).mutation(api.githubRepoMapping.add, {
					repo,
					orchestrator: "alpha",
					project: "hijacked",
					...claim(A),
				}),
			).rejects.toThrow(/RBAC_DENIED/);
		}
		expect(await rowOf(t, "org-b/app")).toEqual(before);
		expect((await rowOf(t, "fleet/core"))?.project).toBe("fleet-core");
	});

	test("REFUSED: an anonymous caller writes nothing", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			t.mutation(api.githubRepoMapping.add, args),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await rowOf(t, "org-a/new")).toBeNull();
	});
});

describe("githubRepoMapping:remove", () => {
	test("PRESENT: the claim deletes the claimed org's own row", async () => {
		const t = createT();
		await seedWorld(t);
		const out = await asService(t).mutation(api.githubRepoMapping.remove, {
			repo: "org-a/app",
			...claim(A),
		});
		expect(out).toEqual({ deleted: true });
		expect(await rowOf(t, "org-a/app")).toBeNull();
	});

	test("PRESENT: a claimless service account deletes a fleet row", async () => {
		const t = createT();
		await seedWorld(t);
		const out = await asService(t).mutation(api.githubRepoMapping.remove, {
			repo: "fleet/core",
		});
		expect(out).toEqual({ deleted: true });
	});

	test("CROSS-ORG: org A's claim cannot delete org B's row or the fleet's", async () => {
		const t = createT();
		await seedWorld(t);
		for (const repo of ["org-b/app", "fleet/core"]) {
			await expect(
				asService(t).mutation(api.githubRepoMapping.remove, {
					repo,
					...claim(A),
				}),
			).rejects.toThrow(/RBAC_DENIED/);
			expect(await rowOf(t, repo)).not.toBeNull();
		}
	});

	test("REFUSED: an org without the scope deletes nothing", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asService(t).mutation(api.githubRepoMapping.remove, {
				repo: "org-b/app",
				...claim(B),
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await rowOf(t, "org-b/app")).not.toBeNull();
	});

	test("ABSENT: a repo with no row is { deleted: false }, never a refusal", async () => {
		const t = createT();
		await seedWorld(t);
		const out = await asService(t).mutation(api.githubRepoMapping.remove, {
			repo: "org-a/never-mapped",
			...claim(A),
		});
		expect(out).toEqual({ deleted: false });
	});
});

describe("githubOwnerBinding:listBindings", () => {
	test("PRESENT: the claim lists the claimed org's bindings only", async () => {
		const t = createT();
		await seedWorld(t);
		const page = await asService(t).query(
			api.githubOwnerBinding.listBindings,
			claim(A),
		);
		expect(page.items.map((i) => i.owner)).toEqual([A]);
	});

	test("PRESENT: a claimless service account is the fleet master and lists every org's bindings", async () => {
		const t = createT();
		await seedWorld(t);
		const page = await asService(t).query(
			api.githubOwnerBinding.listBindings,
			{},
		);
		expect(page.items.map((i) => i.owner).sort()).toEqual([A, B]);
	});

	test("ABSENT: an org with no bindings reads an empty success", async () => {
		const t = createT();
		await seedWorld(t);
		const page = await asService(t).query(
			api.githubOwnerBinding.listBindings,
			claim(EMPTY),
		);
		expect(page.items).toEqual([]);
		expect(page.nextCursor).toBeNull();
	});

	test("REFUSED: a claim presented by an org member is never believed", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			asMember(t, A).query(api.githubOwnerBinding.listBindings, claim(B)),
		).rejects.toThrow(/verified-org-not-trusted/);
	});

	test("REFUSED: an anonymous caller is raised at", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			t.query(api.githubOwnerBinding.listBindings, {}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("githubRepoMapping:list pages by creation time", () => {
	test("a deleted anchor row does not empty the next page", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 1; i <= 5; i++) {
				await ctx.db.insert("githubRepoMapping", {
					repo: `fleet/r${i}`,
					orchestrator: "alpha",
					project: `p${i}`,
					active: true,
				});
			}
		});
		const first = await asService(t).query(api.githubRepoMapping.list, {
			limit: 2,
			fields: "lite",
		});
		expect(first.items.map((i) => i.repo)).toEqual(["fleet/r5", "fleet/r4"]);
		expect(first.nextCursor).not.toBeNull();
		// The anchor (the last row served) is deleted between the two reads.
		await t.run(async (ctx) => {
			const anchor = await ctx.db
				.query("githubRepoMapping")
				.withIndex("by_repo", (q) => q.eq("repo", "fleet/r4"))
				.unique();
			if (anchor) await ctx.db.delete(anchor._id);
		});
		const second = await asService(t).query(api.githubRepoMapping.list, {
			limit: 2,
			fields: "lite",
			cursor: first.nextCursor ?? undefined,
		});
		expect(second.items.map((i) => i.repo)).toEqual(["fleet/r3", "fleet/r2"]);
	});

	test("PRESENT: paging to the end serves every row exactly once", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 1; i <= 5; i++) {
				await ctx.db.insert("githubRepoMapping", {
					repo: `fleet/r${i}`,
					orchestrator: "alpha",
					project: `p${i}`,
					active: true,
				});
			}
		});
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let pages = 0; pages < 6; pages++) {
			const page = await asService(t).query(api.githubRepoMapping.list, {
				limit: 2,
				fields: "lite",
				cursor,
			});
			seen.push(...page.items.map((i) => i.repo));
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}
		expect(seen).toEqual([
			"fleet/r5",
			"fleet/r4",
			"fleet/r3",
			"fleet/r2",
			"fleet/r1",
		]);
	});

	test("CROSS-ORG: org A's claim pages only org A's rows", async () => {
		const t = createT();
		await seedWorld(t);
		const page = await asService(t).query(api.githubRepoMapping.list, {
			fields: "lite",
			...claim(A),
		});
		expect(page.items.map((i) => i.repo)).toEqual(["org-a/app"]);
	});

	test("ABSENT: an org with no rows reads an empty success", async () => {
		const t = createT();
		await seedWorld(t);
		const page = await asService(t).query(api.githubRepoMapping.list, {
			fields: "lite",
			...claim(EMPTY),
		});
		expect(page.items).toEqual([]);
	});
});
