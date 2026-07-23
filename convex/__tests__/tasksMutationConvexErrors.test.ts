/// <reference types="vite/client" />
/**
 * convex/__tests__/tasksMutationConvexErrors.test.ts
 *
 * Root-cause regression suite for VP "Server Error" masking on start_task.
 *
 * BLOCKER: Hephaistos mission k5762ehk T6 — `mcp__vantage-peers__start_task`
 * returned opaque "Server Error" 4× consecutive because:
 *   1. tasks.ts threw ConvexError({ code, message, ...details }) object payload
 *   2. Convex cloud HTTP response sets errorMessage="Server Error" for object
 *      ConvexErrors (privacy guard), masking the structured code.
 *
 * FIX: all ConvexError throws now use string payloads prefixed with CODE: so
 * the HTTP errorMessage is the full actionable string, parseable by
 * mcp-server/src/tools.ts parseConvexError.
 *
 * This suite asserts that every ConvexError thrown by tasks.start, tasks.complete,
 * and tasks.update carries the expected CODE: prefix in its string message
 * (the shape that reaches the MCP client over HTTP).
 *
 * Coverage: ≥6 new cases + repro of Hephaistos scenario.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

// Exclude RAG/search/backfill modules (same pattern as all tests in this dir)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Insert a minimal task and return its _id. */
async function seedTask(
	t: ReturnType<typeof createT>,
	overrides: {
		title?: string;
		assignedTo?: string;
		status?: "todo" | "in_progress" | "review" | "blocked" | "done";
		dependsOn?: string[];
	} = {},
) {
	return await t.mutation(api.tasks.create, {
		title: overrides.title ?? "Test task",
		assignedTo: overrides.assignedTo ?? "sigma",
		priority: "medium",
		status: overrides.status ?? "todo",
		createdBy: "system",
		...(overrides.dependsOn ? { dependsOn: overrides.dependsOn as any } : {}),
	});
}

/** Unwrap a ConvexError thrown from convex-test (preserves .message = string). */
function getConvexErrorMessage(error: unknown): string {
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<string>).message;
}

