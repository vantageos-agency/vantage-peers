/// <reference types="vite/client" />
/**
 * convex/__tests__/resourceDerivedAuthzCrossTenant.test.ts
 *
 * Task k174pncsyc3ch7wmm7r0zp3ac58b2nye, mission k57d16fdegnxpan2wvhjcxf2c58b2arj.
 *
 * Closes the "guard interrogates the caller's claim instead of the target
 * resource" class of cross-tenant write bug found by the S0 isolation
 * campaign (measured, not touched here — see analysis/ in the main tree).
 *
 * FORM: a guard wrapped entirely in `if (args.field !== undefined)` — or
 * checking a value the caller supplies about itself — instead of asking
 * "does the caller own the TARGET row". Omitting the field, or supplying
 * one's own identity while targeting someone else's row, must be REFUSED,
 * never exempted.
 *
 * Sites covered (convex/tasks.ts):
 *   - update   (RBAC entirely skipped when callerOrchestrator === undefined)
 *   - complete (same shape)
 *   - start    (same shape)
 *   - deleteTask (same shape, no assignedTo leg by design)
 * Site covered (convex/businessUnits.ts):
 *   - update   (no ownership check existed at all — the MCP layer checked
 *     the caller's own OAuth allowlist for the VALUE being written, never
 *     the target row's actual owner)
 *
 * Second assertion (non-negotiable per brief): creator/assignee/owner must
 * still pass. A blanket refusal that also blocks legitimate owners is not a
 * fix — it merely looks like one.
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

function createT(): ReturnType<typeof convexTest> {
	return convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	}) as unknown as ReturnType<typeof convexTest>;
}

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

async function seedTaskOwnedByA(t: ReturnType<typeof createT>) {
	return await t.mutation(api.tasks.create, {
		title: "A-owned task",
		assignedTo: TENANT_A,
		createdBy: TENANT_A,
		priority: "low",
		status: "todo",
	});
}

async function seedBuOwnedByA(t: ReturnType<typeof createT>) {
	return await t.run((ctx) =>
		ctx.db.insert("businessUnits", {
			name: "BU-A-original",
			description: "d",
			purpose: "p",
			orchestratorId: TENANT_A,
			status: "idea",
			businessModel: "m",
			targetCustomers: "t",
			services: [],
			pricing: "p",
			revenueProjections: { y1: 0, y2: 0, y3: 0 },
			coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
			coreProcesses: [],
			dependencies: [],
			kpis: [],
			managementFee: 10,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

describe("tasks.update — omitting callerOrchestrator is refused, not exempted", () => {
	test("B cannot mutate A's task by omitting callerOrchestrator", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);

		await expect(
			t.mutation(api.tasks.update, {
				taskId,
				status: "blocked",
				title: "MUTATED-BY-B-CROSS-TENANT",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const after = await t.query(api.tasks.get, { taskId });
		expect(after?.title).toBe("A-owned task");
		expect(after?.status).toBe("todo");
	});

	test("second assertion — creator/assignee A still updates its own task", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);

		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: TENANT_A,
			status: "in_progress",
		});

		const after = await t.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("in_progress");
	});

	test("system caller still bypasses (unaffected regression)", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);

		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "system",
			status: "in_progress",
		});

		const after = await t.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("in_progress");
	});
});

describe("tasks.complete — omitting callerOrchestrator is refused, not exempted", () => {
	test("B cannot complete A's task by omitting callerOrchestrator", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);

		await expect(
			t.mutation(api.tasks.complete, {
				taskId,
				completionNote: "MUTATED-BY-B-CROSS-TENANT sha:deadbeef1",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const after = await t.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("todo");
	});

	test("second assertion — assignee A still completes its own task", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: Date.now(),
			});
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: TENANT_A,
			completionNote: "Done — internal chore, no billing line needed",
		});

		const after = await t.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("done");
	});
});

describe("tasks.start — omitting callerOrchestrator is refused, not exempted", () => {
	test("B cannot start A's task by omitting callerOrchestrator", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);

		await expect(
			t.mutation(api.tasks.start, { taskId }),
		).rejects.toThrow(/RBAC_DENIED/);

		const after = await t.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("todo");
	});

	test("second assertion — assignee A still starts its own task", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);

		await t.mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: TENANT_A,
		});

		const after = await t.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("in_progress");
	});
});

describe("tasks.deleteTask — omitting callerOrchestrator is refused, not exempted", () => {
	test("B cannot delete A's task by omitting callerOrchestrator", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);

		await expect(
			t.mutation(api.tasks.deleteTask, { taskId }),
		).rejects.toThrow(/RBAC_DENIED/);

		const after = await t.query(api.tasks.get, { taskId });
		expect(after).not.toBeNull();
	});

	test("second assertion — creator A still deletes its own task", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);

		const result = await t.mutation(api.tasks.deleteTask, {
			taskId,
			callerOrchestrator: TENANT_A,
		});
		expect(result.deleted).toBe(true);
	});

	test("system caller still bypasses (unaffected regression)", async () => {
		const t = createT();
		const taskId = await seedTaskOwnedByA(t);

		const result = await t.mutation(api.tasks.deleteTask, {
			taskId,
			callerOrchestrator: "system",
		});
		expect(result.deleted).toBe(true);
	});
});

describe("businessUnits.update — authorization derived from the TARGET row, not the caller's claim", () => {
	test("B cannot rewrite A's BU by supplying its own identity as callerOrchestrator", async () => {
		const t = createT();
		const buId = await seedBuOwnedByA(t);

		await expect(
			t.mutation(api.businessUnits.update, {
				buId,
				callerOrchestrator: TENANT_B,
				name: "MUTATED-BY-B-CROSS-TENANT",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const after = await t.run((ctx) => ctx.db.get(buId));
		expect((after as { name?: string } | null)?.name).toBe("BU-A-original");
	});

	test("second assertion — owning orchestrator A still updates its own BU", async () => {
		const t = createT();
		const buId = await seedBuOwnedByA(t);

		await t.mutation(api.businessUnits.update, {
			buId,
			callerOrchestrator: TENANT_A,
			name: "A-renamed",
		});

		const after = await t.run((ctx) => ctx.db.get(buId));
		expect((after as { name?: string } | null)?.name).toBe("A-renamed");
	});

	test("system caller still bypasses (unaffected regression)", async () => {
		const t = createT();
		const buId = await seedBuOwnedByA(t);

		await t.mutation(api.businessUnits.update, {
			buId,
			callerOrchestrator: "system",
			name: "system-renamed",
		});

		const after = await t.run((ctx) => ctx.db.get(buId));
		expect((after as { name?: string } | null)?.name).toBe("system-renamed");
	});
});

// ── Class sweep: same-shape deletes found alongside the two named leaks ────

describe("briefingNotes.deleteBriefingNote — omitting callerOrchestrator is refused, not exempted", () => {
	test("B cannot delete A's note by omitting callerOrchestrator", async () => {
		const t = createT();
		const noteId = await t.run((ctx) =>
			ctx.db.insert("briefingNotes", {
				title: "A-note",
				topic: "t",
				participants: [TENANT_A],
				content: "c",
				createdBy: TENANT_A,
				createdAt: Date.now(),
			}),
		);

		await expect(
			t.mutation(api.briefingNotes.deleteBriefingNote, { noteId }),
		).rejects.toThrow(/callerOrchestrator is required/);

		expect(await t.run((ctx) => ctx.db.get(noteId))).not.toBeNull();
	});

	test("second assertion — creator A still deletes its own note", async () => {
		const t = createT();
		const noteId = await t.run((ctx) =>
			ctx.db.insert("briefingNotes", {
				title: "A-note",
				topic: "t",
				participants: [TENANT_A],
				content: "c",
				createdBy: TENANT_A,
				createdAt: Date.now(),
			}),
		);

		const result = await t.mutation(api.briefingNotes.deleteBriefingNote, {
			noteId,
			callerOrchestrator: TENANT_A,
		});
		expect(result.deleted).toBe(true);
	});
});

describe("diary.deleteDiary — omitting callerOrchestrator is refused, not exempted", () => {
	test("B cannot delete A's diary entry by omitting callerOrchestrator", async () => {
		const t = createT();
		const diaryId = await t.mutation(api.diary.write, {
			date: "2026-07-23",
			orchestrator: TENANT_A,
			content: "A's day",
		});

		await expect(
			t.mutation(api.diary.deleteDiary, { diaryId }),
		).rejects.toThrow(/callerOrchestrator is required/);

		expect(await t.run((ctx) => ctx.db.get(diaryId))).not.toBeNull();
	});

	test("second assertion — owner A still deletes its own diary entry", async () => {
		const t = createT();
		const diaryId = await t.mutation(api.diary.write, {
			date: "2026-07-23",
			orchestrator: TENANT_A,
			content: "A's day",
		});

		const result = await t.mutation(api.diary.deleteDiary, {
			diaryId,
			callerOrchestrator: TENANT_A,
		});
		expect(result.deleted).toBe(true);
	});
});

describe("messages.deleteMessage — omitting callerOrchestrator is refused, not exempted", () => {
	test("B cannot delete A's message by omitting callerOrchestrator", async () => {
		const t = createT();
		await t.run((ctx) =>
			ctx.db.insert("profiles", {
				orchestratorId: TENANT_B,
				name: TENANT_B,
				static: { role: TENANT_B, workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			}),
		);
		const messageId = await t.mutation(api.messages.sendMessage, {
			from: TENANT_A,
			channel: TENANT_B,
			content: "A's message",
		});

		await expect(
			t.mutation(api.messages.deleteMessage, { messageId }),
		).rejects.toThrow(/callerOrchestrator is required/);

		expect(await t.run((ctx) => ctx.db.get(messageId))).not.toBeNull();
	});

	test("second assertion — sender A still deletes its own message", async () => {
		const t = createT();
		await t.run((ctx) =>
			ctx.db.insert("profiles", {
				orchestratorId: TENANT_B,
				name: TENANT_B,
				static: { role: TENANT_B, workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			}),
		);
		const messageId = await t.mutation(api.messages.sendMessage, {
			from: TENANT_A,
			channel: TENANT_B,
			content: "A's message",
		});

		const result = await t.mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: TENANT_A,
		});
		expect(result.deleted).toBe(true);
	});
});
