/// <reference types="vite/client" />
//
// pagination-class-sweep-githubrepomapping.test.ts — TDD-RED for mission
// k574p02m lot 2. CLASS: cursor-anchor pagination bounded by a FIXED
// multiplier (`limit * 4 + 10`) instead of a wide-scan cap — same defect
// shape as businessUnits.list. convex/githubRepoMapping.ts:73-145 `list`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";


// ─────────────────────────────────────────────────────────────────────────────
// FLEET_IDENTITY — task k173wwv743mkvrn4qr7ap0qrps8f6d6k.
//
// The read(s) this suite drives were measured against LIVE production at commit
// bd8c60e9 serving real rows to a caller presenting NO CREDENTIAL AT ALL, and are
// now refused for any caller that is not the verified fleet master (these tables
// carry no orgId column) or, where the rows name an orchestrator, any caller
// outside its own roster. This suite asserts PAGINATION/ENVELOPE behaviour, not
// authorisation: nothing it checks has changed, so it now presents the identity
// its subject is actually for — the MCP server's own Clerk service-account
// subject, which withOrgScope resolves to master by id
// (CLERK_SERVICE_ACCOUNT_USER_ID, set in vitest.config.ts).
//
// This is NOT a weakened assertion: the DENY poles for these same reads — an
// anonymous caller, a signed-in caller with no organisation, and an ORDINARY
// member of an active organisation — are pinned in
// convex/__tests__/publicRegistrationResolvesCaller.test.ts, where deleting any
// guard turns them red.
// ─────────────────────────────────────────────────────────────────────────────
const FLEET_IDENTITY = { subject: "test-service-account-user-id" };

type RepoMappingRow = { _id: string; _creationTime: number; repo: string };

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("githubRepoMapping.list cursor pagination — fixed-buffer fetchLimit undershoots deep pages", () => {
	test("RED/GREEN: paginating to the end must return every seeded repo mapping", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 130;
		const seededRepos: string[] = [];

		// Seeds directly via ctx.db — githubRepoMapping.add now requires a
		// verified master/service-account caller (see
		// convex/__tests__/issuesGithubRepoMappingErrorMonitorWriteScope.test.ts).
		// This suite tests pagination class behaviour, not auth.
		for (let i = 0; i < TOTAL; i++) {
			const repo = `sweep-org/repo-${i}`;
			seededRepos.push(repo);
			await t.run(async (ctx) => {
				await ctx.db.insert("githubRepoMapping", {
					repo,
					orchestrator: "sigma",
					project: "sweep-project",
					active: true,
				});
			});
		}

		const collected: RepoMappingRow[] = [];
		let cursor: string | null = null;
		let pages = 0;
		while (pages < 20) {
			pages++;
			const page: { items: RepoMappingRow[]; nextCursor: string | null } = await t.withIdentity(FLEET_IDENTITY as Parameters<typeof t.withIdentity>[0]).query(api.githubRepoMapping.list,
				{ cursor: cursor ?? undefined },
			);
			collected.push(...page.items);
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}

		const collectedRepos = new Set(collected.map((r) => r.repo));
		const missing = seededRepos.filter((r) => !collectedRepos.has(r));
		expect(missing).toEqual([]);
		expect(collectedRepos.size).toBe(TOTAL);
	});

	// mission k574p02m lot 2 — Eta REVISE. The fetchLimit widening was gated
	// on `cursorPayload` only. The LEGACY `createdBefore` back-compat path
	// (no cursor arg) still falls through to `limit + 1` (narrow).
	test("RED/GREEN: legacy createdBefore pagination must return every seeded repo mapping", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 130;
		const seededRepos: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const repo = `sweep-org/repo-legacy-${i}`;
			seededRepos.push(repo);
			await t.run(async (ctx) => {
				await ctx.db.insert("githubRepoMapping", {
					repo,
					orchestrator: "sigma",
					project: "sweep-project",
					active: true,
				});
			});
		}

		const collected: RepoMappingRow[] = [];
		let createdBefore: number | undefined;
		let pages = 0;
		while (pages < 20) {
			pages++;
			const page: { items: RepoMappingRow[] } = await t.withIdentity(FLEET_IDENTITY as Parameters<typeof t.withIdentity>[0]).query(api.githubRepoMapping.list,
				{ createdBefore },
			);
			if (page.items.length === 0) break;
			collected.push(...page.items);
			createdBefore = page.items[page.items.length - 1]._creationTime;
		}

		const collectedRepos = new Set(collected.map((r) => r.repo));
		const missing = seededRepos.filter((r) => !collectedRepos.has(r));
		expect(missing).toEqual([]);
		expect(collectedRepos.size).toBe(TOTAL);
	});
});
