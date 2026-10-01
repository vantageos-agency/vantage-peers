/// <reference types="vite/client" />
//
// pagination-class-sweep-fixpatterns.test.ts — TDD-RED for mission k574p02m
// lot 2. CLASS: `createdBefore` applied AFTER an unbounded `.take(limit)`.
// convex/fixPatterns.ts:265-276 `listByProject` and :308-317 `listAll`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
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

type ListByProjectRow = FunctionReturnType<
	typeof api.fixPatterns.listByProject
>[number];
type ListAllRow = FunctionReturnType<typeof api.fixPatterns.listAll>[number];
type TestConvexT = ReturnType<typeof convexTest<typeof schema.tables>>;

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

async function seedPatterns(t: TestConvexT, project: string, total: number) {
	const ids: string[] = [];
	// Insert directly (bypass fixPatterns.create) — create() schedules
	// internal.ragSync.addFixPatternRagEntry (an action requiring
	// AI_GATEWAY_API_KEY), which is irrelevant to this pagination defect and
	// unusable in convex-test. Row shape mirrors fixPatterns.create exactly.
	for (let i = 0; i < total; i++) {
		const symptom = `symptom-${project}-${i}`;
		ids.push(symptom);
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("fixPatterns", {
				symptom,
				rootCause: "root cause",
				tags: ["test"],
				stack: ["node"],
				sourceProject: project,
				createdBy: "sigma",
				severity: "minor",
				createdAt: now,
				updatedAt: now,
			});
		});
	}
	return ids;
}

describe("fixPatterns pagination — createdBefore applied after unbounded take", () => {
	test("RED/GREEN: listByProject paginating to the end must return every seeded pattern", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const project = "sweep-project-a";
		const seededSymptoms = await seedPatterns(t, project, TOTAL);

		const collected: { symptom: string; _creationTime: number }[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const page: ListByProjectRow[] = await t.withIdentity(FLEET_IDENTITY).query(
				api.fixPatterns.listByProject,
				{ sourceProject: project, limit: PAGE_LIMIT, createdBefore },
			);
			collected.push(
				...page.map((r) => ({ symptom: r.symptom, _creationTime: r._creationTime })),
			);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			createdBefore = page[page.length - 1]._creationTime;
		}

		const collectedSymptoms = new Set(collected.map((r) => r.symptom));
		const missing = seededSymptoms.filter((s) => !collectedSymptoms.has(s));
		expect(missing).toEqual([]);
		expect(collectedSymptoms.size).toBe(TOTAL);
	});

	test("RED/GREEN: listAll paginating to the end must return every seeded pattern", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const seededSymptoms = await seedPatterns(t, "sweep-project-b", TOTAL);

		const collected: { symptom: string; _creationTime: number }[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const page: ListAllRow[] = await t.withIdentity(FLEET_IDENTITY as Parameters<typeof t.withIdentity>[0]).query(api.fixPatterns.listAll, {
				limit: PAGE_LIMIT,
				createdBefore,
			});
			const relevant = page.filter((r) => seededSymptoms.includes(r.symptom));
			collected.push(
				...relevant.map((r) => ({ symptom: r.symptom, _creationTime: r._creationTime })),
			);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			createdBefore = page[page.length - 1]._creationTime;
		}

		const collectedSymptoms = new Set(collected.map((r) => r.symptom));
		const missing = seededSymptoms.filter((s) => !collectedSymptoms.has(s));
		expect(missing).toEqual([]);
		expect(collectedSymptoms.size).toBe(TOTAL);
	});
});
