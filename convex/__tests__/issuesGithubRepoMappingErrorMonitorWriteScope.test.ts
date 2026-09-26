/// <reference types="vite/client" />
/**
 * convex/issues.ts, convex/githubRepoMapping.ts, convex/errorMonitor.ts —
 * write-scope enforcement for the slice of `KNOWN_OFFENDERS`
 * (publicMutationAuthGuard.test.ts) assigned to this fix:
 *
 *   convex/issues.ts:upsertFromGitHub
 *   convex/issues.ts:updateStatus
 *   convex/issues.ts:linkCommit
 *   convex/issues.ts:linkTask
 *   convex/issues.ts:verify
 *   convex/issues.ts:close
 *   convex/issues.ts:createExternal
 *   convex/issues.ts:updatePrStatus
 *   convex/githubRepoMapping.ts:add
 *   convex/githubRepoMapping.ts:remove
 *   convex/githubRepoMapping.ts:seed
 *   convex/errorMonitor.ts:addDeployment
 *   convex/errorMonitor.ts:removeDeployment
 *
 * DEFECT (pre-fix, on main): every one of these took NO ctx.auth check at
 * all — the class .claude/rules/authority-attached-to-anonymous-object.md
 * names. Fleet github-issue/error-monitor tracking has no per-org owner
 * field (these tables are fleet-internal, not client multi-tenant data), so
 * the closure for the still-public surfaces is MASTER-ONLY: `withOrgScope`
 * resolved, then `if (!scope.isMaster) throw RBAC_DENIED`. Six sites
 * (upsertFromGitHub, linkTask, close, createExternal, updatePrStatus, and
 * githubRepoMapping.seed) had ZERO enumerated external callers (grepped
 * across mcp-server/ and vantage-peers-dashboard) and are converted to
 * `internalMutation` instead — an internal function is not reachable over
 * the public Convex API at all, so "an anonymous caller can invoke it" is
 * false by construction, and there is nothing for a positive-pole (master)
 * test to prove since the ONLY caller is another Convex function in the
 * same deployment.
 *
 * Every RED pole below runs under an ordinary org-scoped Clerk identity
 * (`org-a`, never `test-service-account-user-id`) so the authorization
 * code cannot be deleted and still pass. The master/service-account
 * caller's own POSITIVE pole is proven so the fix does not merely refuse
 * everyone (the fleet's own orchestrators call these through the MCP
 * server's service-account identity).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedIssue(t: ReturnType<typeof createT>) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("issues", {
			repo: "acme/widgets",
			issueNumber: 42,
			title: "seed issue",
			body: "seed body",
			htmlUrl: "https://github.com/acme/widgets/issues/42",
			labels: [],
			status: "open",
			priority: "medium",
			assignedOrchestrator: "sigma",
			project: "widgets",
			githubCreatedAt: Date.now(),
			githubUpdatedAt: Date.now(),
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// issues.updateStatus
// ─────────────────────────────────────────────────────────────────────────────

describe("issues.updateStatus — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await seedIssue(t);

		await expect(
			t.mutation(api.issues.updateStatus, {
				repo: "acme/widgets",
				issueNumber: 42,
				status: "in_progress",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const issue = await t.run((ctx) =>
			ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) =>
					q.eq("repo", "acme/widgets").eq("issueNumber", 42),
				)
				.unique(),
		);
		expect(issue?.status).toBe("open"); // existence oracle — unchanged
	});

	test("an org-scoped (non-master) caller is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedIssue(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.issues.updateStatus, {
				repo: "acme/widgets",
				issueNumber: 42,
				status: "in_progress",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("the master/service-account identity succeeds", async () => {
		const t = createT();
		await seedIssue(t);
		const tMaster = asMaster(t);

		await tMaster.mutation(api.issues.updateStatus, {
			repo: "acme/widgets",
			issueNumber: 42,
			status: "in_progress",
		});

		const issue = await t.run((ctx) =>
			ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) =>
					q.eq("repo", "acme/widgets").eq("issueNumber", 42),
				)
				.unique(),
		);
		expect(issue?.status).toBe("in_progress");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// issues.linkCommit
// ─────────────────────────────────────────────────────────────────────────────

describe("issues.linkCommit — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await seedIssue(t);

		await expect(
			t.mutation(api.issues.linkCommit, {
				repo: "acme/widgets",
				issueNumber: 42,
				commitSha: "deadbeef",
				fixedBy: "seat-x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const issue = await t.run((ctx) =>
			ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) =>
					q.eq("repo", "acme/widgets").eq("issueNumber", 42),
				)
				.unique(),
		);
		expect(issue?.fixCommits ?? []).toHaveLength(0); // existence oracle — unchanged
	});

	test("an org-scoped (non-master) caller is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedIssue(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.issues.linkCommit, {
				repo: "acme/widgets",
				issueNumber: 42,
				commitSha: "deadbeef",
				fixedBy: "seat-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("the master/service-account identity succeeds", async () => {
		const t = createT();
		await seedIssue(t);
		const tMaster = asMaster(t);

		await tMaster.mutation(api.issues.linkCommit, {
			repo: "acme/widgets",
			issueNumber: 42,
			commitSha: "deadbeef",
			fixedBy: "sigma",
		});

		const issue = await t.run((ctx) =>
			ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) =>
					q.eq("repo", "acme/widgets").eq("issueNumber", 42),
				)
				.unique(),
		);
		expect(issue?.fixCommits).toEqual(["deadbeef"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// issues.verify
// ─────────────────────────────────────────────────────────────────────────────

describe("issues.verify — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await seedIssue(t);

		await expect(
			t.mutation(api.issues.verify, {
				repo: "acme/widgets",
				issueNumber: 42,
				verifiedBy: "seat-x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const issue = await t.run((ctx) =>
			ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) =>
					q.eq("repo", "acme/widgets").eq("issueNumber", 42),
				)
				.unique(),
		);
		expect(issue?.status).toBe("open"); // existence oracle — unchanged
	});

	test("an org-scoped (non-master) caller is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedIssue(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.issues.verify, {
				repo: "acme/widgets",
				issueNumber: 42,
				verifiedBy: "seat-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("the master/service-account identity succeeds", async () => {
		const t = createT();
		await seedIssue(t);
		const tMaster = asMaster(t);

		await tMaster.mutation(api.issues.verify, {
			repo: "acme/widgets",
			issueNumber: 42,
			verifiedBy: "sigma",
		});

		const issue = await t.run((ctx) =>
			ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) =>
					q.eq("repo", "acme/widgets").eq("issueNumber", 42),
				)
				.unique(),
		);
		expect(issue?.status).toBe("verified");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// issues.upsertFromGitHub, issues.linkTask, issues.close,
// issues.createExternal, issues.updatePrStatus — converted to
// internalMutation (zero enumerated external callers: upsertFromGitHub is
// invoked only from http.ts's HMAC-verified webhook httpAction via
// ctx.runMutation; updatePrStatus only from prMonitor.ts's internalAction
// cron job; linkTask/close/createExternal have no caller anywhere in
// mcp-server/ or vantage-peers-dashboard).
//
// convex-test's mocked `t.mutation()` calls a handler directly and does NOT
// enforce the public/internal visibility boundary a REAL deployed Convex
// backend enforces at the transport layer (only `internalMutation`s are
// unreachable from the public client API there) — so a runtime call
// through `api.issues.X` cannot serve as the oracle here. The genuine,
// checkable claim is SOURCE-LEVEL and is exactly what
// publicMutationAuthGuard.test.ts's own scanner keys off: the export must
// read `= internalMutation(`, never `= mutation(`. Reading the same source
// text `publicMutationAuthGuard.test.ts` parses (rather than re-deriving
// its TS-AST logic) keeps this a real, source-grounded RED/GREEN oracle.
// ─────────────────────────────────────────────────────────────────────────────

function isInternalMutationExport(relPath: string, exportName: string): boolean {
	const text = readFileSync(join(__dirname, "..", relPath), "utf-8");
	const internalRe = new RegExp(
		`export const ${exportName}\\s*=\\s*internalMutation\\(`,
	);
	const publicRe = new RegExp(`export const ${exportName}\\s*=\\s*mutation\\(`);
	return internalRe.test(text) && !publicRe.test(text);
}

describe("issues — surfaces converted to internalMutation are not publicly reachable", () => {
	test("upsertFromGitHub is exported as internalMutation, not mutation", () => {
		expect(isInternalMutationExport("issues.ts", "upsertFromGitHub")).toBe(true);
		expect(internal.issues.upsertFromGitHub).toBeDefined();
	});

	test("linkTask is exported as internalMutation, not mutation", () => {
		expect(isInternalMutationExport("issues.ts", "linkTask")).toBe(true);
		expect(internal.issues.linkTask).toBeDefined();
	});

	test("close is exported as internalMutation, not mutation", () => {
		expect(isInternalMutationExport("issues.ts", "close")).toBe(true);
		expect(internal.issues.close).toBeDefined();
	});

	test("createExternal is exported as internalMutation, not mutation", () => {
		expect(isInternalMutationExport("issues.ts", "createExternal")).toBe(true);
		expect(internal.issues.createExternal).toBeDefined();
	});

	test("updatePrStatus is exported as internalMutation, not mutation", () => {
		expect(isInternalMutationExport("issues.ts", "updatePrStatus")).toBe(true);
		expect(internal.issues.updatePrStatus).toBeDefined();
	});

	test("upsertFromGitHub (internal) still functions when invoked as the webhook does — via runMutation from another function", async () => {
		const t = createT();
		const id: string = await t.run(async (ctx) => {
			return await ctx.runMutation(internal.issues.upsertFromGitHub, {
				repo: "acme/widgets",
				issueNumber: 99,
				title: "webhook-created",
				body: "body",
				htmlUrl: "https://github.com/acme/widgets/issues/99",
				labels: [],
				status: "open",
				githubCreatedAt: Date.now(),
				githubUpdatedAt: Date.now(),
			});
		});
		expect(id).toBeTruthy();
		const issue = await t.run((ctx) => ctx.db.get(id as never));
		expect((issue as { title?: string } | null)?.title).toBe("webhook-created");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// githubRepoMapping.add / githubRepoMapping.remove
// ─────────────────────────────────────────────────────────────────────────────

describe("githubRepoMapping.add — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();

		await expect(
			t.mutation(api.githubRepoMapping.add, {
				repo: "acme/widgets",
				orchestrator: "sigma",
				project: "widgets",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const all = await t.run((ctx) => ctx.db.query("githubRepoMapping").collect());
		expect(all).toHaveLength(0); // existence oracle — nothing written
	});

	test("an org-scoped (non-master) caller is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.githubRepoMapping.add, {
				repo: "acme/widgets",
				orchestrator: "seat-a",
				project: "widgets",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("the master/service-account identity succeeds", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const id = await tMaster.mutation(api.githubRepoMapping.add, {
			repo: "acme/widgets",
			orchestrator: "sigma",
			project: "widgets",
		});
		expect(id).toBeTruthy();
	});
});

describe("githubRepoMapping.remove — write-scope enforcement", () => {
	async function seedMapping(t: ReturnType<typeof createT>) {
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "acme/widgets",
				orchestrator: "sigma",
				project: "widgets",
				active: true,
			});
		});
	}

	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await seedMapping(t);

		await expect(
			t.mutation(api.githubRepoMapping.remove, { repo: "acme/widgets" }),
		).rejects.toThrow(/RBAC_DENIED/);

		const still = await t.run((ctx) =>
			ctx.db
				.query("githubRepoMapping")
				.withIndex("by_repo", (q) => q.eq("repo", "acme/widgets"))
				.unique(),
		);
		expect(still).not.toBeNull(); // existence oracle — unchanged
	});

	test("an org-scoped (non-master) caller is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.githubRepoMapping.remove, { repo: "acme/widgets" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("the master/service-account identity succeeds", async () => {
		const t = createT();
		await seedMapping(t);
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.githubRepoMapping.remove, {
			repo: "acme/widgets",
		});
		expect(result.deleted).toBe(true);
	});
});

describe("githubRepoMapping.seed — converted to internalMutation, not publicly reachable", () => {
	test("seed is exported as internalMutation, not mutation", () => {
		expect(isInternalMutationExport("githubRepoMapping.ts", "seed")).toBe(true);
		expect(internal.githubRepoMapping.seed).toBeDefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// errorMonitor.addDeployment / errorMonitor.removeDeployment
// ─────────────────────────────────────────────────────────────────────────────

describe("errorMonitor.addDeployment — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();

		await expect(
			t.mutation(api.errorMonitor.addDeployment, {
				name: "prod-1",
				deploymentUrl: "https://prod-1.convex.cloud",
				deployKeyEnvVar: "DEPLOY_KEY_PROD_1",
				githubRepo: "acme/widgets",
				orchestrator: "sigma",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const all = await t.run((ctx) => ctx.db.query("monitoredDeployments").collect());
		expect(all).toHaveLength(0); // existence oracle — nothing written
	});

	test("an org-scoped (non-master) caller is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.errorMonitor.addDeployment, {
				name: "prod-1",
				deploymentUrl: "https://prod-1.convex.cloud",
				deployKeyEnvVar: "DEPLOY_KEY_PROD_1",
				githubRepo: "acme/widgets",
				orchestrator: "seat-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("the master/service-account identity succeeds", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const id = await tMaster.mutation(api.errorMonitor.addDeployment, {
			name: "prod-1",
			deploymentUrl: "https://prod-1.convex.cloud",
			deployKeyEnvVar: "DEPLOY_KEY_PROD_1",
			githubRepo: "acme/widgets",
			orchestrator: "sigma",
		});
		expect(id).toBeTruthy();
	});
});

describe("errorMonitor.removeDeployment — write-scope enforcement", () => {
	async function seedDeployment(t: ReturnType<typeof createT>) {
		await t.run(async (ctx) => {
			await ctx.db.insert("monitoredDeployments", {
				name: "prod-1",
				deploymentUrl: "https://prod-1.convex.cloud",
				deployKeyEnvVar: "DEPLOY_KEY_PROD_1",
				githubRepo: "acme/widgets",
				orchestrator: "sigma",
				active: true,
				createdAt: Date.now(),
			});
		});
	}

	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await seedDeployment(t);

		await expect(
			t.mutation(api.errorMonitor.removeDeployment, { name: "prod-1" }),
		).rejects.toThrow(/RBAC_DENIED/);

		const dep = await t.run((ctx) =>
			ctx.db
				.query("monitoredDeployments")
				.withIndex("by_name", (q) => q.eq("name", "prod-1"))
				.unique(),
		);
		expect(dep?.active).toBe(true); // existence oracle — unchanged
	});

	test("an org-scoped (non-master) caller is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedDeployment(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.errorMonitor.removeDeployment, { name: "prod-1" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("the master/service-account identity succeeds", async () => {
		const t = createT();
		await seedDeployment(t);
		const tMaster = asMaster(t);

		await tMaster.mutation(api.errorMonitor.removeDeployment, { name: "prod-1" });

		const dep = await t.run((ctx) =>
			ctx.db
				.query("monitoredDeployments")
				.withIndex("by_name", (q) => q.eq("name", "prod-1"))
				.unique(),
		);
		expect(dep?.active).toBe(false);
	});
});
