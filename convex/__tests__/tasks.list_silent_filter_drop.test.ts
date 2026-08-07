/// <reference types="vite/client" />
//
// tasks.list_silent_filter_drop.test.ts — TDD-RED for the silent-filter-drop
// defect in convex/tasks.ts `list`.
// ─────────────────────────────────────────────────────────────────────────────
//
// DEFECT (measured on the live deployment, reproduced here against unmodified
// code): `list` picks exactly ONE index via an if/else-if chain
// (by_instance > by_assignee > by_project > by_status). Any other
// caller-supplied filter (assignedTo, assignedToInstance, project) that is
// not covered by the chosen index is READ into a local const and then
// discarded — never applied. The caller receives a result that is silently
// BROADER than the question asked, and (worse) a full page + nextCursor,
// making an incomplete/mismatched result look complete.
//
// FIX under test: every branch either applies ALL caller-supplied
// index-backed filters (via a matching compound index — by_assignee_project,
// by_instance_project) or refuses the call with a clear error naming the
// unsupported combination (assignedToInstance + assignedTo together).
//
// Fictitious identifiers only — no real client names.
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

type TaskRow = Record<string, unknown>;

interface TaskSeed {
	title: string;
	assignedTo: string;
	assignedToInstance?: string;
	priority: "urgent" | "high" | "medium" | "low";
	status: "todo" | "in_progress" | "review" | "blocked" | "done";
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	project?: string;
}

