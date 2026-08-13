/// <reference types="vite/client" />
//
// pagination-class-sweep-diary.test.ts — TDD-RED for mission k574p02m lot 2.
//
// CLASS: `createdBefore` applied AFTER an unbounded `.take(limit)` instead of
// widening the fetch. convex/diary.ts:151-152 `list` — no wide-scan cap at
// all, mirrors the exact defect lot 1 fixed in convex/profiles.ts.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

type ListDiaryRow = FunctionReturnType<typeof api.diary.list>[number];

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("diary.list pagination — createdBefore applied after unbounded take", () => {
	test("RED/GREEN: paginating to the end must return every seeded diary entry", async () => {
		const t = convexTest(schema, modules);

		// diary.list calls withOrgScope(ctx) fail-closed (no
		// allowNoIdentityMaster) — an anonymous caller resolves to
		// allowedOrchestrators=[] and an `orchestrator`-scoped query returns []
		// immediately. Use the service-account identity (vitest.config.ts sets
		// CLERK_SERVICE_ACCOUNT_USER_ID="test-service-account-user-id",
		// convex/lib/auth.ts:111-121 carve-out), mirroring
		// broadcast-org-scoped.test.ts.
		const tInternal = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const seededDates: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const date = `2026-01-${String(i + 1).padStart(2, "0")}`;
			seededDates.push(date);
			await t.mutation(api.diary.write, {
				date,
				orchestrator: "sigma",
				content: `entry ${i}`,
			});
		}

		const collected: { date: string; _creationTime: number }[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		const MAX_PAGES = 10;

		while (pages < MAX_PAGES) {
			pages++;
			const page: ListDiaryRow[] = await tInternal.query(api.diary.list, {
				orchestrator: "sigma",
				limit: PAGE_LIMIT,
				createdBefore,
			});
			const relevant = page.filter((r: ListDiaryRow) =>
				seededDates.includes(r.date),
			);
			collected.push(
				...relevant.map((r: ListDiaryRow) => ({
					date: r.date,
					_creationTime: r._creationTime,
				})),
			);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			const last: ListDiaryRow = page[page.length - 1];
			createdBefore = last._creationTime;
		}

		const collectedDates = new Set(collected.map((r) => r.date));
		const missing = seededDates.filter((d) => !collectedDates.has(d));

		expect(missing).toEqual([]);
		expect(collectedDates.size).toBe(TOTAL);
	});
});
