/// <reference types="vite/client" />
//
// Issue #1064 extension (slice 6, FINAL) — recurringTasks single-id handlers,
// mirroring missions:get (PR #1077) and errorMonitor/fixPatterns (PR #1079).
//
// Five handlers in convex/recurringTasks.ts take a raw recurringTasks id:
// getById, update, pause, resume, remove. All narrowed via requireId.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

type WrongTablePayload = {
	path?: string;
	expectedTable?: string;
	receivedId?: string;
	message?: string;
};

// `ConvexError.data` is a JSON string under convex-test and the thrown object
// in prod — both measured. Accept both.
const decodePayload = (caught: unknown): WrongTablePayload => {
	const raw = (caught as ConvexError<string | WrongTablePayload>).data;
	return typeof raw === "string" ? (JSON.parse(raw) as WrongTablePayload) : raw;
};

const HINT =
	"Use the full 32-char id returned by list_recurring_tasks or create_recurring_task.";

const newRecurringTask = (t: ReturnType<typeof createT>) =>
	t.mutation(api.recurringTasks.create, {
		title: "Probe recurring task",
		assignedTo: "sigma",
		priority: "medium",
		cronExpression: "0 9 * * *",
		createdBy: "sigma",
	});

const newTask = (t: ReturnType<typeof createT>) =>
	t.mutation(api.tasks.create, {
		title: "Probe task",
		assignedTo: "sigma",
		priority: "low",
		status: "todo",
		createdBy: "sigma",
	});

