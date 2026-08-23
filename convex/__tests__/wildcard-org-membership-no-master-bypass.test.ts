/// <reference types="vite/client" />
/**
 * T2 — Pi ruling (PR #1224, decision b): a Clerk identity resolved through
 * client_org_mapping NEVER mints the cross-tenant isMaster bypass from org
 * membership, even when that org's mapping row carries `["*"]`. The org
 * KEEPS its stated roster (allowedOrchestrators/scopes) — it loses ONLY the
 * master profile that ignores tenant boundaries.
 *
 * THE PROPERTY (both poles), under a SCOPED identity that is NOT the master
 * secret and NOT the record's creator:
 *   ALLOW — a member of a `["*"]`-mapped org reads that org's OWN data
 *   (assignedTo matches the org's allowedOrchestrators roster) and succeeds.
 *   DENY  — that SAME member reaches for a DIFFERENT org's data (a task
 *   assigned to a member of org B) and is REFUSED (filtered out), never
 *   returned via a cross-tenant isMaster bypass.
 *
 * Litmus (Pi): could this test still pass if the authorization code were
 * deleted? No — filterByOrgScope's non-master branch is the exact code path
 * under test; deleting it (or withOrgScope's isMaster resolution) flips the
 * DENY assertion to observe leaked cross-tenant rows.
 *
 * RED-before-GREEN: this test MUST FAIL at the pre-FIX-2 head, where
 * `withOrgScope`'s final return read
 * `isMaster: mapping.allowedOrchestrators.includes("*")` — a `["*"]` mapping
 * row minted isMaster=true from mere membership, so filterByOrgScope's
 * `if (scope.isMaster) return records;` short-circuit returned BOTH orgs'
 * tasks, and the DENY half below (asserting org B's task is NOT visible)
 * failed. It PASSes after FIX 2 (isMaster is unconditionally false for a
 * Clerk-identity/mapping-derived scope).
 *
 * Task: PR #1224 Pi ruling (b) — master never derives from org membership.
 * Orchestrator: Sigma — VantagePeers | 2026-08-22
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("okfBundleNode") &&
			!path.includes("errorMonitorActions") &&
			!path.includes("errorMonitorAutoResolver"),
	),
);

const createT = () => convexTest(schema, modules);

describe("T2 — wildcard-org membership never mints master, roster stays scoped", () => {
	test("ALLOW: member of a [\"*\"]-mapped org reads that org's OWN task", async () => {
		const t = createT();

		// org-wildcard's mapping row carries "*" in its roster (the exact
		// defect-class shape — pre-fix, ".includes(\"*\")" minted master from
		// this ALONE) but ALSO explicitly names its real member ("member-a")
		// — the roster this org is entitled to KEEPS, per Pi's ruling, is
		// exactly this stated list, member-a included.
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-wildcard",
				allowedOrchestrators: ["*", "member-a"],
				scopes: ["view-own-tasks"],
				displayName: "Wildcard Org",
				isActive: true,
				createdAt: Date.now(),
			});
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-b",
				allowedOrchestrators: ["member-b"],
				scopes: ["view-own-tasks"],
				displayName: "Org B",
				isActive: true,
				createdAt: Date.now(),
			});

			// org-wildcard's own task (NOT created by the reading identity —
			// pilot/creator distinct from the reading member).
			await ctx.db.insert("tasks", {
				title: "org-wildcard task about apples",
				assignedTo: "member-a",
				priority: "medium",
				status: "todo",
				createdBy: "someone-else",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				orgId: "org-wildcard",
			});

			// org-b's task — a DIFFERENT tenant's data.
			await ctx.db.insert("tasks", {
				title: "org-b task about apples",
				assignedTo: "member-b",
				priority: "medium",
				status: "todo",
				createdBy: "someone-else-b",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				orgId: "org-b",
			});
		});

		// A scoped identity: a MEMBER of org-wildcard (not master secret, not
		// the record's creator).
		const tMember = t.withIdentity({
			subject: "user-member-a",
			organizationSlug: "org-wildcard",
		} as Parameters<typeof t.withIdentity>[0]);

		const ownResults = await tMember.query(api.tasks.searchTasksByKeyword, {
			query: "apples",
			assignedTo: "member-a",
		});

		expect(ownResults.length).toBe(1);
		expect(ownResults[0].title).toBe("org-wildcard task about apples");
	});

	test("DENY: that SAME member cannot reach org-b's task — no cross-tenant isMaster bypass from [\"*\"] membership", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-wildcard",
				allowedOrchestrators: ["*", "member-a"],
				scopes: ["view-own-tasks"],
				displayName: "Wildcard Org",
				isActive: true,
				createdAt: Date.now(),
			});
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-b",
				allowedOrchestrators: ["member-b"],
				scopes: ["view-own-tasks"],
				displayName: "Org B",
				isActive: true,
				createdAt: Date.now(),
			});

			await ctx.db.insert("tasks", {
				title: "org-b secret task about apples",
				assignedTo: "member-b",
				priority: "medium",
				status: "todo",
				createdBy: "someone-else-b",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				orgId: "org-b",
			});
		});

		const tMember = t.withIdentity({
			subject: "user-member-a",
			organizationSlug: "org-wildcard",
		} as Parameters<typeof t.withIdentity>[0]);

		// This member of org-wildcard reaches for org-b's data. Pre-FIX-2, the
		// ["*"] mapping row minted isMaster=true, so searchTasksByKeyword's
		// `if (!scope.isMaster && scope.orgSlug !== null) qb = qb.eq("orgId",
		// scope.orgSlug)` guard was SKIPPED (isMaster short-circuited it) and
		// filterByOrgScope's `if (scope.isMaster) return records;` returned
		// org-b's row unfiltered — this assertion FAILED (length 1, leaked).
		const crossTenantResults = await tMember.query(
			api.tasks.searchTasksByKeyword,
			{
				query: "apples",
			},
		);

		expect(crossTenantResults.length).toBe(0);
	});
});
