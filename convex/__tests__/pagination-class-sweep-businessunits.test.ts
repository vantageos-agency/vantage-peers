/// <reference types="vite/client" />
//
// pagination-class-sweep-businessunits.test.ts — TDD-RED for mission
// k574p02m lot 2. CLASS: cursor-anchor pagination bounded by a FIXED
// multiplier (`limit * 4 + 10`) instead of a wide-scan cap. Each fresh
// `.take(fetchLimit)` re-reads only the TOP `fetchLimit` rows of the whole
// ordering; once the cursor anchor's true position exceeds that fixed
// window, the anchor is never found, `pastAnchor` never flips, and every
// row is filtered out — an empty page before the true end.
// convex/businessUnits.ts:255-345 `list`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

type BuRow = { _id: string; _creationTime: number; name: string };

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("businessUnits.list cursor pagination — fixed-buffer fetchLimit undershoots deep pages", () => {
	test("RED/GREEN: paginating to the end must return every seeded business unit", async () => {
		const t = convexTest(schema, modules);
		// Default page limit is 20, fetchLimit with cursor = limit*4+10 = 90.
		// Seed well beyond that so a deep-enough cursor's true position
		// exceeds the fixed re-fetch window.
		const TOTAL = 130;
		const seededIds: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const id: string = await t.mutation(api.businessUnits.create, {
				name: `sweep-bu-${i}`,
				description: "d",
				purpose: "p",
				orchestratorId: "sigma",
				status: "idea",
				businessModel: "m",
				targetCustomers: "c",
				services: [],
				pricing: "free",
				revenueProjections: { y1: 0, y2: 0, y3: 0 },
				coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
				coreProcesses: [],
				dependencies: [],
				kpis: [],
			});
			seededIds.push(id);
		}

		const collected: BuRow[] = [];
		let cursor: string | null = null;
		let pages = 0;
		while (pages < 20) {
			pages++;
			const page: { items: BuRow[]; nextCursor: string | null } = await t.query(
				api.businessUnits.list,
				{ cursor: cursor ?? undefined },
			);
			collected.push(...page.items);
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}

		const collectedIds = new Set(collected.map((r) => r._id));
		const missing = seededIds.filter((id) => !collectedIds.has(id));
		expect(missing).toEqual([]);
		expect(collectedIds.size).toBe(TOTAL);
	});
});
