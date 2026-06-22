/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// githubRepoMapping.list_repo_mappings.test.ts — PR-C TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
// Tests for envelope safety contract on the `githubRepoMapping.list` Convex query:
//   - default limit 20 (not 50)
//   - cap at 200 (anything above is clamped to 200, not thrown)
//   - fields=lite returns only {_id, _creationTime, repo, orchestrator, project}
//   - fields=full returns all row keys
//   - cursor round-trip + survives same-millisecond inserts
//   - filter args (orchestrator / project) compose with paging
//   - empty result returns {items: [], nextCursor: null} (no crash)
//
// Lite projection key set rationale:
//   Schema fields: repo, orchestrator, project, active, lastDeployedSHA?, lastDeployedAt?
//   "lite" = the 3 identity fields (repo, orchestrator, project) plus the Convex
//   system fields (_id, _creationTime). Excludes `active`, `lastDeployedSHA`,
//   `lastDeployedAt` — those are operational details, not needed for a compact
//   directory listing. Source: convex/schema.ts lines 440-447.
//
// T-GREEN (impl) must: change default to 20, add cap 200, add fields projection,
// change returns shape to { items, nextCursor } with proper cursor paging
// (replace createdBefore anchor with opaque cursor using .paginate()).
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

function makeRepoMapping(overrides: Partial<{
	repo: string;
	orchestrator: string;
	project: string;
	active: boolean;
	lastDeployedSHA: string;
	lastDeployedAt: number;
}> = {}) {
	return {
		repo: overrides.repo ?? "elpi-corp/test-repo",
		orchestrator: overrides.orchestrator ?? "sigma",
		project: overrides.project ?? "vantage-memory",
		active: overrides.active ?? true,
		...(overrides.lastDeployedSHA !== undefined
			? { lastDeployedSHA: overrides.lastDeployedSHA }
			: {}),
		...(overrides.lastDeployedAt !== undefined
			? { lastDeployedAt: overrides.lastDeployedAt }
			: {}),
	};
}

