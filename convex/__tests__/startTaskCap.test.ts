/// <reference types="vite/client" />
/**
 * convex/__tests__/startTaskCap.test.ts
 *
 * The per-caller, per-project cap on concurrent in_progress tasks is DATA:
 * taskClosureConfig["startTaskInProgressCap"] (single-element string[], e.g.
 * ["6"]). Absent / unreadable / invalid (0, negative, non-numeric,
 * non-integer) => cap 1, i.e. the historical one-per-project behaviour.
 * Fail-closed is the old behaviour, never "unlimited".
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

type T = ReturnType<typeof convexTest>;

function createT(): T {
	return convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	}) as unknown as T;
}

const CAP_KEY = "startTaskInProgressCap";

async function seedCap(t: T, value: string[]): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: CAP_KEY,
			value,
			updatedAt: Date.now(),
		});
	});
}

async function seedTask(
	t: T,
	assignedTo: string,
	project: string,
	title: string,
) {
	return await t.mutation(api.tasks.create, {
		title,
		assignedTo,
		priority: "medium" as const,
		status: "todo" as const,
		createdBy: "system",
		project,
	});
}

async function startMany(
	t: T,
	caller: string,
	project: string,
	n: number,
): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const id = await seedTask(t, caller, project, `${caller}-${project}-${i}`);
		await t.mutation(api.tasks.start, { taskId: id, callerOrchestrator: caller });
		ids.push(id);
	}
	return ids;
}

async function refusal(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		if (typeof data !== "string") return String((e as Error).message);
		// ConvexError string payloads cross the boundary JSON-quoted.
		const unquoted: unknown = data.startsWith('"') ? JSON.parse(data) : data;
		return String(unquoted);
	}
	throw new Error("expected a refusal, but the call succeeded");
}

describe("tasks.start — in_progress cap read from taskClosureConfig", () => {
	test("cap 6: 2nd..6th start succeed, 7th refused naming cap and open ids", async () => {
		const t = createT();
		await seedCap(t, ["6"]);
		const open = await startMany(t, "sigma", "proj-a", 6);
		const seventh = await seedTask(t, "sigma", "proj-a", "seventh");
		const msg = await refusal(
			t.mutation(api.tasks.start, { taskId: seventh, callerOrchestrator: "sigma" }),
		);
		expect(msg).toMatch(/^TASK_START_BLOCKED:/);
		expect(msg).toContain("cap 6");
		for (const id of open) expect(msg).toContain(id);
		const parsed = JSON.parse(msg.slice(msg.indexOf("{"))) as Record<string, unknown>;
		expect(parsed.cap).toBe(6);
		expect(parsed.openInProgressTaskIds).toEqual(expect.arrayContaining(open));
		expect(parsed.attemptedTaskId).toBe(seventh);
		expect(typeof parsed.currentInProgressTaskId).toBe("string");
	});

	test("cap 6: another caller is unaffected by sigma's open tasks", async () => {
		const t = createT();
		await seedCap(t, ["6"]);
		await startMany(t, "sigma", "proj-a", 6);
		const other = await seedTask(t, "eta", "proj-a", "eta-first");
		await expect(
			t.mutation(api.tasks.start, { taskId: other, callerOrchestrator: "eta" }),
		).resolves.toBeNull();
	});

	test("cap 6: another project is unaffected (own count)", async () => {
		const t = createT();
		await seedCap(t, ["6"]);
		await startMany(t, "sigma", "proj-a", 6);
		const inB = await seedTask(t, "sigma", "proj-b", "b-first");
		await expect(
			t.mutation(api.tasks.start, { taskId: inB, callerOrchestrator: "sigma" }),
		).resolves.toBeNull();
	});

	test("no cap row: 2nd start refused (cap 1, today's behaviour)", async () => {
		const t = createT();
		const [first] = await startMany(t, "sigma", "proj-a", 1);
		const second = await seedTask(t, "sigma", "proj-a", "second");
		const msg = await refusal(
			t.mutation(api.tasks.start, { taskId: second, callerOrchestrator: "sigma" }),
		);
		expect(msg).toMatch(/^TASK_START_BLOCKED:/);
		expect(msg).toContain("cap 1");
		expect(msg).toContain(first);
	});

	test.each([
		["zero", ["0"]],
		["negative", ["-3"]],
		["non-number", ["many"]],
		["non-integer", ["2.5"]],
		["empty value", []],
	])("invalid cap (%s) behaves as 1", async (_label, value) => {
		const t = createT();
		await seedCap(t, value);
		await startMany(t, "sigma", "proj-a", 1);
		const second = await seedTask(t, "sigma", "proj-a", "second");
		const msg = await refusal(
			t.mutation(api.tasks.start, { taskId: second, callerOrchestrator: "sigma" }),
		);
		expect(msg).toMatch(/^TASK_START_BLOCKED:/);
		expect(msg).toContain("cap 1");
	});

	test("cap 2: resume of a paused task is gated by the same cap", async () => {
		const t = createT();
		await seedCap(t, ["2"]);
		const [a] = await startMany(t, "sigma", "proj-a", 1);
		await t.mutation(api.tasks.pause, { taskId: a as never, callerOrchestrator: "sigma" });
		await startMany(t, "sigma", "proj-a", 2);
		const msg = await refusal(
			t.mutation(api.tasks.resume, { taskId: a as never, callerOrchestrator: "sigma" }),
		);
		expect(msg).toMatch(/^TASK_START_BLOCKED:/);
		expect(msg).toContain("cap 2");
	});
});
