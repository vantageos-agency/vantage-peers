/**
 * OKF v0.1 bundle exporter — DURABLE variant (I1 — long-task survival).
 *
 * A Convex `action` has a hard wall-clock ceiling. That ceiling is the
 * ceiling on every product built on this stack (bible SYNTHESE.md §5/§7:
 * "le plafond de durée des actions Convex est notre plafond aujourd'hui, sur
 * tous nos produits"). `okfBundleNode.ts:exportOkfBundle` is a plain Convex
 * `action` that pages through `BUNDLE_PAGE_SIZE`-row pages of memories,
 * briefing notes and tasks inside ONE action call; on a large tenant it hits
 * the ceiling by construction.
 *
 * This module expresses the SAME fetch as N independently-bounded steps
 * driven by the `@vantageos/agent-engine` durable job engine
 * (`components.agentEngine.engine.durableJob`), so a large export survives a
 * kill/redeploy mid-run. `exportOkfBundle` itself is UNCHANGED and remains
 * the live public API for bundles that fit inside one action call — this is
 * an additive path, not a replacement.
 *
 * V8 runtime — no `"use node"` here. Pagination/DB reads only; `tar-stream`
 * packing (Node-only) is deliberately NOT part of any step (see LIMITATION
 * below).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Step decomposition
 * ─────────────────────────────────────────────────────────────────────────
 * One step == one `BUNDLE_PAGE_SIZE` page of ONE family (memories, then
 * briefing notes, then tasks), read via the SAME internal V8 queries
 * `okfBundle.ts` already uses for the non-durable action
 * (`_fetchMemoriesForBundle` / `_fetchBriefingNotesForBundle` /
 * `_fetchTasksForBundle`), so both paths share one tenant-scoping
 * implementation instead of duplicating it.
 *
 * The step function's argument shape is FIXED by the engine contract:
 * exactly `{ orgId, jobId, stepIndex }`. The engine drives the index; it
 * never reads our tables. Because engine replay guarantees
 * `stepIndex < cursor` is a no-op and steps run strictly in order, the step
 * body does not need `stepIndex` for anything except a defence-in-depth
 * sanity check — the REAL state (which family, which cursor) lives in our
 * own `okfDurableExportProgress` row, keyed by `jobId`.
 *
 * `totalSteps` is caller-estimated at `start()` time (pages can't be counted
 * without a full scan first). If the caller under-estimates and the engine
 * invokes MORE steps than there is work left, the step function throws
 * `OKF_DURABLE_NO_MORE_WORK` deterministically — every such extra step fails
 * the same way, which is exactly what the engine's
 * `maxAttemptsPerStep`-consecutive-failure abandonment contract is built to
 * catch. This is also what the abandonment test below exercises: it is a
 * REAL failure mode (over-provisioned `totalSteps`), not a synthetic poison
 * pill.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIMITATION — read this before wiring a caller to this path
 * ─────────────────────────────────────────────────────────────────────────
 * This module produces a DURABLE, RESUMABLE FETCH of the bundle contents
 * (persisted page-by-page into `okfDurableExportEntries`) and a manifest of
 * counts. It does NOT pack a tarball or upload to storage — `tar-stream`
 * needs Node globals (`Buffer`), and step functions are constrained by the
 * engine contract to be plain `internalMutation`s, which run on the V8
 * runtime (no Node globals). Packing must happen in a SEPARATE Node
 * `action` (mirroring the existing `okfBundleNode.ts` split) that runs
 * AFTER the durable job's `status` is `"completed"`, reads the persisted
 * `okfDurableExportEntries` rows via an internal query, and calls the
 * already-tested `packTarball()` / `assembleBundle()` / `validateBundle()`
 * helpers. That finishing action is NOT implemented in this pass — a caller
 * integrating this path today gets a fully-durable fetch plus row counts,
 * not yet a downloadable tarball. Tracked as a follow-up; do not assume the
 * tarball exists without that action.
 */

import { createFunctionHandle } from "convex/server";
import { v } from "convex/values";
import { components, internal as generatedInternal } from "./_generated/api";
import {
	internalMutation,
	mutation,
	query,
} from "./_generated/server";
import { BUNDLE_PAGE_SIZE } from "./okfBundle";

