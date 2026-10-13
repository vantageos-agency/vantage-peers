/// <reference types="vite/client" />
/**
 * BATCH E, the fleet-internal WRITE doors are service-account-only by purpose.
 *
 * `issues:updateStatus / linkCommit / verify`, `errorMonitor:addDeployment /
 * removeDeployment` and `fixPatterns:create / addAttempt / validate / linkIssue`
 * write tables that carry no tenant column. Their gate is the package's standing
 * over the resolved scope (`scopeWithFleetStanding`), refused by the one helper
 * every door uses (`requireResolvedCaller` with `masterOnly` + `mcpBoundOnly`),
 * plus the package's own `requireServiceAccountStanding`: no master flag is read
 * in these files.
 *
 * Callers, said apart (.claude/rules/refusal-is-distinguishable-from-absence.md):
 *   fleet service account   - PRESENT: the write lands
 *   operator org admin      - REFUSED: master for READS only, a write door refuses the human
 *   client org admin/member - REFUSED (cross-org): never writes a fleet row
 *   signed in, no org       - REFUSED
 *   anonymous               - REFUSED
 *   fleet, target missing   - ABSENT: the door's own "not found", never an RBAC refusal
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

// The first test of a file pays the cold start of the whole Convex module graph.
vi.setConfig({ testTimeout: 30_000 });
// fixPatterns writes schedule a RAG-sync action: fake timers keep it inside the test.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const A = "org-a";
const OP = "fleet-op";
const NOW = 1_700_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asHuman = (t: T, org: string, role: string) =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Identity);
const asPreOrg = (t: T) => t.withIdentity({ subject: "signed-in-no-org" } as Identity);

type Caller = (t: T) => ReturnType<typeof asService> | T;
const refused: Array<[string, Caller]> = [
	["the operator org admin human (a write door refuses it)", (t) => asHuman(t, OP, "org:admin")],
	["a client org admin", (t) => asHuman(t, A, "org:admin")],
	["a client org member", (t) => asHuman(t, A, "org:member")],
	["a signed-in caller with no organisation", asPreOrg],
	["an anonymous caller", (t) => t],
];

type World = { patternId: Id<"fixPatterns">; deploymentId: Id<"monitoredDeployments"> };

async function seed(t: T): Promise<World> {
	return await t.run(async (ctx) => {
		for (const [slug, kind] of [
			[OP, "operator"],
			[A, undefined],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(kind ? { orgKind: kind } : {}),
			});
		}
		await seedRosterAgent(ctx, OP, "sigma");
		await ctx.db.insert("issues", {
			repo: "fleet/core",
			issueNumber: 1,
			title: "t",
			body: "b",
			htmlUrl: "u",
			labels: [],
			status: "open",
			priority: "low",
			assignedOrchestrator: "sigma",
			project: "core",
			githubCreatedAt: NOW,
			githubUpdatedAt: NOW,
		});
		const patternId = await ctx.db.insert("fixPatterns", {
			symptom: "s",
			rootCause: "r",
			tags: [],
			stack: [],
			sourceProject: "core",
			createdBy: "sigma",
			severity: "minor",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const deploymentId = await ctx.db.insert("monitoredDeployments", {
			name: "dep",
			deploymentUrl: "https://dep.invalid",
			deployKeyEnvVar: "DEP_KEY",
			githubRepo: "fleet/core",
			orchestrator: "sigma",
			active: true,
			createdAt: NOW,
		});
		return { patternId, deploymentId };
	});
}

const issueOf = (t: T) =>
	t.run((ctx) =>
		ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) => q.eq("repo", "fleet/core").eq("issueNumber", 1))
			.unique(),
	);

describe("issues write doors", () => {
	const doors = [
		{
			name: "updateStatus",
			call: (c: ReturnType<typeof asService>) =>
				c.mutation(api.issues.updateStatus, {
					repo: "fleet/core",
					issueNumber: 1,
					status: "in_progress",
				}),
			missing: (c: ReturnType<typeof asService>) =>
				c.mutation(api.issues.updateStatus, {
					repo: "fleet/core",
					issueNumber: 99,
					status: "in_progress",
				}),
			landed: (r: Awaited<ReturnType<typeof issueOf>>) => r?.status === "in_progress",
		},
		{
			name: "linkCommit",
			call: (c: ReturnType<typeof asService>) =>
				c.mutation(api.issues.linkCommit, {
					repo: "fleet/core",
					issueNumber: 1,
					commitSha: "abc1234",
					fixedBy: "sigma",
				}),
			missing: (c: ReturnType<typeof asService>) =>
				c.mutation(api.issues.linkCommit, {
					repo: "fleet/core",
					issueNumber: 99,
					commitSha: "abc1234",
					fixedBy: "sigma",
				}),
			landed: (r: Awaited<ReturnType<typeof issueOf>>) => r?.fixCommits?.[0] === "abc1234",
		},
		{
			name: "verify",
			call: (c: ReturnType<typeof asService>) =>
				c.mutation(api.issues.verify, {
					repo: "fleet/core",
					issueNumber: 1,
					verifiedBy: "sigma",
				}),
			missing: (c: ReturnType<typeof asService>) =>
				c.mutation(api.issues.verify, {
					repo: "fleet/core",
					issueNumber: 99,
					verifiedBy: "sigma",
				}),
			landed: (r: Awaited<ReturnType<typeof issueOf>>) => r?.status === "verified",
		},
	];

	for (const door of doors) {
		test(`PRESENT: ${door.name} lands for the fleet service account`, async () => {
			const t = createT();
			await seed(t);
			await door.call(asService(t));
			expect(door.landed(await issueOf(t))).toBe(true);
		});

		test(`ABSENT: ${door.name} on a missing issue is the door's own not-found, not a refusal`, async () => {
			const t = createT();
			await seed(t);
			await expect(door.missing(asService(t))).rejects.toThrow(/not found/);
			await expect(door.missing(asService(t))).rejects.not.toThrow(/RBAC_DENIED/);
		});

		for (const [who, caller] of refused) {
			test(`REFUSED: ${door.name} refuses ${who} and writes nothing`, async () => {
				const t = createT();
				await seed(t);
				const before = await issueOf(t);
				await expect(
					door.call(caller(t) as ReturnType<typeof asService>),
				).rejects.toThrow(/RBAC_DENIED/);
				expect(await issueOf(t)).toEqual(before);
			});
		}
	}
});

describe("errorMonitor write doors", () => {
	const deploymentOf = (t: T, name: string) =>
		t.run((ctx) =>
			ctx.db
				.query("monitoredDeployments")
				.withIndex("by_name", (q) => q.eq("name", name))
				.unique(),
		);
	const add = (c: ReturnType<typeof asService>) =>
		c.mutation(api.errorMonitor.addDeployment, {
			name: "dep-new",
			deploymentUrl: "https://new.invalid",
			deployKeyEnvVar: "NEW_KEY",
			githubRepo: "fleet/core",
			orchestrator: "sigma",
		});
	const remove = (c: ReturnType<typeof asService>) =>
		c.mutation(api.errorMonitor.removeDeployment, { name: "dep" });

	test("PRESENT: addDeployment registers a deployment for the fleet service account", async () => {
		const t = createT();
		await seed(t);
		await add(asService(t));
		expect((await deploymentOf(t, "dep-new"))?.active).toBe(true);
	});

	test("PRESENT: removeDeployment deactivates it for the fleet service account", async () => {
		const t = createT();
		await seed(t);
		await remove(asService(t));
		expect((await deploymentOf(t, "dep"))?.active).toBe(false);
	});

	test("ABSENT: removeDeployment on an unknown name is a quiet no-op, not a refusal", async () => {
		const t = createT();
		await seed(t);
		await expect(
			asService(t).mutation(api.errorMonitor.removeDeployment, { name: "nope" }),
		).resolves.toBeNull();
	});

	for (const [who, caller] of refused) {
		test(`REFUSED: addDeployment refuses ${who}`, async () => {
			const t = createT();
			await seed(t);
			await expect(
				add(caller(t) as ReturnType<typeof asService>),
			).rejects.toThrow(/RBAC_DENIED/);
			expect(await deploymentOf(t, "dep-new")).toBeNull();
		});

		test(`REFUSED: removeDeployment refuses ${who}`, async () => {
			const t = createT();
			await seed(t);
			await expect(
				remove(caller(t) as ReturnType<typeof asService>),
			).rejects.toThrow(/RBAC_DENIED/);
			expect((await deploymentOf(t, "dep"))?.active).toBe(true);
		});
	}
});

describe("fixPatterns write doors", () => {
	const create = (c: ReturnType<typeof asService>) =>
		c.mutation(api.fixPatterns.create, {
			symptom: "new symptom",
			rootCause: "new root",
			tags: [],
			stack: [],
			sourceProject: "core",
			createdBy: "sigma",
			severity: "minor",
		});
	const validate = (c: ReturnType<typeof asService>, patternId: Id<"fixPatterns">) =>
		c.mutation(api.fixPatterns.validate, { patternId, validatedFix: "the fix" });
	const linkIssue = (c: ReturnType<typeof asService>, patternId: Id<"fixPatterns">) =>
		c.mutation(api.fixPatterns.linkIssue, { patternId, issueId: "iss-1" });
	const addAttempt = (c: ReturnType<typeof asService>, patternId: Id<"fixPatterns">) =>
		c.mutation(api.fixPatterns.addAttempt, {
			patternId,
			description: "tried",
			worked: false,
			why: "because",
			createdBy: "sigma",
		});
	const patterns = (t: T) => t.run((ctx) => ctx.db.query("fixPatterns").collect());
	const attempts = (t: T) => t.run((ctx) => ctx.db.query("fixAttempts").collect());

	test("PRESENT: create, validate, linkIssue and addAttempt land for the fleet service account", async () => {
		const t = createT();
		const w = await seed(t);
		const c = asService(t);
		await create(c);
		await validate(c, w.patternId);
		await linkIssue(c, w.patternId);
		await addAttempt(c, w.patternId);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const all = await patterns(t);
		expect(all).toHaveLength(2);
		const seeded = all.find((p) => p._id === w.patternId);
		expect(seeded?.validatedFix).toBe("the fix");
		expect(seeded?.linkedIssueIds).toEqual(["iss-1"]);
		expect(await attempts(t)).toHaveLength(1);
	});

	test("ABSENT: validate, linkIssue and addAttempt on a deleted pattern are the door's own not-found", async () => {
		const t = createT();
		const w = await seed(t);
		await t.run((ctx) => ctx.db.delete(w.patternId));
		for (const call of [validate, linkIssue, addAttempt]) {
			await expect(call(asService(t), w.patternId)).rejects.toThrow(/not found/);
			await expect(call(asService(t), w.patternId)).rejects.not.toThrow(
				/RBAC_DENIED/,
			);
		}
	});

	for (const [who, caller] of refused) {
		test(`REFUSED: all four doors refuse ${who} and write nothing`, async () => {
			const t = createT();
			const w = await seed(t);
			const c = caller(t) as ReturnType<typeof asService>;
			await expect(create(c)).rejects.toThrow(/RBAC_DENIED/);
			await expect(validate(c, w.patternId)).rejects.toThrow(/RBAC_DENIED/);
			await expect(linkIssue(c, w.patternId)).rejects.toThrow(/RBAC_DENIED/);
			await expect(addAttempt(c, w.patternId)).rejects.toThrow(/RBAC_DENIED/);
			const all = await patterns(t);
			expect(all).toHaveLength(1);
			expect(all[0].validatedFix).toBeUndefined();
			expect(all[0].linkedIssueIds).toBeUndefined();
			expect(await attempts(t)).toHaveLength(0);
		});
	}
});