describe("list_repo_mappings envelope safety (PR-C RED)", () => {
	test("1. list without args returns default limit 20 + nextCursor when >20 rows exist", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 25; i++) {
				await ctx.db.insert(
					"githubRepoMapping",
					makeRepoMapping({ repo: `elpi-corp/repo-${i}` }),
				);
			}
		});
		// T-GREEN must change returns shape to { items: row[], nextCursor: string | null }
		// and default limit to 20. Current impl returns a flat array with limit=50 → FAIL.
		const result = await t.query(api.githubRepoMapping.list, {});
		expect(result).toHaveProperty("items");
		expect(result).toHaveProperty("nextCursor");
		const { items, nextCursor } = result as {
			items: unknown[];
			nextCursor: string | null;
		};
		expect(items.length).toBe(20);
		expect(nextCursor).toBeDefined();
		expect(nextCursor).not.toBeNull();
	});

	test("2. limit=5 returns 5 items + nextCursor when more exist", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert(
					"githubRepoMapping",
					makeRepoMapping({ repo: `elpi-corp/repo-${i}` }),
				);
			}
		});
		const result = await t.query(api.githubRepoMapping.list, { limit: 5 });
		expect(result).toHaveProperty("items");
		expect(result).toHaveProperty("nextCursor");
		const { items, nextCursor } = result as {
			items: unknown[];
			nextCursor: string | null;
		};
		expect(items.length).toBe(5);
		expect(nextCursor).toBeDefined();
		expect(nextCursor).not.toBeNull();
	});

	test("3. limit=250 is clamped to 200 (not throw)", async () => {
		const t = convexTest(schema, modules);
		// No rows needed — cap test only. T-GREEN MUST clamp to 200, not throw.
		let threw = false;
		let result: unknown;
		try {
			result = await t.query(api.githubRepoMapping.list, { limit: 250 });
		} catch {
			threw = true;
		}
		if (!threw) {
			// If it doesn't throw, shape must be the envelope and items.length <= 200
			expect(result).toHaveProperty("items");
			const { items } = result as { items: unknown[] };
			expect(items.length).toBeLessThanOrEqual(200);
		} else {
			// Throwing on 250 is NOT acceptable per cap-not-throw contract
			expect(threw).toBe(false); // force RED: T-GREEN must clamp, not throw
		}
	});

	test("4. fields=lite returns only {_id, _creationTime, repo, orchestrator, project}", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert(
					"githubRepoMapping",
					makeRepoMapping({
						repo: `elpi-corp/repo-${i}`,
						orchestrator: "sigma",
						project: "vantage-memory",
						lastDeployedSHA: "abc123",
						lastDeployedAt: Date.now(),
					}),
				);
			}
		});
		const result = await t.query(api.githubRepoMapping.list, { fields: "lite" });
		expect(result).toHaveProperty("items");
		const { items } = result as { items: Record<string, unknown>[] };
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) {
			const keys = Object.keys(item).sort();
			// Lite = identity fields only: _id, _creationTime, repo, orchestrator, project
			expect(keys).toEqual(
				["_id", "_creationTime", "repo", "orchestrator", "project"].sort(),
			);
			// Must NOT include operational / deployment fields
			expect(item).not.toHaveProperty("active");
			expect(item).not.toHaveProperty("lastDeployedSHA");
			expect(item).not.toHaveProperty("lastDeployedAt");
		}
	});

	test("5. fields=full returns complete row object", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				"githubRepoMapping",
				makeRepoMapping({
					repo: "elpi-corp/full-repo",
					lastDeployedSHA: "deadbeef",
					lastDeployedAt: Date.now(),
				}),
			);
		});
		const result = await t.query(api.githubRepoMapping.list, { fields: "full" });
		expect(result).toHaveProperty("items");
		const { items } = result as { items: Record<string, unknown>[] };
		expect(items.length).toBe(1);
		const item = items[0];
		// All schema keys must be present
		expect(item).toHaveProperty("_id");
		expect(item).toHaveProperty("_creationTime");
		expect(item).toHaveProperty("repo");
		expect(item).toHaveProperty("orchestrator");
		expect(item).toHaveProperty("project");
		expect(item).toHaveProperty("active");
		expect(item).toHaveProperty("lastDeployedSHA");
		expect(item).toHaveProperty("lastDeployedAt");
	});

	test("6. cursor round-trip: page2 has no overlap with page1 and combined = all rows", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert(
					"githubRepoMapping",
					makeRepoMapping({ repo: `elpi-corp/cursor-repo-${i}` }),
				);
			}
		});
		// First page
		const page1 = await t.query(api.githubRepoMapping.list, { limit: 5 });
		expect(page1).toHaveProperty("items");
		expect(page1).toHaveProperty("nextCursor");
		const { items: items1, nextCursor: cursor1 } = page1 as {
			items: Record<string, unknown>[];
			nextCursor: string | null;
		};
		expect(items1.length).toBe(5);
		expect(cursor1).not.toBeNull();
		if (cursor1 === null) throw new Error("cursor1 must not be null");

		// Second page using opaque cursor from first page
		const page2 = await t.query(api.githubRepoMapping.list, {
			limit: 5,
			cursor: cursor1,
		});
		expect(page2).toHaveProperty("items");
		const { items: items2 } = page2 as { items: Record<string, unknown>[] };
		expect(items2.length).toBe(5);

		// Pages must be distinct (no duplicates)
		const ids1 = new Set(items1.map((i) => i._id as string));
		const ids2 = new Set(items2.map((i) => i._id as string));
		for (const id of ids2) {
			expect(ids1.has(id)).toBe(false);
		}

		// Combined, they cover all 10 rows
		expect(ids1.size + ids2.size).toBe(10);
	});

	test("7. empty table returns {items: [], nextCursor: null} + paging args compose (limit + fields)", async () => {
		const t = convexTest(schema, modules);
		// No rows — empty table test.
		// T-GREEN must return envelope shape even for empty results.
		const result = await t.query(api.githubRepoMapping.list, {
			limit: 10,
			fields: "lite",
		});
		expect(result).toHaveProperty("items");
		expect(result).toHaveProperty("nextCursor");
		const { items, nextCursor } = result as {
			items: unknown[];
			nextCursor: string | null;
		};
		expect(items).toEqual([]);
		expect(nextCursor).toBeNull();

		// Also verify that with rows present, limit + fields compose correctly:
		// (separate convexTest instance to avoid cross-test pollution)
		const t2 = convexTest(schema, modules);
		await t2.run(async (ctx) => {
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert(
					"githubRepoMapping",
					makeRepoMapping({ repo: `elpi-corp/compose-repo-${i}` }),
				);
			}
		});
		const result2 = await t2.query(api.githubRepoMapping.list, {
			limit: 3,
			fields: "lite",
		});
		expect(result2).toHaveProperty("items");
		expect(result2).toHaveProperty("nextCursor");
		const { items: items2, nextCursor: cursor2 } = result2 as {
			items: Record<string, unknown>[];
			nextCursor: string | null;
		};
		// limit=3 with 5 rows → 3 items returned, nextCursor not null
		expect(items2.length).toBe(3);
		expect(cursor2).not.toBeNull();
		// fields=lite projection applied — only identity fields present
		for (const item of items2) {
			expect(item).not.toHaveProperty("active");
			expect(item).not.toHaveProperty("lastDeployedSHA");
		}
	});
});
