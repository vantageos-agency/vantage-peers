/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Load all modules except those that require external services.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

function createTestConvex() {
	// orchestratorStats is gated by withOrgScope.
	// All stats tests use master scope (no org attached → full access).
	return convexTest(schema, modules).withIdentity({ subject: "user-test-master" });
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

type TaskStatus = "todo" | "in_progress" | "review" | "blocked" | "done";
type TaskPriority = "urgent" | "high" | "medium" | "low";

interface SeedTask {
	title?: string;
	assignedTo: string;
	status: TaskStatus;
	priority?: TaskPriority;
	completedAt?: number;
	startedAt?: number;
	updatedAt?: number;
}

const NOW = Date.now();
const H = 3_600_000; // 1 hour in ms
const D = 86_400_000; // 1 day in ms

async function seedTask(
	t: ReturnType<typeof createTestConvex>,
	task: SeedTask,
) {
	// We use the mutation directly and then patch optional timing fields.
	const taskId = await t.mutation(api.tasks.create, {
		title: task.title ?? "Seed task",
		assignedTo: task.assignedTo,
		status: task.status,
		priority: task.priority ?? "medium",
		createdBy: "system",
	});

	// Patch timing fields that create cannot accept (they are set server-side).
	const patch: Record<string, number | undefined> = {};
	if (task.completedAt !== undefined) patch.completedAt = task.completedAt;
	if (task.startedAt !== undefined) patch.startedAt = task.startedAt;
	if (task.updatedAt !== undefined) patch.updatedAt = task.updatedAt;

	if (Object.keys(patch).length > 0) {
		await t.run(async (ctx) => {
			await ctx.db.patch(taskId, patch);
		});
	}

	return taskId;
}

// =============================================================================
// 1. Empty tasks table
// =============================================================================

describe("orchestratorStats — empty table", () => {
	test("returns empty array when no tasks exist", async () => {
		const t = createTestConvex();
		const result = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(result).toEqual([]);
	});

	test("returns empty for all window values", async () => {
		const t = createTestConvex();
		const r24h = await t.query(api.stats.orchestratorStats, { window: "24h" });
		const r7d = await t.query(api.stats.orchestratorStats, { window: "7d" });
		const r30d = await t.query(api.stats.orchestratorStats, { window: "30d" });
		expect(r24h).toEqual([]);
		expect(r7d).toEqual([]);
		expect(r30d).toEqual([]);
	});
});

// =============================================================================
// 2. Single orchestrator
// =============================================================================

describe("orchestratorStats — single orchestrator", () => {
	test("returns one entry with correct orchestratorId", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "todo" });

		const result = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(result).toHaveLength(1);
		expect(result[0].orchestratorId).toBe("kappa");
	});

	test("queueSize counts only todo tasks", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "todo" });
		await seedTask(t, { assignedTo: "kappa", status: "todo" });
		await seedTask(t, { assignedTo: "kappa", status: "in_progress" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stat.queueSize).toBe(2);
	});

	test("blockerCount counts only blocked tasks", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "blocked" });
		await seedTask(t, { assignedTo: "kappa", status: "blocked" });
		await seedTask(t, { assignedTo: "kappa", status: "todo" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stat.blockerCount).toBe(2);
	});

	test("completionRate: 50% when half tasks are done", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "done" });
		await seedTask(t, { assignedTo: "kappa", status: "done" });
		await seedTask(t, { assignedTo: "kappa", status: "todo" });
		await seedTask(t, { assignedTo: "kappa", status: "in_progress" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stat.completionRate).toBe(50);
	});

	test("completionRate: 0 when no tasks are done", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "todo" });
		await seedTask(t, { assignedTo: "kappa", status: "in_progress" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stat.completionRate).toBe(0);
	});

	test("completionRate: 100 when all tasks are done", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "done" });
		await seedTask(t, { assignedTo: "kappa", status: "done" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stat.completionRate).toBe(100);
	});

	test("staleHours is 0 when no in_progress tasks", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "todo" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stat.staleHours).toBe(0);
	});

	test("staleHours uses startedAt when present", async () => {
		const t = createTestConvex();
		await seedTask(t, {
			assignedTo: "kappa",
			status: "in_progress",
			startedAt: NOW - 10 * H,
			updatedAt: NOW,
		});

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stat.staleHours).toBe(10);
	});

	test("staleHours returns max across multiple in_progress tasks", async () => {
		const t = createTestConvex();
		await seedTask(t, {
			assignedTo: "kappa",
			status: "in_progress",
			startedAt: NOW - 48 * H,
			updatedAt: NOW,
		});
		await seedTask(t, {
			assignedTo: "kappa",
			status: "in_progress",
			startedAt: NOW - 2 * H,
			updatedAt: NOW,
		});

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stat.staleHours).toBe(48);
	});

	test("throughputByDay has 7 entries for 7d window", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "todo" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(stat.throughputByDay).toHaveLength(7);
	});

	test("throughputByDay has 1 entry for 24h window", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "todo" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "24h",
		});
		expect(stat.throughputByDay).toHaveLength(1);
	});

	test("throughputByDay has 30 entries for 30d window", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "todo" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "30d",
		});
		expect(stat.throughputByDay).toHaveLength(30);
	});

	test("throughputByDay counts done task completed within window", async () => {
		const t = createTestConvex();
		await seedTask(t, {
			assignedTo: "kappa",
			status: "done",
			completedAt: NOW - H, // 1h ago — within 7d window
			updatedAt: NOW - H,
		});

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		const total = stat.throughputByDay.reduce((s, d) => s + d.count, 0);
		expect(total).toBe(1);
	});

	test("throughputByDay excludes done task outside window", async () => {
		const t = createTestConvex();
		await seedTask(t, {
			assignedTo: "kappa",
			status: "done",
			completedAt: NOW - 10 * D, // 10 days ago — outside 7d window
			updatedAt: NOW - 10 * D,
		});

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		const total = stat.throughputByDay.reduce((s, d) => s + d.count, 0);
		expect(total).toBe(0);
	});

	test("throughputByDay days are in ascending chronological order", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "todo" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		const days = stat.throughputByDay.map((d) => d.day);
		expect(days).toEqual([...days].sort());
	});
});

