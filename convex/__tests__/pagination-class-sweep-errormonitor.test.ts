/// <reference types="vite/client" />
//
// pagination-class-sweep-errormonitor.test.ts — TDD-RED for mission k574p02m
// lot 2. CLASS: `createdBefore` applied AFTER an unbounded `.take(limit)`.
// convex/errorMonitor.ts:517-535 `listErrors`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

type ListErrorsRow = FunctionReturnType<typeof api.errorMonitor.listErrors>[number];

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("errorMonitor.listErrors pagination — createdBefore applied after unbounded take", () => {
	test("RED/GREEN: paginating to the end must return every seeded error hash", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const seededHashes: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const hash = `sweep-hash-${i}`;
			seededHashes.push(hash);
			await t.mutation(internal.errorMonitor.upsertError, {
				hash,
				deployment: "sweep-deploy",
				functionName: "handler",
				errorMessage: "boom",
				githubRepo: "org/repo",
				orchestrator: "sigma",
			});
		}

		const collected: { hash: string; _creationTime: number }[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const page: ListErrorsRow[] = await t.query(api.errorMonitor.listErrors, {
				limit: PAGE_LIMIT,
				createdBefore,
			});
			const relevant = page.filter((r) => seededHashes.includes(r.hash));
			collected.push(
				...relevant.map((r) => ({ hash: r.hash, _creationTime: r._creationTime })),
			);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			createdBefore = page[page.length - 1]._creationTime;
		}

		const collectedHashes = new Set(collected.map((r) => r.hash));
		const missing = seededHashes.filter((h) => !collectedHashes.has(h));
		expect(missing).toEqual([]);
		expect(collectedHashes.size).toBe(TOTAL);
	});
});