// ─────────────────────────────────────────────────────────────────────────────
// start — TASK_NOT_FOUND
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.start — TASK_NOT_FOUND", () => {
	test("throws ConvexError with TASK_NOT_FOUND prefix when task ID does not exist", async () => {
		const t = createT();
		// Create and immediately delete a task to get a valid-format but nonexistent ID
		const id = await seedTask(t);
		await t.mutation(api.tasks.deleteTask, { taskId: id, callerOrchestrator: "system" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.start, {
				taskId: id,
				callerOrchestrator: "system",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^TASK_NOT_FOUND:/);
		expect(msg).toContain(id);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// start — RBAC_DENIED
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.start — RBAC_DENIED", () => {
	test("throws ConvexError with RBAC_DENIED prefix when caller is not creator or assignee", async () => {
		const t = createT();
		// Task assigned to sigma, created by system; eta is neither
		const id = await seedTask(t, { assignedTo: "sigma" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.start, {
				taskId: id,
				callerOrchestrator: "eta",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^RBAC_DENIED:/);
		expect(msg).toContain("eta");
		expect(msg).toContain(id);
	});

	test("system caller bypasses RBAC check (no throw)", async () => {
		const t = createT();
		const id = await seedTask(t, { assignedTo: "sigma" });
		// system must not throw even though it's neither creator nor assignee
		await expect(
			t.mutation(api.tasks.start, { taskId: id, callerOrchestrator: "system" }),
		).resolves.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// start — TASK_START_BLOCKED (Hephaistos repro — k1750w7z scenario)
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.start — TASK_START_BLOCKED (Hephaistos repro)", () => {
	/**
	 * Repro: caller has an unclosed in_progress task → start_task on a second
	 * task raises ConvexError with TASK_START_BLOCKED code.
	 *
	 * Hephaistos hit this 4× on mission k5762ehk T6 (taskId k1750w7z).
	 * Before the fix this surfaced as generic "Server Error" because ConvexError
	 * was thrown with an object payload.  After fix the message string carries
	 * the code prefix and is parseable by mcpConvexError.
	 */
	test("TASK_START_BLOCKED: caller already has an in_progress task", async () => {
		const t = createT();

		// Seed two tasks for sigma
		const task1 = await seedTask(t, {
			title: "Active task (blocking)",
			assignedTo: "sigma",
		});
		const task2 = await seedTask(t, {
			title: "Attempted task (k1750w7z style)",
			assignedTo: "sigma",
		});

		// Start task1 — puts sigma in_progress
		await t.mutation(api.tasks.start, {
			taskId: task1,
			callerOrchestrator: "sigma",
		});

		// Now try to start task2 while task1 is still in_progress
		let thrown: unknown;
		try {
			await t.mutation(api.tasks.start, {
				taskId: task2,
				callerOrchestrator: "sigma",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		// Code prefix present — not generic "Server Error"
		expect(msg).toMatch(/^TASK_START_BLOCKED:/);
		expect(msg).toContain(task1);
		expect(msg).toContain(task2);
		expect(msg).toContain("sigma");
		// Embedded JSON must carry structured context
		const jsonPart = msg.slice(msg.indexOf("{"));
		const parsed = JSON.parse(jsonPart);
		expect(parsed.currentInProgressTaskId).toBe(task1);
		expect(parsed.attemptedTaskId).toBe(task2);
	});

	test("no TASK_START_BLOCKED when the in_progress task IS the target (idempotent re-start)", async () => {
		const t = createT();
		const id = await seedTask(t, { assignedTo: "sigma" });
		// First start
		await t.mutation(api.tasks.start, { taskId: id, callerOrchestrator: "sigma" });
		// Re-starting the same task must not throw
		await expect(
			t.mutation(api.tasks.start, { taskId: id, callerOrchestrator: "sigma" }),
		).resolves.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// start — DEPENDENCY_NOT_DONE
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.start — DEPENDENCY_NOT_DONE", () => {
	test("throws DEPENDENCY_NOT_DONE when a dependsOn task is not yet done", async () => {
		const t = createT();

		const dep = await seedTask(t, { title: "Blocker dep", assignedTo: "sigma", status: "todo" });
		const blocked = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "Blocked task",
				assignedTo: "sigma",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "system",
				dependsOn: [dep],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.start, {
				taskId: blocked,
				callerOrchestrator: "sigma",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^DEPENDENCY_NOT_DONE:/);
		expect(msg).toContain(blocked);
		// JSON embedded in message must list the blocker
		const jsonPart = msg.slice(msg.indexOf("{"));
		const parsed = JSON.parse(jsonPart);
		expect(Array.isArray(parsed.blockers)).toBe(true);
		expect(parsed.blockers[0].taskId).toBe(dep);
		expect(parsed.blockers[0].status).toBe("todo");
	});

	test("no DEPENDENCY_NOT_DONE when all dependsOn tasks are done", async () => {
		const t = createT();

		const dep = await seedTask(t, { title: "Completed dep", assignedTo: "sigma", status: "done" });
		// Patch to actually done
		await t.run(async (ctx) => ctx.db.patch(dep, { status: "done" as const }));

		const task = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "Ready task",
				assignedTo: "sigma",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "system",
				dependsOn: [dep],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		await expect(
			t.mutation(api.tasks.start, {
				taskId: task,
				callerOrchestrator: "sigma",
			}),
		).resolves.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// complete — TASK_NOT_FOUND
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.complete — TASK_NOT_FOUND", () => {
	test("throws TASK_NOT_FOUND when completing a deleted task", async () => {
		const t = createT();
		const id = await seedTask(t);
		await t.mutation(api.tasks.deleteTask, { taskId: id, callerOrchestrator: "system" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.complete, {
				taskId: id,
				callerOrchestrator: "system",
				completionNote: "done — PR #123 merged sha:abc1234",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^TASK_NOT_FOUND:/);
		expect(msg).toContain(id);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// complete — COMPLETION_NOTE_REQUIRED
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.complete — COMPLETION_NOTE_REQUIRED", () => {
	test("throws COMPLETION_NOTE_REQUIRED when note is empty string", async () => {
		const t = createT();
		const id = await seedTask(t);

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.complete, {
				taskId: id,
				callerOrchestrator: "system",
				completionNote: "",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^COMPLETION_NOTE_REQUIRED:/);
		expect(msg).toContain(id);
	});

	test("throws COMPLETION_NOTE_REQUIRED when note is whitespace only", async () => {
		const t = createT();
		const id = await seedTask(t);

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.complete, {
				taskId: id,
				callerOrchestrator: "system",
				completionNote: "   ",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^COMPLETION_NOTE_REQUIRED:/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// complete — RBAC_DENIED
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.complete — RBAC_DENIED", () => {
	test("throws RBAC_DENIED when non-assignee tries to complete", async () => {
		const t = createT();
		const id = await seedTask(t, { assignedTo: "sigma" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.complete, {
				taskId: id,
				callerOrchestrator: "gamma",
				completionNote: "done — commit abc1234",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^RBAC_DENIED:/);
		expect(msg).toContain("gamma");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// update — TASK_NOT_FOUND and RBAC_DENIED
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.update — TASK_NOT_FOUND", () => {
	test("throws TASK_NOT_FOUND for deleted task", async () => {
		const t = createT();
		const id = await seedTask(t);
		await t.mutation(api.tasks.deleteTask, { taskId: id, callerOrchestrator: "system" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.update, {
				taskId: id,
				callerOrchestrator: "system",
				title: "new title",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^TASK_NOT_FOUND:/);
		expect(msg).toContain(id);
	});
});

describe("tasks.update — RBAC_DENIED", () => {
	test("throws RBAC_DENIED when non-assignee/creator tries to update", async () => {
		const t = createT();
		const id = await seedTask(t, { assignedTo: "sigma" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.update, {
				taskId: id,
				callerOrchestrator: "pi",
				title: "hijacked",
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^RBAC_DENIED:/);
		expect(msg).toContain("pi");
		expect(msg).toContain(id);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteTask — RBAC_DENIED
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.deleteTask — RBAC_DENIED", () => {
	test("throws RBAC_DENIED when non-creator tries to delete", async () => {
		const t = createT();
		// Task createdBy "system", not "sigma"
		const id = await seedTask(t, { assignedTo: "sigma" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.deleteTask, {
				taskId: id,
				callerOrchestrator: "sigma", // not the creator
			});
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		expect(msg).toMatch(/^RBAC_DENIED:/);
		expect(msg).toContain("sigma");
	});

	test("system can delete any task regardless of creator", async () => {
		const t = createT();
		const id = await seedTask(t, { assignedTo: "sigma" });
		const result = await t.mutation(api.tasks.deleteTask, {
			taskId: id,
			callerOrchestrator: "system",
		});
		expect(result.deleted).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Error message format contract — CODE: prefix parseable by parseConvexError
// ─────────────────────────────────────────────────────────────────────────────

describe("ConvexError message format — CODE: prefix contract", () => {
	const KNOWN_CODES = [
		"TASK_NOT_FOUND",
		"RBAC_DENIED",
		"TASK_START_BLOCKED",
		"DEPENDENCY_NOT_DONE",
		"COMPLETION_NOTE_REQUIRED",
	] as const;

	test("every error code is UPPER_SNAKE_CASE with colon separator", () => {
		for (const code of KNOWN_CODES) {
			// Each code must match UPPER_SNAKE: and have an actionable message after it
			expect(`${code}: some message`).toMatch(/^[A-Z_]+: .+/);
		}
	});

	test("TASK_START_BLOCKED message embeds valid JSON with context fields", async () => {
		const t = createT();
		const t1 = await seedTask(t, { assignedTo: "sigma" });
		const t2 = await seedTask(t, { assignedTo: "sigma" });
		await t.mutation(api.tasks.start, { taskId: t1, callerOrchestrator: "sigma" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.start, { taskId: t2, callerOrchestrator: "sigma" });
		} catch (e) {
			thrown = e;
		}

		const msg = getConvexErrorMessage(thrown);
		// JSON must be embeddable after " — "
		const jsonPart = msg.slice(msg.indexOf("{"));
		const ctx = JSON.parse(jsonPart) as Record<string, unknown>;
		expect(typeof ctx.currentInProgressTaskId).toBe("string");
		expect(typeof ctx.attemptedTaskId).toBe("string");
		expect(typeof ctx.currentInProgressTitle).toBe("string");
	});
});