// Codegen-lag workaround (mirrors okfBundle.ts / okfBundleNode.ts comment).
// `components.agentEngine.*` is not yet in `_generated/api.d.ts`'s typed
// `fullApi` surface offline (that requires `npx convex codegen` against a
// live deployment, which this worktree does not have credentials for — see
// the package README's "two gates" section). `componentsGeneric()` resolves
// component paths dynamically at RUNTIME regardless of the typed surface, so
// this only widens compile-time types, not runtime behaviour.
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround
const internal = generatedInternal as any;
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround
const agentEngineComponents = components as any;

// ─────────────────────────────────────────────────────────────────────────
// Auth — V8-safe duplicate of okfBundleNode.ts:assertCanExportNamespace.
//
// The original lives in a `"use node"` file (tar-stream requires it at the
// module level); this module must stay V8-runtime because it registers
// `internalMutation`s. The logic is intentionally identical — see
// okfBundleNode.ts for the authoritative comment history (Eta REVISE
// iter-2 #888 fail-closed fix, generalized non-master namespaces #B3).
// ─────────────────────────────────────────────────────────────────────────

const MASTER_NAMESPACE = "project/elpi-corp";

async function assertCanExportNamespaceV8(
	ctx: { auth: { getUserIdentity: () => Promise<unknown> } },
	namespace: string,
): Promise<void> {
	if (typeof namespace !== "string" || namespace.length === 0) {
		throw new Error(
			`OKF_NAMESPACE_INVALID: namespace must be a non-empty string, got "${namespace}".`,
		);
	}
	if (namespace.includes("..")) {
		throw new Error(
			`OKF_NAMESPACE_INVALID: namespace "${namespace}" contains a path-traversal segment.`,
		);
	}
	const identity = (await ctx.auth.getUserIdentity()) as Record<
		string,
		unknown
	> | null;
	const isMasterNamespace = namespace === MASTER_NAMESPACE;
	if (identity === null || identity === undefined) {
		if (isMasterNamespace) return;
		throw new Error(
			`AUTH_NO_IDENTITY: anonymous caller cannot export non-master namespace "${namespace}".`,
		);
	}
	// Slug-first, id excluded: `orgSlug` is compared below to a slug-shaped
	// export namespace suffix, and an org_id (org_xxxxx) is not a slug -- it
	// must never stand in for one. Mirrors #1224 item 4
	// (requireOrgAdmin/withOrgScope: slug-first, id excluded). A token
	// carrying only an org_id (no slug) resolves orgSlug === null here and
	// falls into the AUTH_NO_ORG fail-closed branch below, rather than
	// mis-comparing the id to a slug suffix.
	const orgSlug =
		(identity.organizationSlug as string | undefined) ??
		(identity.org_slug as string | undefined) ??
		null;
	if (orgSlug === null) {
		if (isMasterNamespace) return;
		throw new Error(
			`AUTH_NO_ORG: caller without org affiliation cannot export non-master namespace "${namespace}".`,
		);
	}
	const expectedSuffix = namespace.split("/").slice(1).join("/");
	if (orgSlug !== expectedSuffix) {
		throw new Error(
			`AUTH_NAMESPACE_DENIED: caller org "${orgSlug}" cannot export namespace "${namespace}".`,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────
// Public mutation — start the durable export.
// ─────────────────────────────────────────────────────────────────────────

export const startOkfBundleExportDurable = mutation({
	args: {
		namespace: v.string(),
		sinceMs: v.optional(v.number()),
		totalSteps: v.number(),
		maxAttemptsPerStep: v.optional(v.number()),
	},
	returns: v.string(),
	handler: async (ctx, args): Promise<string> => {
		await assertCanExportNamespaceV8(ctx, args.namespace);

		if (args.totalSteps <= 0) {
			throw new Error(
				`OKF_DURABLE_INVALID_TOTAL_STEPS: totalSteps must be > 0, got ${args.totalSteps}.`,
			);
		}

		const stepHandle = await createFunctionHandle(
			internal.okfBundleDurable._exportOkfBundleStepInternal,
		);

		const jobId: string = await ctx.runMutation(
			agentEngineComponents.agentEngine.engine.durableJob.start,
			{
				// `orgId` is passed as an explicit argument, NOT read from
				// `ctx.auth`, because Convex does not propagate the caller
				// identity across a component boundary. The calling app has
				// already authenticated the namespace (see
				// `assertCanExportNamespaceV8` above), and hands the engine
				// the verified tenant scope. `args.namespace` IS our tenant
				// scope — the same value stored as `orgId` on the
				// `okfDurableExportProgress` row a few lines below.
				orgId: args.namespace,
				kind: "vantage-peers.okf-export-durable",
				stepFunctionHandle: stepHandle,
				totalSteps: args.totalSteps,
				maxAttemptsPerStep: args.maxAttemptsPerStep ?? 3,
			},
		);

		const now = Date.now();
		await ctx.db.insert("okfDurableExportProgress", {
			jobId,
			// `orgId` handed to every step IS the namespace — the engine treats
			// `orgId` as an opaque tenant-scope string, it never interprets it.
			orgId: args.namespace,
			namespace: args.namespace,
			sinceMs: args.sinceMs,
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

		return jobId;
	},
});

// ─────────────────────────────────────────────────────────────────────────
// Step function — the engine calls this once per step index with EXACTLY
// `{ orgId, jobId, stepIndex }`. Registered as a plain `internalMutation`
// per the fixed contract.
// ─────────────────────────────────────────────────────────────────────────

export const _exportOkfBundleStepInternal = internalMutation({
	args: {
		orgId: v.string(),
		jobId: v.string(),
		stepIndex: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const progress = await ctx.db
			.query("okfDurableExportProgress")
			.withIndex("by_orgId_jobId", (q) =>
				q.eq("orgId", args.orgId).eq("jobId", args.jobId),
			)
			.unique();

		if (progress === null) {
			throw new Error(
				`OKF_DURABLE_PROGRESS_MISSING: no progress row for orgId="${args.orgId}" jobId="${args.jobId}". A step must never run before startOkfBundleExportDurable created its row.`,
			);
		}

		// Defence-in-depth cross-tenant guard: the progress row's own orgId
		// must match what the engine handed this step. The engine's
		// `stepFunctionHandle` invocation always passes back the `orgId` given
		// to `start()`, so this can only diverge if the progress row itself
		// were looked up under the wrong scope — which the compound
		// `by_orgId_jobId` index above already prevents structurally. This
		// assertion exists so a future refactor that weakens the index lookup
		// fails LOUD instead of silently reading another org's row.
		if (progress.orgId !== args.orgId) {
			throw new Error(
				`OKF_DURABLE_CROSS_TENANT: step orgId="${args.orgId}" does not match progress row orgId="${progress.orgId}" for jobId="${args.jobId}".`,
			);
		}

		if (!progress.memoriesDone) {
			const page = await ctx.runQuery(
				internal.okfBundle._fetchMemoriesForBundle,
				{
					namespace: progress.namespace,
					sinceMs: progress.sinceMs,
					paginationOpts: {
						numItems: BUNDLE_PAGE_SIZE,
						cursor: progress.memoriesCursor,
					},
				},
			);
			let seq = progress.stepsCompleted * BUNDLE_PAGE_SIZE;
			for (const row of page.page as Array<{ content: string; _id: string }>) {
				await ctx.db.insert("okfDurableExportEntries", {
					orgId: args.orgId,
					jobId: args.jobId,
					family: "memory",
					seq: seq++,
					path: `memories/${row._id}.md`,
					content: row.content,
				});
			}
			await ctx.db.patch(progress._id, {
				memoriesCursor: page.isDone ? null : page.continueCursor,
				memoriesDone: page.isDone,
				memoryCount: progress.memoryCount + page.page.length,
				stepsCompleted: progress.stepsCompleted + 1,
				updatedAt: Date.now(),
			});
			return null;
		}

		if (!progress.briefingsDone) {
			const page = await ctx.runQuery(
				internal.okfBundle._fetchBriefingNotesForBundle,
				{
					namespace: progress.namespace,
					sinceMs: progress.sinceMs,
					paginationOpts: {
						numItems: BUNDLE_PAGE_SIZE,
						cursor: progress.briefingsCursor,
					},
				},
			);
			let seq = progress.stepsCompleted * BUNDLE_PAGE_SIZE;
			for (const row of page.page as Array<{ content: string; _id: string }>) {
				await ctx.db.insert("okfDurableExportEntries", {
					orgId: args.orgId,
					jobId: args.jobId,
					family: "briefing",
					seq: seq++,
					path: `briefing-notes/${row._id}.md`,
					content: row.content,
				});
			}
			await ctx.db.patch(progress._id, {
				briefingsCursor: page.isDone ? null : page.continueCursor,
				briefingsDone: page.isDone,
				briefingCount: progress.briefingCount + page.page.length,
				stepsCompleted: progress.stepsCompleted + 1,
				updatedAt: Date.now(),
			});
			return null;
		}

		if (!progress.tasksDone) {
			const page = await ctx.runQuery(internal.okfBundle._fetchTasksForBundle, {
				namespace: progress.namespace,
				sinceMs: progress.sinceMs,
				paginationOpts: {
					numItems: BUNDLE_PAGE_SIZE,
					cursor: progress.tasksCursor,
				},
			});
			let seq = progress.stepsCompleted * BUNDLE_PAGE_SIZE;
			for (const row of page.page as Array<{
				description?: string;
				title: string;
				_id: string;
			}>) {
				await ctx.db.insert("okfDurableExportEntries", {
					orgId: args.orgId,
					jobId: args.jobId,
					family: "task",
					seq: seq++,
					path: `tasks/${row._id}.md`,
					content: row.description ?? row.title,
				});
			}
			await ctx.db.patch(progress._id, {
				tasksCursor: page.isDone ? null : page.continueCursor,
				tasksDone: page.isDone,
				taskCount: progress.taskCount + page.page.length,
				stepsCompleted: progress.stepsCompleted + 1,
				updatedAt: Date.now(),
			});
			return null;
		}

		if (progress.status === "running") {
			await ctx.db.patch(progress._id, {
				status: "assembled",
				stepsCompleted: progress.stepsCompleted + 1,
				updatedAt: Date.now(),
			});
			return null;
		}

		// All three families are done AND the job was already marked
		// "assembled" — this step index is EXTRA, past the real amount of
		// work. Caller over-estimated `totalSteps` at `start()` time. Throw
		// deterministically so the engine's maxAttemptsPerStep abandonment
		// contract can catch it (see module doc "Step decomposition").
		throw new Error(
			`OKF_DURABLE_NO_MORE_WORK: step ${args.stepIndex} invoked after job "${args.jobId}" already assembled all families.`,
		);
	},
});

// ─────────────────────────────────────────────────────────────────────────
// Status / cancel wrappers — thin passthrough to the engine, enriched with
// our own manifest counts.
// ─────────────────────────────────────────────────────────────────────────

export const getOkfBundleExportDurableStatus = query({
	args: { jobId: v.string() },
	returns: v.object({
		status: v.union(
			v.literal("running"),
			v.literal("completed"),
			v.literal("abandoned"),
			v.literal("cancelled"),
		),
		cursor: v.number(),
		totalSteps: v.number(),
		lastError: v.optional(v.string()),
		abandonedAtStep: v.optional(v.number()),
		manifest: v.union(
			v.object({
				memoryCount: v.number(),
				briefingCount: v.number(),
				taskCount: v.number(),
				assembled: v.boolean(),
			}),
			v.null(),
		),
	}),
	handler: async (ctx, args) => {
		const engineStatus = await ctx.runQuery(
			agentEngineComponents.agentEngine.engine.durableJob.getStatus,
			{ jobId: args.jobId },
		);
		const progress = await ctx.db
			.query("okfDurableExportProgress")
			.withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
			.unique();
		return {
			...engineStatus,
			manifest:
				progress === null
					? null
					: {
							memoryCount: progress.memoryCount,
							briefingCount: progress.briefingCount,
							taskCount: progress.taskCount,
							assembled: progress.status === "assembled",
						},
		};
	},
});

export const cancelOkfBundleExportDurable = mutation({
	args: { jobId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.runMutation(
			agentEngineComponents.agentEngine.engine.durableJob.cancel,
			{ jobId: args.jobId },
		);
		return null;
	},
});