// =============================================================================
// 3. Multiple orchestrators
// =============================================================================

describe("orchestratorStats — multiple orchestrators", () => {
	test("returns one entry per orchestrator that has tasks", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "todo" });
		await seedTask(t, { assignedTo: "sigma", status: "done" });
		await seedTask(t, { assignedTo: "pi", status: "in_progress" });

		const result = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		const ids = result.map((r) => r.orchestratorId).sort();
		expect(ids).toEqual(["kappa", "pi", "sigma"]);
	});

	test("stats are isolated per orchestrator", async () => {
		const t = createTestConvex();
		await seedTask(t, { assignedTo: "kappa", status: "done" });
		await seedTask(t, { assignedTo: "kappa", status: "done" });
		await seedTask(t, { assignedTo: "sigma", status: "todo" });
		await seedTask(t, { assignedTo: "sigma", status: "blocked" });

		const result = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		const kappa = result.find((r) => r.orchestratorId === "kappa");
		const sigma = result.find((r) => r.orchestratorId === "sigma");

		expect(kappa).toBeDefined();
		expect(sigma).toBeDefined();
		expect(kappa!.completionRate).toBe(100);
		expect(kappa!.blockerCount).toBe(0);
		expect(sigma!.completionRate).toBe(0);
		expect(sigma!.blockerCount).toBe(1);
		expect(sigma!.queueSize).toBe(1);
	});

	test("orchestrator with no tasks does not appear in results", async () => {
		const t = createTestConvex();
		// Only kappa has tasks — sigma has none
		await seedTask(t, { assignedTo: "kappa", status: "todo" });

		const result = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		const sigmaEntry = result.find((r) => r.orchestratorId === "sigma");
		expect(sigmaEntry).toBeUndefined();
	});
});

// =============================================================================
// 4. Window variants
// =============================================================================

describe("orchestratorStats — window variants", () => {
	test("24h window: task completed 1h ago appears in throughput", async () => {
		// Note: the 24h window produces a single-entry series for today's ISO date.
		// A task completed 23h ago might fall on yesterday's date depending on UTC
		// clock position, so we use 1h ago (same UTC day as now) to avoid flakiness.
		const t = createTestConvex();
		await seedTask(t, {
			assignedTo: "kappa",
			status: "done",
			completedAt: NOW - H,
			updatedAt: NOW - H,
		});

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "24h",
		});
		const total = stat.throughputByDay.reduce((s, d) => s + d.count, 0);
		expect(total).toBe(1);
	});

	test("24h window: task completed 25h ago does NOT appear in throughput", async () => {
		const t = createTestConvex();
		await seedTask(t, {
			assignedTo: "kappa",
			status: "done",
			completedAt: NOW - 25 * H,
			updatedAt: NOW - 25 * H,
		});

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "24h",
		});
		const total = stat.throughputByDay.reduce((s, d) => s + d.count, 0);
		expect(total).toBe(0);
	});

	test("30d window: task completed 29 days ago appears in throughput", async () => {
		const t = createTestConvex();
		await seedTask(t, {
			assignedTo: "kappa",
			status: "done",
			completedAt: NOW - 29 * D,
			updatedAt: NOW - 29 * D,
		});

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "30d",
		});
		const total = stat.throughputByDay.reduce((s, d) => s + d.count, 0);
		expect(total).toBe(1);
	});

	test("completionRate uses all-time task history regardless of window", async () => {
		const t = createTestConvex();
		// Done 60 days ago — outside any window
		await seedTask(t, {
			assignedTo: "kappa",
			status: "done",
			completedAt: NOW - 60 * D,
			updatedAt: NOW - 60 * D,
		});
		await seedTask(t, { assignedTo: "kappa", status: "todo" });

		const [stat] = await t.query(api.stats.orchestratorStats, {
			window: "7d",
		});
		// 1 done out of 2 total = 50%
		expect(stat.completionRate).toBe(50);
	});
});
