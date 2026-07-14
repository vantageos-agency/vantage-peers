/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// okfBundleDurable.test.ts — I1 long-task survival, OKF export durable path.
//
// Worktree: /root/coding/vm-vpi1, branch feat/vp-i1-durable-long-tasks.
//
// HONEST LIMITATION, discovered and measured during this task (read before
// editing this file): `@vantageos/agent-engine@0.1.0-alpha.2`'s
// `durableJob.start()` internally calls its own `requireOrgId(ctx)`, which
// throws unless `ctx.auth.getUserIdentity()` carries an `org_id` claim.
// `convex-test` (both 0.0.44, the version pinned by this repo, and 0.0.54,
// the version the component itself was built against) deliberately does NOT
// propagate the caller's identity across a component boundary — see
// `node_modules/convex-test/dist/index.js`, comment "Auth doesn't propagate
// across component boundaries" (identical in both versions, function
// `authForComponent`). Consequence, measured directly below in
// `describe("KNOWN BLOCKER ...")`: `startOkfBundleExportDurable` — our own
// real public entry point — ALWAYS throws
// "Unauthenticated: no identity on ctx.auth" when it calls
// `components.agentEngine.engine.durableJob.start`, for ANY caller, in this
// test harness. This could not be independently confirmed against a live
// Convex deployment in this pass (no `CONVEX_DEPLOYMENT` credential in this
// worktree — see package README "two gates" section for the same
// constraint), but `convex-test`'s documented behaviour strongly suggests it
// reflects real Convex component isolation (a component has no ambient
// authority over the caller's identity unless the caller passes it as a
// plain argument — which `durableJob.start`'s FIXED arg shape
// `{ stepFunctionHandle, totalSteps, maxAttemptsPerStep, kind }` does not
// do). This is a defect in the published package, not in this worktree's
// wiring — `start()`'s own args contract gives the caller no way to supply
// an orgId explicitly.
//
// Because `start()` cannot be driven in this harness, the tests below that
// need MULTIPLE STEPS run against `_exportOkfBundleStepInternal` directly —
// which is legitimate here specifically because that function's invocation
// shape (`{ orgId, jobId, stepIndex }`, called once per index) is EXACTLY
// what the engine calls in production; it is the fixed, documented,
// real contract for a step function, not a shortcut around it. What is
// NOT exercised here, because of the blocker above, is the engine's OWN
// bookkeeping (`cursor`, `status`, abandonment counting) — that lives inside
// the blocked `durableJob.start`/`runStepInternal`. The
// "KNOWN BLOCKER" describe block below is a canary: if a future
// `@vantageos/agent-engine` release fixes the auth-propagation defect, that
// test will start FAILING (the throw will stop happening), which is the
// signal to replace it with real end-to-end coverage through `start()`.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import agentEngineSchema from "../../node_modules/@vantageos/agent-engine/dist/component/schema.js";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// Codegen-lag workaround (mirrors okfBundleNode.ts / okfBundleDurable.ts):
// `okfBundleDurable` is not yet in `_generated/api.d.ts`'s typed `fullApi`
// surface offline (requires `npx convex codegen` against a live deployment,
// unavailable in this worktree). Widening only affects compile-time types.
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround
const apiAny = api as any;
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround
const internalAny = internal as any;

function withAgentEngine<T extends { registerComponent: Function }>(t: T): T {
	t.registerComponent(
		"agentEngine",
		agentEngineSchema as never,
		import.meta.glob(
			"../../node_modules/@vantageos/agent-engine/dist/component/**/*.js",
		) as never,
	);
	return t;
}

const NOW = 1_753_000_000_000;

describe("KNOWN BLOCKER — @vantageos/agent-engine 0.1.0-alpha.2 requireOrgId vs component auth isolation", () => {
	test("startOkfBundleExportDurable currently throws Unauthenticated via the real component call (canary — see file header)", async () => {
		const base = withAgentEngine(convexTest(schema, modules));
		const t = base.withIdentity({ organizationId: "elpi-corp", org_id: "elpi-corp" });

		await expect(
			t.mutation(apiAny.okfBundleDurable.startOkfBundleExportDurable, {
				namespace: "project/elpi-corp",
				totalSteps: 3,
				maxAttemptsPerStep: 3,
			}),
		).rejects.toThrow(/Unauthenticated/);
	});
});

