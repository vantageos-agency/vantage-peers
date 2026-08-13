/// <reference types="vite/client" />
//
// pagination-class-sweep-recurringtasks.test.ts — TDD-RED for mission
// k574p02m lot 2. CLASS: `createdBefore` applied AFTER an unbounded
// `.take(limit)`. convex/recurringTasks.ts:128-167 `list`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

type ListRecurringTaskRow = FunctionReturnType<
	typeof api.recurringTasks.list
>[number];

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("recurringTasks.list pagination — createdBefore applied after unbounded take", () => {
	test("RED/GREEN: paginating to the end must return every seeded recurring task", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const assignedTo = "sweep-assignee";
		const seededIds: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const id: string = await t.mutation(api.recurringTasks.create, {
				title: `sweep recurring ${i}`,
				assignedTo,
				priority: "medium",
				cronExpression: "0 9 * * *",
				createdBy: "sigma",
			});
			seededIds.push(id);
		}

		const collected: { _id: string; _creationTime: number }[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const page: ListRecurringTaskRow[] = await t.query(api.recurringTasks.list, {
				assignedTo,
				limit: PAGE_LIMIT,
				createdBefore,
			});
			collected.push(
				...page.map((r) => ({ _id: r._id, _creationTime: r._creationTime })),
			);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			createdBefore = page[page.length - 1]._creationTime;
		}

		const collectedIds = new Set(collected.map((r) => r._id));
		const missing = seededIds.filter((id) => !collectedIds.has(id));
		expect(missing).toEqual([]);
		expect(collectedIds.size).toBe(TOTAL);
	});
});
