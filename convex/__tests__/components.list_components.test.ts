/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// components.list_components.test.ts — PR-B TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
// Tests for envelope safety contract on the `components.list` Convex query:
//   - default limit 20 (not 100)
//   - cap at 200 (anything above is clamped or rejected)
//   - fields=lite returns only {_id, _creationTime, name, type, team}
//   - fields=full returns all component keys
//   - cursor-based paging via nextCursor (not createdBefore anchor)
//   - filter args (type / team / project) compose with paging
//   - empty result returns {items: [], nextCursor: null} (no crash)
//
// T-GREEN (impl) must: change default to 20, add cap 200, add fields projection,
// change returns shape to { items, nextCursor } with proper cursor paging.
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

function makeComponent(overrides: Partial<{
	name: string;
	type: "agent" | "skill" | "hook" | "plugin";
	team: string;
	content: string;
	version: string;
	project: string;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}> = {}) {
	const now = Date.now();
	return {
		name: overrides.name ?? "test-component",
		type: overrides.type ?? ("skill" as const),
		team: overrides.team ?? "development",
		content: overrides.content ?? "# test content",
		version: overrides.version,
		project: overrides.project ?? "vantage-memory",
		createdBy: overrides.createdBy ?? "sigma",
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
}

describe("list_components envelope safety (PR-B RED)", () => {
	test("1. list_components without args returns default limit 20 + nextCursor when >20 components exist", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 25; i++) {
				await ctx.db.insert("components", makeComponent({ name: `component-${i}` }));
			}
		});
		// T-GREEN must change returns shape to { items: componentObject[], nextCursor: string | null }
		// and default limit to 20. Current impl returns a flat array with limit=100 → this fails.
		const result = await t.query(api.components.list, {});
		expect(result).toHaveProperty("items");
		expect(result).toHaveProperty("nextCursor");
		const { items, nextCursor } = result as { items: unknown[]; nextCursor: string | null };
		expect(items.length).toBe(20);
		expect(nextCursor).toBeDefined();
		expect(nextCursor).not.toBeNull();
	});

	test("2. list_components limit=5 returns 5 items + nextCursor when more exist", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert("components", makeComponent({ name: `component-${i}` }));
			}
		});
		const result = await t.query(api.components.list, { limit: 5 });
		expect(result).toHaveProperty("items");
		expect(result).toHaveProperty("nextCursor");
		const { items, nextCursor } = result as { items: unknown[]; nextCursor: string | null };
		expect(items.length).toBe(5);
		expect(nextCursor).toBeDefined();
		expect(nextCursor).not.toBeNull();
	});

	test("3. list_components limit=250 is clamped to 200 (not throw)", async () => {
		const t = convexTest(schema, modules);
		// No components needed — cap test only. T-GREEN MUST clamp to 200, not throw.
		let threw = false;
		let result: unknown;
		try {
			result = await t.query(api.components.list, { limit: 250 });
		} catch {
			threw = true;
		}
		if (!threw) {
			// If it doesn't throw, it must return the envelope shape and items.length <= 200
			expect(result).toHaveProperty("items");
			const { items } = result as { items: unknown[] };
			expect(items.length).toBeLessThanOrEqual(200);
		} else {
			// Throwing on 250 is NOT acceptable per cap-not-throw contract
			expect(threw).toBe(false); // force RED: T-GREEN must clamp, not throw
		}
	});

	test("4. list_components fields=lite returns only {_id, _creationTime, name, type, team}", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert("components", makeComponent({ name: `component-${i}`, team: "dev" }));
			}
		});
		const result = await t.query(api.components.list, { fields: "lite" });
		expect(result).toHaveProperty("items");
		const { items } = result as { items: Record<string, unknown>[] };
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) {
			const keys = Object.keys(item).sort();
			expect(keys).toEqual(["_creationTime", "_id", "name", "team", "type"].sort());
			// Must NOT include full-object fields
			expect(item).not.toHaveProperty("content");
			expect(item).not.toHaveProperty("version");
			expect(item).not.toHaveProperty("project");
			expect(item).not.toHaveProperty("createdBy");
			expect(item).not.toHaveProperty("createdAt");
			expect(item).not.toHaveProperty("updatedAt");
		}
	});

	test("5. list_components fields=full returns complete component object", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert("components", makeComponent({ name: "full-component" }));
		});
		const result = await t.query(api.components.list, { fields: "full" });
		expect(result).toHaveProperty("items");
		const { items } = result as { items: Record<string, unknown>[] };
		expect(items.length).toBe(1);
		const item = items[0];
		// All component keys must be present
		expect(item).toHaveProperty("_id");
		expect(item).toHaveProperty("_creationTime");
		expect(item).toHaveProperty("name");
		expect(item).toHaveProperty("type");
		expect(item).toHaveProperty("content");
		expect(item).toHaveProperty("createdBy");
		expect(item).toHaveProperty("createdAt");
		expect(item).toHaveProperty("updatedAt");
	});

	test("6. list_components cursor=<token> returns next page consistent with prior nextCursor (no gaps)", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert("components", makeComponent({ name: `component-cursor-${i}` }));
			}
		});
		// First page
		const page1 = await t.query(api.components.list, { limit: 5 });
		expect(page1).toHaveProperty("items");
		expect(page1).toHaveProperty("nextCursor");
		const { items: items1, nextCursor: cursor1 } = page1 as {
			items: Record<string, unknown>[];
			nextCursor: string | null;
		};
		expect(items1.length).toBe(5);
		expect(cursor1).not.toBeNull();

		// Second page using cursor from first page
		const page2 = await t.query(api.components.list, { limit: 5, cursor: cursor1! });
		expect(page2).toHaveProperty("items");
		const { items: items2 } = page2 as { items: Record<string, unknown>[] };
		expect(items2.length).toBe(5);

		// Pages must be distinct (no duplicates)
		const ids1 = new Set(items1.map((i) => i._id as string));
		const ids2 = new Set(items2.map((i) => i._id as string));
		for (const id of ids2) {
			expect(ids1.has(id)).toBe(false);
		}

		// Combined, they cover exactly 10 components
		expect(ids1.size + ids2.size).toBe(10);
	});

	test("7. list_components empty result returns {items: [], nextCursor: null} (no crash)", async () => {
		const t = convexTest(schema, modules);
		// No components inserted — empty table
		const result = await t.query(api.components.list, { type: "agent" });
		expect(result).toHaveProperty("items");
		expect(result).toHaveProperty("nextCursor");
		const { items, nextCursor } = result as { items: unknown[]; nextCursor: string | null };
		expect(items).toEqual([]);
		expect(nextCursor).toBeNull();
	});
});