function makeTask(overrides: Partial<TaskSeed> = {}): TaskSeed {
	const now = Date.now();
	return {
		title: overrides.title ?? "Fixture task",
		assignedTo: overrides.assignedTo ?? "test-orch-tau",
		priority: overrides.priority ?? "medium",
		status: overrides.status ?? "todo",
		createdBy: overrides.createdBy ?? "test-orch-tau",
		createdAt: now,
		updatedAt: now,
		...(overrides.assignedToInstance !== undefined
			? { assignedToInstance: overrides.assignedToInstance }
			: {}),
		...(overrides.project !== undefined ? { project: overrides.project } : {}),
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedTaskRows(ctx: any): Promise<void> {
	// 5 rows: assignedTo=test-orch-tau, status=todo, project=fixture-project-real
	// (positive control: these must be returned when queried by project alone
	// or by assignedTo+status+project).
	for (let i = 0; i < 5; i++) {
		await ctx.db.insert(
			"tasks",
			makeTask({
				title: `Real project task ${i}`,
				assignedTo: "test-orch-tau",
				status: "todo",
				project: "fixture-project-real",
			}) as never,
		);
	}
	// Instance-scoped mirror of the same shape. assignedTo is set to a
	// DIFFERENT value than the assignee-scoped rows above so the two groups
	// stay disjoint under an assignedTo filter.
	for (let i = 0; i < 5; i++) {
		await ctx.db.insert(
			"tasks",
			makeTask({
				title: `Real instance-project task ${i}`,
				assignedTo: "test-orch-unassigned",
				assignedToInstance: "test-instance-tau-laptop",
				status: "todo",
				project: "fixture-project-real",
			}) as never,
		);
	}
	// Extra rows for the same assignee/instance but a DIFFERENT project, so a
	// project filter that is silently dropped would still find rows to return.
	for (let i = 0; i < 8; i++) {
		await ctx.db.insert(
			"tasks",
			makeTask({
				title: `Other project task ${i}`,
				assignedTo: "test-orch-tau",
				assignedToInstance: "test-instance-tau-laptop",
				status: "todo",
				project: "fixture-project-other",
			}) as never,
		);
	}
}

function extractItems(result: unknown): TaskRow[] {
	if (Array.isArray(result)) return result as TaskRow[];
	if (result !== null && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (Array.isArray(r.items)) return r.items as TaskRow[];
	}
	return [];
}

describe("tasks.list — silent filter drop (RED before fix, GREEN after)", () => {
	// ── Negative controls (DECISIVE) ────────────────────────────────────────────

	test("N1: assignedTo + project=<nonexistent> must return 0 rows (not silently drop project)", async () => {
		const t = convexTest(schema, modules);
		await t.run(seedTaskRows);

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
			assignedTo: "test-orch-tau",
			status: ["todo"],
			project: "__nonexistent-fixture-slug__",
			limit: 5,
			fields: "full",
		});
		const items = extractItems(result);
		expect(items.length).toBe(0);
	});

	test("N2: assignedToInstance + project=<nonexistent> must return 0 rows (not silently drop project)", async () => {
		const t = convexTest(schema, modules);
		await t.run(seedTaskRows);

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
			assignedToInstance: "test-instance-tau-laptop",
			status: ["todo"],
			project: "__nonexistent-fixture-slug__",
			limit: 5,
			fields: "full",
		});
		const items = extractItems(result);
		expect(items.length).toBe(0);
	});

	// ── Positive controls (no false positives introduced by the fix) ───────────

	test("P1: project alone keeps working", async () => {
		const t = convexTest(schema, modules);
		await t.run(seedTaskRows);

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
			project: "fixture-project-real",
			limit: 20,
			fields: "full",
		});
		const items = extractItems(result);
		expect(items.length).toBe(10); // 5 assignee rows + 5 instance rows
		expect(items.every((r) => r.project === "fixture-project-real")).toBe(true);
	});

	test("P2: assignedTo + status keeps working", async () => {
		const t = convexTest(schema, modules);
		await t.run(seedTaskRows);

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
			assignedTo: "test-orch-tau",
			status: ["todo"],
			limit: 20,
			fields: "full",
		});
		const items = extractItems(result);
		// 5 real-project rows + 8 other-project rows assigned to test-orch-tau
		expect(items.length).toBe(13);
		expect(items.every((r) => r.assignedTo === "test-orch-tau")).toBe(true);
	});

	test("P3: project + status keeps working", async () => {
		const t = convexTest(schema, modules);
		await t.run(seedTaskRows);

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
			project: "fixture-project-other",
			status: ["todo"],
			limit: 20,
			fields: "full",
		});
		const items = extractItems(result);
		expect(items.length).toBe(8);
		expect(items.every((r) => r.project === "fixture-project-other")).toBe(true);
	});

	// ── Combined filter now applies BOTH constraints correctly ──────────────────

	test("C1: assignedTo + project=<real> returns only matching rows, all filters honored", async () => {
		const t = convexTest(schema, modules);
		await t.run(seedTaskRows);

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
			assignedTo: "test-orch-tau",
			project: "fixture-project-real",
			status: ["todo"],
			limit: 20,
			fields: "full",
		});
		const items = extractItems(result);
		expect(items.length).toBe(5);
		expect(
			items.every(
				(r) => r.assignedTo === "test-orch-tau" && r.project === "fixture-project-real",
			),
		).toBe(true);
	});

	test("C2: assignedToInstance + project=<real> returns only matching rows, all filters honored", async () => {
		const t = convexTest(schema, modules);
		await t.run(seedTaskRows);

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
			assignedToInstance: "test-instance-tau-laptop",
			project: "fixture-project-real",
			status: ["todo"],
			limit: 20,
			fields: "full",
		});
		const items = extractItems(result);
		expect(items.length).toBe(5);
		expect(
			items.every(
				(r) =>
					r.assignedToInstance === "test-instance-tau-laptop" &&
					r.project === "fixture-project-real",
			),
		).toBe(true);
	});

	// ── Unsupported combo must refuse loudly, never silently pick one side ─────

	test("R1: assignedToInstance + assignedTo together is refused with a clear error, not silently resolved", async () => {
		const t = convexTest(schema, modules);
		await t.run(seedTaskRows);

		await expect(
			t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
				assignedToInstance: "test-instance-tau-laptop",
				assignedTo: "test-orch-tau",
				limit: 5,
			}),
		).rejects.toThrow(/assignedToInstance.*assignedTo|assignedTo.*assignedToInstance/i);
	});

	// ── Truncation-signal case: a filtered result never masquerades as complete ─

	test("T1: a full-limit page of a narrower filter must not be confused with the broader unfiltered count", async () => {
		const t = convexTest(schema, modules);
		await t.run(seedTaskRows);

		// Broader query (assignedTo alone, no project): 13 rows exist.
		const broad = extractItems(
			await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
				assignedTo: "test-orch-tau",
				status: ["todo"],
				limit: 20,
				fields: "full",
			}),
		);
		expect(broad.length).toBe(13);

		// Narrower query (assignedTo + project=fixture-project-real): only 5 rows
		// exist and must be exactly 5 — never the broad count, and never padded
		// out to `limit` with rows that don't match project.
		const narrow = extractItems(
			await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
				assignedTo: "test-orch-tau",
				project: "fixture-project-real",
				status: ["todo"],
				limit: 20,
				fields: "full",
			}),
		);
		expect(narrow.length).toBe(5);
		expect(narrow.every((r) => r.project === "fixture-project-real")).toBe(true);
	});
});
