/// <reference types="vite/client" />
//
// Both-pole coverage for reviewBacklogSweep.sweepReviewBacklog (Eta REVISE on
// PR #1258). The blocker: a run with no GITHUB_TOKEN logged + `continue`d
// without incrementing `errors`, so it returned {closed:0, errors:0} —
// byte-identical to an authenticated run that found every PR still open. The
// operator reads a clean run and the dead rows stay, the exact failure the
// sweep exists to end. The action was entirely uncovered (grep -rn
// sweepReviewBacklog convex/ --include=*.test.ts -> nothing).
//
// The two poles MUST NOT render alike:
//   • no token          -> the run REFUSES loudly (throws) — it cannot look.
//   • token + open PR    -> {closed:0, errors:0} legitimately (it looked, the
//                           PR is open, nothing to close).

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
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
	return convexTest(schema, modules) as unknown as ReturnType<
		typeof convexTest
	>;
}

async function seedAutomationRow(t: ReturnType<typeof convexTest>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("tasks", {
			title: "[Review] vantageos-agency/vantage-peers PR #1258: sweep",
			assignedTo: "eta",
			priority: "high",
			status: "todo",
			createdBy: "sigma",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.GITHUB_TOKEN;
});

describe("reviewBacklogSweep — credential pole must be distinguishable from a clean run", () => {
	test("NO token: refuses loudly (throws) — never a silent {closed:0,errors:0}", async () => {
		const t = createT();
		await seedAutomationRow(t);
		delete process.env.GITHUB_TOKEN;
		// the refusal is BEFORE the loop and BEFORE the backlog query — a missing
		// credential is not a per-row condition.
		await expect(
			t.action(internal.reviewBacklogSweep.sweepReviewBacklog, {}),
		).rejects.toThrow(/REFUSING TO SWEEP: no GITHUB_TOKEN/);
	});

	test("token present + PR still OPEN: {closed:0, errors:0} legitimately, fanoutCapped false", async () => {
		const t = createT();
		await seedAutomationRow(t);
		process.env.GITHUB_TOKEN = "ghp_test_token";
		// GitHub says the PR is still open → the sweep must NOT close it.
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ state: "open", merged: false }), {
						status: 200,
					}),
			),
		);
		const r = await t.action(
			internal.reviewBacklogSweep.sweepReviewBacklog,
			{},
		);
		expect(r.automation.before).toBe(1);
		expect(r.automation.closed).toBe(0);
		expect(r.errors).toBe(0);
		expect(r.fanoutCapped).toBe(false);
		// the row is STILL open — a legitimate closed-0, distinct from the no-token
		// pole which throws rather than returning this shape.
		expect(r.automation.remaining).toBe(1);
	});

	test("token present + PR MERGED: the automation row is closed (closed>=1)", async () => {
		const t = createT();
		await seedAutomationRow(t);
		process.env.GITHUB_TOKEN = "ghp_test_token";
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							state: "closed",
							merged: true,
							merge_commit_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
						}),
						{ status: 200 },
					),
			),
		);
		const r = await t.action(
			internal.reviewBacklogSweep.sweepReviewBacklog,
			{},
		);
		expect(r.automation.closed).toBeGreaterThanOrEqual(1);
		expect(r.errors).toBe(0);
	});
});
