/// <reference types="vite/client" />
//
// pagination-class-sweep-components.test.ts — TDD-RED for mission k574p02m
// lot 2. CLASS: cursor-anchor pagination bounded by a FIXED multiplier
// (`limit * 4 + 10`) instead of a wide-scan cap — same defect shape as
// businessUnits.list. convex/components.ts:129-219 `list`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

type ComponentRow = { _id: string; _creationTime: number; name: string };

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("components.list cursor pagination — fixed-buffer fetchLimit undershoots deep pages", () => {
	test("RED/GREEN: paginating to the end must return every seeded component", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 130;
		const seededIds: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const result: { componentId: string; created: boolean } = await t.mutation(
				api.components.register,
				{
					name: `sweep-component-${i}`,
					type: "skill",
					content: "content",
					createdBy: "sigma",
				},
			);
			seededIds.push(result.componentId);
		}

		const collected: ComponentRow[] = [];
		let cursor: string | null = null;
		let pages = 0;
		while (pages < 20) {
			pages++;
			const page: { items: ComponentRow[]; nextCursor: string | null } = await t.query(
				api.components.list,
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

	// mission k574p02m lot 2 — Eta REVISE. The fetchLimit widening was gated
	// on `cursorPayload` only. The LEGACY `createdBefore` back-compat path
	// (no cursor arg) still falls through to `limit + 1` (narrow).
	test("RED/GREEN: legacy createdBefore pagination must return every seeded component", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 130;
		const seededIds: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const result: { componentId: string; created: boolean } = await t.mutation(
				api.components.register,
				{
					name: `sweep-component-legacy-${i}`,
					type: "skill",
					content: "content",
					createdBy: "sigma",
				},
			);
			seededIds.push(result.componentId);
		}

		const collected: ComponentRow[] = [];
		let createdBefore: number | undefined;
		let pages = 0;
		while (pages < 20) {
			pages++;
			const page: { items: ComponentRow[] } = await t.query(api.components.list, {
				createdBefore,
			});
			if (page.items.length === 0) break;
			collected.push(...page.items);
			createdBefore = page.items[page.items.length - 1]._creationTime;
		}

		const collectedIds = new Set(collected.map((r) => r._id));
		const missing = seededIds.filter((id) => !collectedIds.has(id));
		expect(missing).toEqual([]);
		expect(collectedIds.size).toBe(TOTAL);
	});
});
