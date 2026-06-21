/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// businessUnits.list_bus.test.ts — PR-A TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
// Tests for envelope safety contract:
//   - default limit 20 (not 50)
//   - cap at 200 (reject or clamp > 200)
//   - fields=lite returns only {_id, name, status, orchestratorId, _creationTime}
//   - fields=full returns all buObject keys
//   - cursor-based paging via nextCursor (not createdBefore anchor)
//   - payload size < 25KB for 100 BUs fields=lite
//
// T-GREEN (impl) must: change default to 20, add cap 200, add fields projection,
// change returns shape to { items, nextCursor } with proper paging.
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

function makeBU(overrides: Partial<{
	name: string;
	description: string;
	purpose: string;
	orchestratorId: string;
	status: "idea" | "building" | "live" | "revenue";
	businessModel: string;
	targetCustomers: string;
	services: string[];
	pricing: string;
	revenueProjections: { y1: number; y2: number; y3: number };
	coreTeam: { agents: string[]; skills: string[]; hooks: string[]; plugins: string[] };
	coreProcesses: string[];
	dependencies: string[];
	kpis: string[];
	managementFee: number;
	createdAt: number;
	updatedAt: number;
}> = {}) {
	const now = Date.now();
	return {
		name: overrides.name ?? "Test BU",
		description: overrides.description ?? "Test description",
		purpose: overrides.purpose ?? "Test purpose",
		orchestratorId: overrides.orchestratorId ?? "sigma",
		status: overrides.status ?? ("idea" as const),
		businessModel: overrides.businessModel ?? "SaaS",
		targetCustomers: overrides.targetCustomers ?? "SMBs",
		services: overrides.services ?? ["consulting"],
		pricing: overrides.pricing ?? "$100/mo",
		revenueProjections: overrides.revenueProjections ?? { y1: 10000, y2: 50000, y3: 100000 },
		coreTeam: overrides.coreTeam ?? { agents: [], skills: [], hooks: [], plugins: [] },
		coreProcesses: overrides.coreProcesses ?? [],
		dependencies: overrides.dependencies ?? [],
		kpis: overrides.kpis ?? [],
		managementFee: overrides.managementFee ?? 10,
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
}

describe("list_bus envelope safety (PR-A RED)", () => {
	test("1. list_bus without args returns default limit 20 + nextCursor when >20 BUs exist", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 25; i++) {
				await ctx.db.insert("businessUnits", makeBU({ name: `BU-${i}` }));
			}
		});
		// T-GREEN must change returns shape to { items: buObject[], nextCursor: string | null }
		// and default limit to 20. Current impl returns a flat array with limit=50 → this fails.
		const result = await t.query(api.businessUnits.list, {});
		expect(result).toHaveProperty("items");
		expect(result).toHaveProperty("nextCursor");
		const { items, nextCursor } = result as { items: unknown[]; nextCursor: string | null };
		expect(items.length).toBe(20);
		expect(nextCursor).toBeDefined();
		expect(nextCursor).not.toBeNull();
	});

	test("2. list_bus limit=5 returns 5 items + nextCursor", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert("businessUnits", makeBU({ name: `BU-${i}` }));
			}
		});
		const result = await t.query(api.businessUnits.list, { limit: 5 });
		expect(result).toHaveProperty("items");
		expect(result).toHaveProperty("nextCursor");
		const { items, nextCursor } = result as { items: unknown[]; nextCursor: string | null };
		expect(items.length).toBe(5);
		expect(nextCursor).toBeDefined();
		expect(nextCursor).not.toBeNull();
	});

	test("3. list_bus limit=250 is clamped to 200", async () => {
		const t = convexTest(schema, modules);
		// No BUs needed — cap test only. Expect the call to either throw or silently clamp.
		// T-GREEN MUST clamp to 200 (not throw). Assertion: no throw + items.length <= 200.
		// Current impl accepts 250 → items.length would be 0 (no data) which partially passes,
		// but the returns shape { items, nextCursor } will make the call itself fail (RED).
		let threw = false;
		let result: unknown;
		try {
			result = await t.query(api.businessUnits.list, { limit: 250 });
		} catch {
			threw = true;
		}
		if (!threw) {
			// If it doesn't throw, it must return the envelope shape and items.length <= 200
			expect(result).toHaveProperty("items");
			const { items } = result as { items: unknown[] };
			expect(items.length).toBeLessThanOrEqual(200);
		} else {
			// Throwing on 250 is also acceptable per cap enforcement
			expect(threw).toBe(false); // force RED: T-GREEN must clamp, not throw
		}
	});

	test("4. list_bus fields=lite returns only {_id, name, status, orchestratorId, _creationTime}", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert("businessUnits", makeBU({ name: `BU-${i}` }));
			}
		});
		const result = await t.query(api.businessUnits.list, { fields: "lite" });
		expect(result).toHaveProperty("items");
		const { items } = result as { items: Record<string, unknown>[] };
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) {
			const keys = Object.keys(item).sort();
			expect(keys).toEqual(["_creationTime", "_id", "name", "orchestratorId", "status"].sort());
			// Must NOT include full-object fields
			expect(item).not.toHaveProperty("description");
			expect(item).not.toHaveProperty("purpose");
			expect(item).not.toHaveProperty("businessModel");
			expect(item).not.toHaveProperty("targetCustomers");
			expect(item).not.toHaveProperty("revenueProjections");
			expect(item).not.toHaveProperty("coreTeam");
		}
	});

	test("5. list_bus fields=full returns complete buObject", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert("businessUnits", makeBU({ name: "Full BU" }));
		});
		const result = await t.query(api.businessUnits.list, { fields: "full" });
		expect(result).toHaveProperty("items");
		const { items } = result as { items: Record<string, unknown>[] };
		expect(items.length).toBe(1);
		const item = items[0];
		// All buObject keys must be present
		expect(item).toHaveProperty("_id");
		expect(item).toHaveProperty("_creationTime");
		expect(item).toHaveProperty("name");
		expect(item).toHaveProperty("description");
		expect(item).toHaveProperty("purpose");
		expect(item).toHaveProperty("orchestratorId");
		expect(item).toHaveProperty("status");
		expect(item).toHaveProperty("businessModel");
		expect(item).toHaveProperty("targetCustomers");
		expect(item).toHaveProperty("services");
		expect(item).toHaveProperty("pricing");
		expect(item).toHaveProperty("revenueProjections");
		expect(item).toHaveProperty("coreTeam");
		expect(item).toHaveProperty("coreProcesses");
		expect(item).toHaveProperty("dependencies");
		expect(item).toHaveProperty("kpis");
		expect(item).toHaveProperty("managementFee");
		expect(item).toHaveProperty("createdAt");
		expect(item).toHaveProperty("updatedAt");
	});

	test("6. list_bus cursor=<token> returns next page consistent with prior nextCursor", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert("businessUnits", makeBU({ name: `BU-cursor-${i}` }));
			}
		});
		// First page
		const page1 = await t.query(api.businessUnits.list, { limit: 5 });
		expect(page1).toHaveProperty("items");
		expect(page1).toHaveProperty("nextCursor");
		const { items: items1, nextCursor: cursor1 } = page1 as {
			items: Record<string, unknown>[];
			nextCursor: string | null;
		};
		expect(items1.length).toBe(5);
		expect(cursor1).not.toBeNull();

		// Second page using cursor from first page
		const page2 = await t.query(api.businessUnits.list, { limit: 5, cursor: cursor1! });
		expect(page2).toHaveProperty("items");
		const { items: items2 } = page2 as { items: Record<string, unknown>[] };
		expect(items2.length).toBe(5);

		// Pages must be distinct
		const ids1 = new Set(items1.map((i) => i._id as string));
		const ids2 = new Set(items2.map((i) => i._id as string));
		for (const id of ids2) {
			expect(ids1.has(id)).toBe(false);
		}

		// Combined, they cover exactly 10 BUs
		expect(ids1.size + ids2.size).toBe(10);
	});

	test("7. list_bus payload JSON.stringify size < 25KB for fields=lite with 100 BUs", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 100; i++) {
				await ctx.db.insert("businessUnits", makeBU({ name: `BU-size-${i}` }));
			}
		});
		// Current impl: returns flat array, no fields projection, limit defaults to 50 not 100.
		// T-GREEN must support limit=100 + fields=lite in envelope shape.
		const result = await t.query(api.businessUnits.list, { limit: 100, fields: "lite" });
		expect(result).toHaveProperty("items");
		const { items } = result as { items: unknown[] };
		expect(items.length).toBe(100);
		const payloadSize = JSON.stringify(result).length;
		expect(payloadSize).toBeLessThan(25_000);
	});
});
