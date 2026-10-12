/// <reference types="vite/client" />
/**
 * Audit R3 reproductions for POST /api/eta/verify-publish-token (module M11), driven
 * through convex-test t.fetch. Provenance: static audit of VantagePeers main @16f0907,
 * row http:POST /api/eta/verify-publish-token in defects-R3.jsonl (copied from
 * origin/argus/door-audit-16f0907, 3269f851).
 *
 * The /issueBearerFromClerk cases of the same audit file belong to module M3
 * (issueBearerFromClerk) and live in its own file; they are not copied here.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER = "audit-r3-master-bearer-0001";
const FULL_SHA = "9e5b63e7f4a2bc1d9e5b63e7f4a2bc1d9e5b63e7";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

// ── POST /api/eta/verify-publish-token ───────────────────────────────────────
async function seedReviewTask(t: T, note: string, orgId?: string) {
	return await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "reviewerDefault",
			value: ["eta"],
			updatedAt: Date.now(),
		});
		const now = Date.now();
		return await ctx.db.insert("tasks", {
			title: "foreign tenant review",
			assignedTo: "eta",
			priority: "high",
			status: "done",
			completionNote: note,
			createdBy: "sigma",
			createdAt: now,
			updatedAt: now,
			completedAt: now,
			...(orgId ? { orgId } : {}),
		});
	});
}

async function postVerify(t: T, body: Record<string, string>) {
	return t.fetch("/api/eta/verify-publish-token", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER}` },
		body: JSON.stringify(body),
	});
}

describe("http:POST /api/eta/verify-publish-token", () => {
	// Identity: the fleet master bearer (the only credential this route accepts).
	test("http:POST /api/eta/verify-publish-token — a REVISE note plus a one-character expectedSha is not a valid publish approval", async () => {
		const t = createT();
		const taskId = await seedReviewTask(t, "REVISE: needs work", "acme");
		const res = await postVerify(t, { taskId, expectedSha: "e" });
		const data = (await res.json()) as { valid: boolean };
		expect(data.valid, "valid for a REVISE note matched by 1 char").toBe(false);
	});

	test("http:POST /api/eta/verify-publish-token — a refusal does not echo a client org's completionNote text", async () => {
		const t = createT();
		const SECRET_NOTE = "acme-confidential-note-marker-7731";
		const taskId = await seedReviewTask(t, SECRET_NOTE, "acme");
		const res = await postVerify(t, { taskId, expectedSha: "zzzz" });
		const text = await res.text();
		expect(text.includes(SECRET_NOTE), "response body contains acme's note text").toBe(false);
	});

	test("http:POST /api/eta/verify-publish-token — a task owned by a client org is not resolved", async () => {
		const t = createT();
		const taskId = await seedReviewTask(t, `[ETA-APPROVED] ${FULL_SHA}`, "acme");
		const res = await postVerify(t, { taskId, expectedSha: FULL_SHA });
		const data = (await res.json()) as { valid: boolean; reason?: string };
		expect(data.valid, `valid:true for a task of org acme (reason=${data.reason})`).toBe(false);
		expect(data.reason).toBe("task-not-found");
	});

	// Positive control: the same request is VALID for a fleet task, so the denials
	// above are refusals and not a route that rejects everything.
	test("positive control — a fleet task with the marker and the full SHA is valid, and the response carries no note text", async () => {
		const t = createT();
		const taskId = await seedReviewTask(t, `[ETA-APPROVED] reviewed ${FULL_SHA} all green`);
		const res = await postVerify(t, { taskId, expectedSha: FULL_SHA });
		const text = await res.text();
		const data = JSON.parse(text) as { valid: boolean; taskId?: string };
		expect(data.valid).toBe(true);
		expect(data.taskId).toBe(taskId);
		expect(text.includes("reviewed"), "note text leaked into the response").toBe(false);
	});

	test("a fleet task without the [ETA-APPROVED] marker is not an approval even when it cites the full SHA", async () => {
		const t = createT();
		const taskId = await seedReviewTask(t, `REVISE: do not publish ${FULL_SHA}`);
		const res = await postVerify(t, { taskId, expectedSha: FULL_SHA });
		const data = (await res.json()) as { valid: boolean; reason?: string };
		expect(data).toEqual({ valid: false, reason: "not-approved" });
	});

	test("a short or prefix SHA is refused before any task is read", async () => {
		const t = createT();
		const taskId = await seedReviewTask(t, `[ETA-APPROVED] ${FULL_SHA}`);
		for (const sha of [FULL_SHA.slice(0, 7), FULL_SHA.slice(0, 39), `${FULL_SHA}0`]) {
			const res = await postVerify(t, { taskId, expectedSha: sha });
			const data = (await res.json()) as { valid: boolean; reason?: string };
			expect(data, `sha ${sha.length} chars`).toEqual({ valid: false, reason: "invalid-sha" });
		}
	});

	test("a longer hex run that merely contains the SHA does not cite it", async () => {
		const t = createT();
		const taskId = await seedReviewTask(t, `[ETA-APPROVED] ${FULL_SHA}ab`);
		const res = await postVerify(t, { taskId, expectedSha: FULL_SHA });
		const data = (await res.json()) as { valid: boolean; reason?: string };
		expect(data).toEqual({ valid: false, reason: "sha-not-in-note" });
	});
});
