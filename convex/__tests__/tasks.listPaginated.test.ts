/// <reference types="vite/client" />
/**
 * convex/__tests__/tasks.listPaginated.test.ts
 *
 * Day 116 B1 — regression suite for the dashboard `tasks:list` Server Error.
 *
 * Root cause: the dashboard TaskBoard calls
 *   usePaginatedQuery(api.tasks.list, { status, priority, orgId }, { initialNumItems: 50 })
 * which injects `paginationOpts` into the args. Because `tasks.list` did not
 * declare `paginationOpts` in its args validator, Convex threw
 * `ArgumentValidationError: unexpected field "paginationOpts"` → "Server Error".
 * Additionally `priority` and `orgId` were undeclared extra fields.
 *
 * Fix: new dedicated `tasks.listPaginated` query that:
 *   - accepts paginationOptsValidator (required, for usePaginatedQuery)
 *   - accepts status (single enum), assignedTo, priority, orgId
 *   - uses .paginate() and returns { page, isDone, continueCursor }
 *   - applies multi-tenant org scoping via withOrgScope (Clerk JWT)
 *
 * Coverage:
 *   T1  listPaginated — no filters → page + isDone + continueCursor shape
 *   T2  listPaginated status=blocked → only blocked tasks in page
 *   T3  listPaginated priority=urgent → only urgent tasks in page
 *   T4  listPaginated assignedTo=sigma → only sigma's tasks
 *   T5  listPaginated assignedTo=sigma + status=blocked → intersection
 *   T6  listPaginated orgId=ignored → accepted without ArgumentValidationError
 *   T7  tasks.list priority=high + orgId=novalayer → accepted without ArgValidationError
 *   T8  tasks.list priority filter — returns only matching priority
 */

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

// Minimal paginationOpts injected by usePaginatedQuery for first page.
const PAGE_OPTS = { numItems: 50, cursor: null };

// ─── Seed helpers ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedTask(ctx: any, overrides: Record<string, unknown> = {}): Promise<string> {
	const now = Date.now();
	return await ctx.db.insert("tasks", {
		title: "Test task",
		assignedTo: "sigma",
		priority: "medium" as const,
		status: "todo" as const,
		createdBy: "sigma",
		createdAt: now,
		updatedAt: now,
		...overrides,
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("tasks.listPaginated — Day 116 B1 dashboard fix", () => {

	// ── T1: no filters → PaginationResult shape ──────────────────────────────
	test("T1: listPaginated returns { page, isDone, continueCursor } shape", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "Task A" });
			await seedTask(ctx, { title: "Task B" });
		});

		const result = await t.query(api.tasks.listPaginated, {
			paginationOpts: PAGE_OPTS,
		});

		// Must be a PaginationResult, not a plain array.
		expect(result).toHaveProperty("page");
		expect(result).toHaveProperty("isDone");
		expect(result).toHaveProperty("continueCursor");
		expect(Array.isArray(result.page)).toBe(true);
		expect(result.page.length).toBe(2);
		expect(typeof result.isDone).toBe("boolean");
		expect(typeof result.continueCursor).toBe("string");
	});

	// ── T2: status=blocked filter ─────────────────────────────────────────────
	test("T2: listPaginated status=blocked returns only blocked tasks", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "Blocked task", status: "blocked" });
			await seedTask(ctx, { title: "Active task", status: "in_progress" });
			await seedTask(ctx, { title: "Done task", status: "done" });
		});

		const result = await t.query(api.tasks.listPaginated, {
			paginationOpts: PAGE_OPTS,
			status: "blocked",
		});

		expect(result.page.length).toBe(1);
		expect(result.page[0].title).toBe("Blocked task");
		expect(result.page[0].status).toBe("blocked");
	});

	// ── T3: priority=urgent filter ────────────────────────────────────────────
	test("T3: listPaginated priority=urgent returns only urgent tasks", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "Urgent task", priority: "urgent" });
			await seedTask(ctx, { title: "High task", priority: "high" });
			await seedTask(ctx, { title: "Medium task", priority: "medium" });
		});

		const result = await t.query(api.tasks.listPaginated, {
			paginationOpts: PAGE_OPTS,
			priority: "urgent",
		});

		expect(result.page.length).toBe(1);
		expect(result.page[0].title).toBe("Urgent task");
		expect(result.page[0].priority).toBe("urgent");
	});

	// ── T4: assignedTo filter ─────────────────────────────────────────────────
	test("T4: listPaginated assignedTo=sigma returns only sigma tasks", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "Sigma task", assignedTo: "sigma" });
			await seedTask(ctx, { title: "Pi task", assignedTo: "pi" });
		});

		const result = await t.query(api.tasks.listPaginated, {
			paginationOpts: PAGE_OPTS,
			assignedTo: "sigma",
		});

		expect(result.page.length).toBe(1);
		expect(result.page[0].assignedTo).toBe("sigma");
	});

	// ── T5: assignedTo + status compound filter ───────────────────────────────
	test("T5: listPaginated assignedTo=sigma + status=blocked → intersection", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "Sigma blocked", assignedTo: "sigma", status: "blocked" });
			await seedTask(ctx, { title: "Sigma done", assignedTo: "sigma", status: "done" });
			await seedTask(ctx, { title: "Pi blocked", assignedTo: "pi", status: "blocked" });
		});

		const result = await t.query(api.tasks.listPaginated, {
			paginationOpts: PAGE_OPTS,
			assignedTo: "sigma",
			status: "blocked",
		});

		expect(result.page.length).toBe(1);
		expect(result.page[0].title).toBe("Sigma blocked");
	});

	// ── T6: orgId passthrough ─────────────────────────────────────────────────
	test("T6: listPaginated accepts orgId without ArgumentValidationError", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "Org task" });
		});

		// Must not throw — orgId is accepted as a passthrough arg.
		const result = await t.query(api.tasks.listPaginated, {
			paginationOpts: PAGE_OPTS,
			orgId: "novalayer",
		});

		// Server-side withOrgScope (no Clerk JWT in tests = master) → all rows visible.
		expect(result.page.length).toBe(1);
	});
});

describe("tasks.list — Day 116 B1 arg extension (priority + orgId)", () => {

	// ── T7: priority + orgId accepted ────────────────────────────────────────
	test("T7: tasks.list accepts priority and orgId without ArgumentValidationError", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "High task", priority: "high" });
			await seedTask(ctx, { title: "Medium task", priority: "medium" });
		});

		// Must not throw ArgumentValidationError on extra fields.
		const result = await t.query(api.tasks.list, {
			priority: "high",
			orgId: "novalayer",
			fields: "lite",
		});

		expect(Array.isArray(result)).toBe(true);
	});

	// ── T8: tasks.list priority filter works end-to-end ──────────────────────
	test("T8: tasks.list priority=urgent returns only urgent tasks", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "Urgent", priority: "urgent" });
			await seedTask(ctx, { title: "High", priority: "high" });
			await seedTask(ctx, { title: "Low", priority: "low" });
		});

		const result = await t.query(api.tasks.list, {
			priority: "urgent",
			limit: 50,
		}) as Array<Record<string, unknown>>;

		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(1);
		expect(result[0].priority).toBe("urgent");
		expect(result[0].title).toBe("Urgent");
	});
});
