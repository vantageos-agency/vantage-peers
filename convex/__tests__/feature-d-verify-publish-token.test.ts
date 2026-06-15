/// <reference types="vite/client" />
/**
 * Feature D — /api/eta/verify-publish-token HTTP action tests.
 *
 * 7 scenarios per Eta spec (hook v1.2.0 Feature D Option F):
 *   1. Known APPROVED task + correct SHA → valid:true
 *   2. Known APPROVED task + WRONG SHA → valid:false, reason:sha-not-in-note
 *   3. Invalid (nonexistent) task ID → valid:false, reason:task-not-found
 *   4. Wrong assignee (sigma, not eta) → valid:false, reason:wrong-assignee
 *   5. Wrong status (todo, not done) → valid:false, reason:wrong-status
 *   6. Missing bearer → HTTP 401
 *   7. Invalid bearer (wrong secret) → valid:false, reason:bearer-invalid
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "../schema";

// Exclude RAG/search/backfill modules (same pattern as other tests in this dir)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// ─── Constants ────────────────────────────────────────────────────────────────

const MASTER_BEARER = "test-master-secret-featureD-abc123";
const APPROVED_SHA = "9e5b63e7f4a2bc1d";
const ENDPOINT = "/api/eta/verify-publish-token";

/** Build a minimal valid task document for insertion. */
function makeTask(overrides?: {
	assignedTo?: string;
	status?: "todo" | "in_progress" | "review" | "blocked" | "done";
	completionNote?: string;
}) {
	const now = Date.now();
	return {
		title: "Test Eta APPROVED task",
		assignedTo: overrides?.assignedTo ?? "eta",
		priority: "high" as const,
		status: overrides?.status ?? "done",
		completionNote:
			overrides?.completionNote ??
			`[ETA-APPROVED] Reviewed commit ${APPROVED_SHA}. All checks passed.`,
		createdBy: "sigma",
		createdAt: now,
		updatedAt: now,
		completedAt: now,
	};
}

function makeTestConvex() {
	return convexTest(schema, modules);
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
	process.env.BEARER_SECRET_MASTER = MASTER_BEARER;
});

afterEach(() => {
	delete process.env.BEARER_SECRET_MASTER;
});

// ─── Response shape ───────────────────────────────────────────────────────────

interface VerifyResponse {
	valid: boolean;
	reason?: string;
	taskId?: string;
	completedAt?: number;
	noteExcerpt?: string;
	hint?: string;
	got?: string;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/** POST to the verify-publish-token endpoint. */
async function postVerify(
	t: ReturnType<typeof makeTestConvex>,
	body: Record<string, string>,
	bearer?: string,
) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (bearer !== undefined) {
		headers["Authorization"] = `Bearer ${bearer}`;
	}
	return t.fetch(ENDPOINT, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("/api/eta/verify-publish-token — Feature D 7-scenario corpus", () => {
	// ── Scenario 1: Known APPROVED task + correct SHA ──────────────────────────

	test("1. APPROVED task + correct SHA → valid:true, returns taskId/completedAt/noteExcerpt", async () => {
		const t = makeTestConvex();

		const taskId = await t.run(async (ctx) => {
			return await ctx.db.insert("tasks", makeTask());
		});

		const response = await postVerify(
			t,
			{ taskId, expectedSha: APPROVED_SHA },
			MASTER_BEARER,
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as VerifyResponse;
		expect(data.valid).toBe(true);
		expect(data.taskId).toBe(taskId);
		expect(typeof data.completedAt).toBe("number");
		expect(typeof data.noteExcerpt).toBe("string");
		expect(data.noteExcerpt).toContain(APPROVED_SHA);
	});

	// ── Scenario 2: Correct task + WRONG SHA ──────────────────────────────────

	test("2. APPROVED task + wrong SHA → valid:false, reason:sha-not-in-note, hint present", async () => {
		const t = makeTestConvex();

		const taskId = await t.run(async (ctx) => {
			return await ctx.db.insert("tasks", makeTask());
		});

		const wrongSha = "deadbeef00001234";
		const response = await postVerify(
			t,
			{ taskId, expectedSha: wrongSha },
			MASTER_BEARER,
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as VerifyResponse;
		expect(data.valid).toBe(false);
		expect(data.reason).toBe("sha-not-in-note");
		expect(data.hint).toContain("deadbeef0000");
	});

	// ── Scenario 3: Nonexistent task ID ───────────────────────────────────────

	test("3. nonexistent task ID → valid:false, reason:task-not-found", async () => {
		const t = makeTestConvex();

		// Insert then delete to get a well-formed-but-gone ID
		const taskId = await t.run(async (ctx) => {
			return await ctx.db.insert("tasks", makeTask());
		});
		await t.run(async (ctx) => {
			await ctx.db.delete(taskId);
		});

		const response = await postVerify(
			t,
			{ taskId, expectedSha: APPROVED_SHA },
			MASTER_BEARER,
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as VerifyResponse;
		expect(data.valid).toBe(false);
		expect(data.reason).toBe("task-not-found");
	});

	// ── Scenario 4: Wrong assignee ────────────────────────────────────────────

	test("4. task.assignedTo=sigma → valid:false, reason:wrong-assignee, got:sigma", async () => {
		const t = makeTestConvex();

		const taskId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				"tasks",
				makeTask({
					assignedTo: "sigma",
					completionNote: `[SIGMA-APPROVED] Reviewed commit ${APPROVED_SHA}.`,
				}),
			);
		});

		const response = await postVerify(
			t,
			{ taskId, expectedSha: APPROVED_SHA },
			MASTER_BEARER,
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as VerifyResponse;
		expect(data.valid).toBe(false);
		expect(data.reason).toBe("wrong-assignee");
		expect(data.got).toBe("sigma");
	});

	// ── Scenario 5: Wrong status ──────────────────────────────────────────────

	test("5. task.status=todo → valid:false, reason:wrong-status, got:todo", async () => {
		const t = makeTestConvex();

		const taskId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				"tasks",
				makeTask({
					status: "todo",
					completionNote: `Pending review ${APPROVED_SHA}.`,
				}),
			);
		});

		const response = await postVerify(
			t,
			{ taskId, expectedSha: APPROVED_SHA },
			MASTER_BEARER,
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as VerifyResponse;
		expect(data.valid).toBe(false);
		expect(data.reason).toBe("wrong-status");
		expect(data.got).toBe("todo");
	});

	// ── Scenario 6: Missing bearer ────────────────────────────────────────────

	test("6. no Authorization header → HTTP 401, body: missing-bearer", async () => {
		const t = makeTestConvex();

		const taskId = await t.run(async (ctx) => {
			return await ctx.db.insert("tasks", makeTask());
		});

		// Call without bearer argument (undefined → no Authorization header added)
		const response = await postVerify(t, { taskId, expectedSha: APPROVED_SHA });

		expect(response.status).toBe(401);
		const text = await response.text();
		expect(text).toBe("missing-bearer");
	});

	// ── Scenario 7: Invalid bearer ────────────────────────────────────────────

	test("7. wrong bearer secret → valid:false, reason:bearer-invalid", async () => {
		const t = makeTestConvex();

		const taskId = await t.run(async (ctx) => {
			return await ctx.db.insert("tasks", makeTask());
		});

		const response = await postVerify(
			t,
			{ taskId, expectedSha: APPROVED_SHA },
			"totally-wrong-secret",
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as VerifyResponse;
		expect(data.valid).toBe(false);
		expect(data.reason).toBe("bearer-invalid");
	});
});