describe("recurringTasks — wrong-table ID (issue #1064, slice 6 FINAL)", () => {
	describe("getById", () => {
		test("a tasks-table ID yields an actionable ConvexError naming recurringTaskId", async () => {
			const t = createT();
			const taskId = await newTask(t);

			let caught: unknown;
			try {
				await t.query(api.recurringTasks.getById, {
					recurringTaskId: taskId as unknown as Id<"recurringTasks">,
				});
				throw new Error("getById did not throw — expected a ConvexError");
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ConvexError);
			const payload = decodePayload(caught);
			expect(payload?.path).toBe("recurringTaskId");
			expect(payload?.expectedTable).toBe("recurringTasks");
			expect(payload?.receivedId).toBe(taskId);
			expect(payload?.message).toBe(
				`recurringTaskId is not a valid recurringTasks ID. ${HINT}`,
			);
			expect(payload?.message).not.toBe(
				"recurringTaskId is not a valid recurringTasks ID.",
			);
		});

		test("positive control: a real recurringTaskId still returns the document", async () => {
			const t = createT();
			const recurringTaskId = await newRecurringTask(t);
			const doc = await t.query(api.recurringTasks.getById, { recurringTaskId });
			expect(doc?._id).toBe(recurringTaskId);
			expect(doc?.title).toBe("Probe recurring task");
		});

		test("contract preserved: a valid id pointing at a deleted doc returns null, does NOT throw", async () => {
			const t = createT();
			const recurringTaskId = await newRecurringTask(t);
			await t.run(async (ctx) => {
				await ctx.db.delete(recurringTaskId);
			});
			await expect(
				t.query(api.recurringTasks.getById, { recurringTaskId }),
			).resolves.toBeNull();
		});
	});

	describe("update", () => {
		test("a tasks-table ID yields an actionable ConvexError naming recurringTaskId", async () => {
			const t = createT();
			const taskId = await newTask(t);

			let caught: unknown;
			try {
				await t.mutation(api.recurringTasks.update, {
					recurringTaskId: taskId as unknown as Id<"recurringTasks">,
					title: "New title",
				});
				throw new Error("update did not throw — expected a ConvexError");
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ConvexError);
			const payload = decodePayload(caught);
			expect(payload?.path).toBe("recurringTaskId");
			expect(payload?.expectedTable).toBe("recurringTasks");
			expect(payload?.receivedId).toBe(taskId);
			expect(payload?.message).toBe(
				`recurringTaskId is not a valid recurringTasks ID. ${HINT}`,
			);
		});

		test("positive control: a real recurringTaskId updates and returns the id", async () => {
			const t = createT();
			const recurringTaskId = await newRecurringTask(t);
			const result = await t.mutation(api.recurringTasks.update, {
				recurringTaskId,
				title: "Updated title",
			});
			expect(result).toBe(recurringTaskId);
		});

		test("contract preserved: valid id pointing at a deleted doc still throws 'not found'", async () => {
			const t = createT();
			const recurringTaskId = await newRecurringTask(t);
			await t.run(async (ctx) => {
				await ctx.db.delete(recurringTaskId);
			});
			await expect(
				t.mutation(api.recurringTasks.update, {
					recurringTaskId,
					title: "x",
				}),
			).rejects.not.toThrow(ConvexError);
		});
	});

	describe("pause", () => {
		test("a tasks-table ID yields an actionable ConvexError naming taskId", async () => {
			const t = createT();
			const taskId = await newTask(t);

			let caught: unknown;
			try {
				await t.mutation(api.recurringTasks.pause, {
					taskId: taskId as unknown as Id<"recurringTasks">,
				});
				throw new Error("pause did not throw — expected a ConvexError");
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ConvexError);
			const payload = decodePayload(caught);
			expect(payload?.path).toBe("taskId");
			expect(payload?.expectedTable).toBe("recurringTasks");
			expect(payload?.receivedId).toBe(taskId);
			expect(payload?.message).toBe(
				`taskId is not a valid recurringTasks ID. ${HINT}`,
			);
		});

		test("positive control: a real recurringTaskId pauses successfully", async () => {
			const t = createT();
			const recurringTaskId = await newRecurringTask(t);
			const result = await t.mutation(api.recurringTasks.pause, {
				taskId: recurringTaskId,
			});
			expect(result).toEqual({ taskId: recurringTaskId, active: false });
		});
	});

	describe("resume", () => {
		test("a tasks-table ID yields an actionable ConvexError naming taskId", async () => {
			const t = createT();
			const taskId = await newTask(t);

			let caught: unknown;
			try {
				await t.mutation(api.recurringTasks.resume, {
					taskId: taskId as unknown as Id<"recurringTasks">,
				});
				throw new Error("resume did not throw — expected a ConvexError");
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ConvexError);
			const payload = decodePayload(caught);
			expect(payload?.path).toBe("taskId");
			expect(payload?.expectedTable).toBe("recurringTasks");
			expect(payload?.receivedId).toBe(taskId);
			expect(payload?.message).toBe(
				`taskId is not a valid recurringTasks ID. ${HINT}`,
			);
		});

		test("positive control: a real recurringTaskId resumes successfully", async () => {
			const t = createT();
			const recurringTaskId = await newRecurringTask(t);
			await t.mutation(api.recurringTasks.pause, { taskId: recurringTaskId });
			const result = await t.mutation(api.recurringTasks.resume, {
				taskId: recurringTaskId,
			});
			expect(result.taskId).toBe(recurringTaskId);
			expect(result.active).toBe(true);
		});

		test("contract preserved: valid id pointing at a deleted doc still throws 'not found'", async () => {
			const t = createT();
			const recurringTaskId = await newRecurringTask(t);
			await t.run(async (ctx) => {
				await ctx.db.delete(recurringTaskId);
			});
			await expect(
				t.mutation(api.recurringTasks.resume, { taskId: recurringTaskId }),
			).rejects.not.toThrow(ConvexError);
		});
	});

	describe("remove", () => {
		test("a tasks-table ID yields an actionable ConvexError naming taskId", async () => {
			const t = createT();
			const taskId = await newTask(t);

			let caught: unknown;
			try {
				await t.mutation(api.recurringTasks.remove, {
					taskId: taskId as unknown as Id<"recurringTasks">,
				});
				throw new Error("remove did not throw — expected a ConvexError");
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeInstanceOf(ConvexError);
			const payload = decodePayload(caught);
			expect(payload?.path).toBe("taskId");
			expect(payload?.expectedTable).toBe("recurringTasks");
			expect(payload?.receivedId).toBe(taskId);
			expect(payload?.message).toBe(
				`taskId is not a valid recurringTasks ID. ${HINT}`,
			);

			// The unrelated task must survive — remove must not have run.
			const stillThere = await t.query(api.tasks.getById, { taskId });
			expect(stillThere?._id).toBe(taskId);
		});

		test("positive control: a real recurringTaskId is deleted successfully", async () => {
			const t = createT();
			const recurringTaskId = await newRecurringTask(t);
			const result = await t.mutation(api.recurringTasks.remove, {
				taskId: recurringTaskId,
			});
			expect(result).toEqual({ deleted: true });
			const doc = await t.query(api.recurringTasks.getById, {
				recurringTaskId,
			});
			expect(doc).toBeNull();
		});
	});
});