describe("okfBundleDurable — step function plumbing (real fixed-contract entry point)", () => {
	async function seedProgress(
		t: { run: ReturnType<typeof convexTest>["run"] },
		opts: { orgId: string; jobId: string },
	) {
		return await t.run(async (ctx) => {
			const now = NOW;
			// team/<orgId> namespace convention used elsewhere in okfBundle.ts.
			const namespace = `team/${opts.orgId}`;
			await ctx.db.insert("memories", {
				namespace,
				type: "project",
				content: "memory one",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("memories", {
				namespace,
				type: "project",
				content: "memory two",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("briefingNotes", {
				title: "briefing one",
				topic: "daily",
				participants: [],
				content: "briefing content",
				createdBy: "sigma",
				createdAt: now,
				orgId: opts.orgId,
			});
			await ctx.db.insert("tasks", {
				title: "task one",
				description: "task description",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
				createdAt: now,
				updatedAt: now,
				orgId: opts.orgId,
			});

			return await ctx.db.insert("okfDurableExportProgress", {
				jobId: opts.jobId,
				orgId: opts.orgId,
				namespace,
				memoriesCursor: null,
				memoriesDone: false,
				briefingsCursor: null,
				briefingsDone: false,
				tasksCursor: null,
				tasksDone: false,
				memoryCount: 0,
				briefingCount: 0,
				taskCount: 0,
				stepsCompleted: 0,
				status: "running",
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	test("a long export runs across MULTIPLE steps — the step ran once per index, progress persists between steps", async () => {
		const t = withAgentEngine(convexTest(schema, modules));
		const jobId = "job-multi-step-1";
		await seedProgress(t, { orgId: "acme", jobId });

		// Step 0: consumes the memories page (2 rows, well under
		// BUNDLE_PAGE_SIZE=256, so isDone=true after one page).
		await t.mutation(internalAny.okfBundleDurable._exportOkfBundleStepInternal, {
			orgId: "acme",
			jobId,
			stepIndex: 0,
		});
		let progress = await t.run(async (ctx) =>
			ctx.db
				.query("okfDurableExportProgress")
				.withIndex("by_orgId_jobId", (q) =>
					q.eq("orgId", "acme").eq("jobId", jobId),
				)
				.unique(),
		);
		expect(progress?.memoriesDone).toBe(true);
		expect(progress?.briefingsDone).toBe(false);
		expect(progress?.stepsCompleted).toBe(1);

		// Step 1: briefing notes page.
		await t.mutation(internalAny.okfBundleDurable._exportOkfBundleStepInternal, {
			orgId: "acme",
			jobId,
			stepIndex: 1,
		});
		// Step 2: tasks page.
		await t.mutation(internalAny.okfBundleDurable._exportOkfBundleStepInternal, {
			orgId: "acme",
			jobId,
			stepIndex: 2,
		});
		// Step 3: final "assemble" step (all three families now done).
		await t.mutation(internalAny.okfBundleDurable._exportOkfBundleStepInternal, {
			orgId: "acme",
			jobId,
			stepIndex: 3,
		});

		progress = await t.run(async (ctx) =>
			ctx.db
				.query("okfDurableExportProgress")
				.withIndex("by_orgId_jobId", (q) =>
					q.eq("orgId", "acme").eq("jobId", jobId),
				)
				.unique(),
		);
		expect(progress?.status).toBe("assembled");
		expect(progress?.stepsCompleted).toBe(4);
		expect(progress?.memoryCount).toBe(2);
		expect(progress?.briefingCount).toBe(1);
		expect(progress?.taskCount).toBe(1);

		const entries = await t.run(async (ctx) =>
			ctx.db
				.query("okfDurableExportEntries")
				.withIndex("by_org_job", (q) =>
					q.eq("orgId", "acme").eq("jobId", jobId),
				)
				.collect(),
		);
		// One row persisted per step, across DIFFERENT step invocations — this
		// is the "ran once per index, progress persists between steps" proof:
		// each family's entries only exist after its own step ran, never all
		// at once.
		expect(entries).toHaveLength(4); // 2 memories + 1 briefing + 1 task
		expect(entries.filter((e) => e.family === "memory")).toHaveLength(2);
		expect(entries.filter((e) => e.family === "briefing")).toHaveLength(1);
		expect(entries.filter((e) => e.family === "task")).toHaveLength(1);
	});

	test("cross-tenant: a step for org A cannot read org B's rows (RED before / GREEN after the by_orgId_jobId scoping)", async () => {
		const t = withAgentEngine(convexTest(schema, modules));
		const jobIdA = "job-org-a";
		await seedProgress(t, { orgId: "org-a", jobId: jobIdA });

		// GREEN: org B never had a progress row created for this jobId, so a
		// step claiming to be org B against org A's jobId must fail closed
		// (indistinguishable from "not found" — no data about org A leaks).
		await expect(
			t.mutation(internalAny.okfBundleDurable._exportOkfBundleStepInternal, {
				orgId: "org-b",
				jobId: jobIdA,
				stepIndex: 0,
			}),
		).rejects.toThrow(/OKF_DURABLE_PROGRESS_MISSING/);

		// Confirm nothing was written under org B's scope by the failed call.
		const orgBEntries = await t.run(async (ctx) =>
			ctx.db
				.query("okfDurableExportEntries")
				.withIndex("by_org_job", (q) =>
					q.eq("orgId", "org-b").eq("jobId", jobIdA),
				)
				.collect(),
		);
		expect(orgBEntries).toHaveLength(0);

		// Org A's own step, by contrast, succeeds normally.
		await expect(
			t.mutation(internalAny.okfBundleDurable._exportOkfBundleStepInternal, {
				orgId: "org-a",
				jobId: jobIdA,
				stepIndex: 0,
			}),
		).resolves.toBeNull();
	});

	test("over-provisioned totalSteps: a step called after the job is already assembled fails deterministically every time — the precondition the engine's maxAttemptsPerStep abandonment relies on", async () => {
		const t = withAgentEngine(convexTest(schema, modules));
		const jobId = "job-overprovisioned";
		await seedProgress(t, { orgId: "acme2", jobId });

		for (let i = 0; i < 4; i++) {
			await t.mutation(internalAny.okfBundleDurable._exportOkfBundleStepInternal, {
				orgId: "acme2",
				jobId,
				stepIndex: i,
			});
		}
		const progress = await t.run(async (ctx) =>
			ctx.db
				.query("okfDurableExportProgress")
				.withIndex("by_orgId_jobId", (q) =>
					q.eq("orgId", "acme2").eq("jobId", jobId),
				)
				.unique(),
		);
		expect(progress?.status).toBe("assembled");

		// Every extra step, repeated (mirrors what maxAttemptsPerStep retries
		// inside the engine would look like), fails with the SAME error —
		// deterministic failure is what lets the engine recognize "abandon
		// after N consecutive failures" rather than a flaky step.
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(
				t.mutation(internalAny.okfBundleDurable._exportOkfBundleStepInternal, {
					orgId: "acme2",
					jobId,
					stepIndex: 4,
				}),
			).rejects.toThrow(/OKF_DURABLE_NO_MORE_WORK/);
		}
	});
});

describe("okfBundleDurable — auth (V8-safe assertCanExportNamespaceV8, mirrors okfBundleNode.assertCanExportNamespace)", () => {
	test("rejects an empty namespace", async () => {
		const t = withAgentEngine(convexTest(schema, modules));
		await expect(
			t.mutation(apiAny.okfBundleDurable.startOkfBundleExportDurable, {
				namespace: "",
				totalSteps: 1,
			}),
		).rejects.toThrow(/OKF_NAMESPACE_INVALID/);
	});

	test("rejects a path-traversal namespace", async () => {
		const t = withAgentEngine(convexTest(schema, modules));
		await expect(
			t.mutation(apiAny.okfBundleDurable.startOkfBundleExportDurable, {
				namespace: "team/../etc",
				totalSteps: 1,
			}),
		).rejects.toThrow(/OKF_NAMESPACE_INVALID/);
	});

	test("rejects cross-tenant caller before ever reaching the component call", async () => {
		const base = withAgentEngine(convexTest(schema, modules));
		const t = base.withIdentity({ organizationId: "other-org" });
		await expect(
			t.mutation(apiAny.okfBundleDurable.startOkfBundleExportDurable, {
				namespace: "team/acme",
				totalSteps: 1,
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
	});

	test("rejects anonymous caller on a non-master namespace before ever reaching the component call", async () => {
		const t = withAgentEngine(convexTest(schema, modules));
		await expect(
			t.mutation(apiAny.okfBundleDurable.startOkfBundleExportDurable, {
				namespace: "team/acme",
				totalSteps: 1,
			}),
		).rejects.toThrow(/AUTH_NO_IDENTITY/);
	});

	test("rejects totalSteps <= 0", async () => {
		const base = withAgentEngine(convexTest(schema, modules));
		const t = base.withIdentity({
			organizationId: "elpi-corp",
			org_id: "elpi-corp",
		});
		await expect(
			t.mutation(apiAny.okfBundleDurable.startOkfBundleExportDurable, {
				namespace: "project/elpi-corp",
				totalSteps: 0,
			}),
		).rejects.toThrow(/OKF_DURABLE_INVALID_TOTAL_STEPS/);
	});
});
