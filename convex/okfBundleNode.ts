"use node";

/**
 * OKF v0.1 bundle exporter — Node-runtime split (Phase 1 — T3 REVISE).
 *
 * Runtime split (Eta REVISE verdict on PR #846):
 *   - This module hosts the public Convex `action` `exportOkfBundle` together
 *     with the `tar-stream` packer (`packTarball`) and the Phase 1 auth helper
 *     `assertCanExportNamespace`. Both touch Node globals (`Buffer`, Node
 *     streams) and `tar-stream` is a Node-only library, so the `"use node"`
 *     directive at the top of this file is mandatory.
 *   - All non-Node primitives (internal queries, internal mutation, pure
 *     helpers like `assembleBundle`, `shouldIncludeFamily`, `parseSinceArg`)
 *     stay in `convex/okfBundle.ts` (V8 runtime). This action calls them via
 *     `ctx.runQuery(internal.okfBundle.*)` / `ctx.runMutation(internal.okfBundle.*)`.
 *
 * Eta fix-pattern reference: m9781h39qvcyy4hsphthz7eg5s88yc1f
 * — "Convex action Node global ReferenceError" — co-exporting `internalQuery` /
 *    `internalMutation` in a `"use node"` module is forbidden by Convex, hence
 *    the split into two files.
 *
 * RFC parent: decisions/okf-bridge-phase-1-rfc-2026-06-18.md (commit 6613610).
 * ADR:        decisions/adr-okf-exporter-arch.md (commit 2cd357e).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-19
 */

import { v } from "convex/values";
import { pack } from "tar-stream";
import { internal as generatedInternal } from "./_generated/api";
import { action } from "./_generated/server";
import {
	applyMemorySubtypeFilter,
	assembleBundle,
	BUNDLE_HARD_CAP_BYTES,
	BUNDLE_PAGE_SIZE,
	BUNDLE_SOFT_CAP_BYTES,
	DEFAULT_URL_TTL_SECONDS,
	PHASE1_NAMESPACE,
	parseSinceArg,
	shouldIncludeFamily,
} from "./okfBundle";
import {
	type BriefingNoteDoc,
	type MemoryDoc,
	serializeBriefingNote,
	serializeMemory,
	serializeTask,
	type TaskDoc,
} from "./okfSerializer";
import { type BundleEntry, validateBundle } from "./okfValidator";

// Codegen-lag workaround (mirrors okfBundle.ts comment). The Convex codegen
// resolves FunctionReferences by module path at runtime; widening the type
// keeps this module compilable before `npx convex dev` regenerates `_generated/`.
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround
const internal = generatedInternal as any;

// ─────────────────────────────────────────────────────────────────────────────
// Pagination driver (Eta REVISE iter 2 — fix-pattern m978c0zyjav9tjmp4aq8b04j8n88zhwm).
//
// Each V8 internal query now returns `{ page, isDone, continueCursor }`. The
// Node-runtime action loops until `isDone === true`, tracking the cumulative
// byte budget so we abort early if the bundle approaches the soft cap (ADR D4).
//
// `budgetBytes` is a heuristic ceiling on the running sum of serialized row
// lengths, NOT the final tar size — `assembleBundle()` is the authoritative
// cap enforcer. This loop guard exists solely to bound the V8→Node hop count
// when a tenant has millions of rows.
// ─────────────────────────────────────────────────────────────────────────────

interface PaginatedResult<T> {
	page: T[];
	isDone: boolean;
	continueCursor: string;
}

async function collectAllPages<T>(
	runQuery: (cursor: string | null) => Promise<PaginatedResult<T>>,
	budgetBytes: number,
	approxSize: (row: T) => number,
): Promise<{ rows: T[]; truncated: boolean }> {
	const rows: T[] = [];
	let cursor: string | null = null;
	let bytes = 0;
	let truncated = false;
	// Hard ceiling on hop count to avoid runaway loops in case of pathological
	// cursor non-advance (Convex contract guarantees forward progress; this is
	// a belt-and-braces guard). 4096 hops × 256 rows = 1 048 576 rows max.
	for (let hop = 0; hop < 4096; hop++) {
		const res = await runQuery(cursor);
		for (const r of res.page) {
			rows.push(r);
			bytes += approxSize(r);
		}
		if (res.isDone) break;
		if (bytes >= budgetBytes) {
			truncated = true;
			break;
		}
		cursor = res.continueCursor;
	}
	return { rows, truncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types (mirror the V8 module — kept exported for the MCP wrapper)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportOkfBundleResult {
	bundleUrl: string;
	storageId: string;
	size: number;
	fileCount: number;
	manifest: {
		types: {
			memoryCount: number;
			briefingCount: number;
			taskCount: number;
		};
		truncated: boolean;
		urlExpiresAt: string; // ISO 8601
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarball packer — Node-only (uses Buffer + tar-stream)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pack an in-memory bundle into a tar archive. Returns the full tarball as a
 * Buffer (Phase 1 bundle ≤50 MB → fits comfortably in memory). Uses
 * `tar-stream` entry-by-entry so we never hold two full copies in RAM.
 */
export async function packTarball(
	entries: readonly BundleEntry[],
): Promise<Buffer> {
	const tar = pack();
	const chunks: Buffer[] = [];
	const flushed = new Promise<void>((resolve, reject) => {
		tar.on("data", (c: Buffer) => chunks.push(c));
		tar.on("end", () => resolve());
		tar.on("error", reject);
	});

	for (const e of entries) {
		await new Promise<void>((resolve, reject) => {
			tar.entry(
				{ name: e.path, size: Buffer.byteLength(e.content, "utf8") },
				e.content,
				(err) => (err ? reject(err) : resolve()),
			);
		});
	}
	tar.finalize();
	await flushed;
	return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth helper (RFC §4) — kept here because the action invokes it and it has
// no DB dependency. Pure check against ctx.auth + Phase 1 namespace constant.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight namespace authorization for Phase 1.
 *
 * Rules:
 *   - Phase 1 caller MUST request `project/elpi-corp`. Any other namespace →
 *     `AUTH_NAMESPACE_DENIED` (anticipates Phase 2 rules).
 *   - Identity is resolved via `ctx.auth.getUserIdentity()`. Absence is
 *     permitted when running through the Convex CLI / deploy key (mirrors
 *     `lib/auth.withOrgScope` master-scope behaviour).
 *   - When an org slug is attached, it MUST match `elpi-corp` (the suffix of
 *     the requested namespace). Mismatch → `AUTH_NAMESPACE_DENIED`.
 */
async function assertCanExportNamespace(
	ctx: { auth: { getUserIdentity: () => Promise<unknown> } },
	namespace: string,
): Promise<void> {
	if (namespace !== PHASE1_NAMESPACE) {
		throw new Error(
			`AUTH_NAMESPACE_DENIED: Phase 1 exporter is locked to "${PHASE1_NAMESPACE}", got "${namespace}".`,
		);
	}

	const identity = (await ctx.auth.getUserIdentity()) as Record<
		string,
		unknown
	> | null;
	if (identity === null || identity === undefined) {
		return;
	}
	const orgSlug =
		(identity.organizationId as string | undefined) ??
		(identity.organizationSlug as string | undefined) ??
		null;
	if (orgSlug === null) {
		return;
	}
	const expectedSuffix = namespace.split("/").slice(1).join("/");
	if (orgSlug !== expectedSuffix) {
		throw new Error(
			`AUTH_NAMESPACE_DENIED: caller org "${orgSlug}" cannot export namespace "${namespace}".`,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Public action — Node-runtime entry point invoked by MCP / Cloud surface.
// ─────────────────────────────────────────────────────────────────────────────

export const exportOkfBundle = action({
	args: {
		namespace: v.string(),
		types: v.optional(v.union(v.array(v.string()), v.null())),
		format: v.union(v.literal("tarball"), v.literal("tree")),
		since: v.optional(v.union(v.string(), v.null())),
		urlTtl: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<ExportOkfBundleResult> => {
		// 1. Auth.
		await assertCanExportNamespace(ctx, args.namespace);

		// 2. Format gate — Phase 1 supports tarball only.
		if (args.format !== "tarball") {
			throw new Error(
				`OKF_FORMAT_UNSUPPORTED: Phase 1 supports "tarball" only, got "${args.format}".`,
			);
		}

		const sinceMs = parseSinceArg(args.since ?? undefined);
		const typeFilter = args.types ?? null;

		// 3. Fetch entries (only the families requested) — via V8 internal queries.
		// Each internal query returns a paginated `{ page, isDone, continueCursor }`
		// shape; the action drives the cursor loop via `collectAllPages()` so we
		// never exceed the Convex 16 MB function-return cap (Eta REVISE iter 2).
		const FETCH_BUDGET_BYTES = BUNDLE_SOFT_CAP_BYTES; // 50 MB pre-tar budget
		// Cheap byte estimator — `content` dominates row size for all three
		// families. Using `JSON.stringify` here would double-count for nested
		// objects; reading `.content?.length` is a safe lower bound.
		const approx = (r: unknown): number => {
			const row = r as {
				content?: string;
				description?: string;
				title?: string;
			};
			return (
				(row.content?.length ?? 0) +
				(row.description?.length ?? 0) +
				(row.title?.length ?? 0) +
				256
			);
		};

		const memoriesResult = shouldIncludeFamily("memory", typeFilter)
			? await collectAllPages<MemoryDoc>(
					async (cursor) =>
						(await ctx.runQuery(internal.okfBundle._fetchMemoriesForBundle, {
							namespace: args.namespace,
							sinceMs,
							paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor },
						})) as PaginatedResult<MemoryDoc>,
					FETCH_BUDGET_BYTES,
					approx,
				)
			: { rows: [], truncated: false };
		const briefingsResult = shouldIncludeFamily("briefing", typeFilter)
			? await collectAllPages<BriefingNoteDoc>(
					async (cursor) =>
						(await ctx.runQuery(
							internal.okfBundle._fetchBriefingNotesForBundle,
							{
								namespace: args.namespace,
								sinceMs,
								paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor },
							},
						)) as PaginatedResult<BriefingNoteDoc>,
					FETCH_BUDGET_BYTES,
					approx,
				)
			: { rows: [], truncated: false };
		const tasksResult = shouldIncludeFamily("task", typeFilter)
			? await collectAllPages<TaskDoc>(
					async (cursor) =>
						(await ctx.runQuery(internal.okfBundle._fetchTasksForBundle, {
							namespace: args.namespace,
							sinceMs,
							paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor },
						})) as PaginatedResult<TaskDoc>,
					FETCH_BUDGET_BYTES,
					approx,
				)
			: { rows: [], truncated: false };
		const memories = memoriesResult.rows;
		const briefings = briefingsResult.rows;
		const tasks = tasksResult.rows;
		const fetchTruncated =
			memoriesResult.truncated ||
			briefingsResult.truncated ||
			tasksResult.truncated;

		// 4. Serialize.
		const memoryFiles = applyMemorySubtypeFilter(
			memories.map(serializeMemory),
			memories,
			typeFilter,
		);
		const briefingFiles = briefings.map(serializeBriefingNote);
		const taskFiles = tasks.map(serializeTask);

		// 5. Assemble + cap.
		const { entries, bytes, truncated } = assembleBundle(
			memoryFiles,
			briefingFiles,
			taskFiles,
			memories,
			briefings,
			tasks,
			{ softCap: BUNDLE_SOFT_CAP_BYTES, hardCap: BUNDLE_HARD_CAP_BYTES },
		);

		if (truncated) {
			console.warn(
				`[okfBundleNode] truncated bundle for namespace=${args.namespace}: ${bytes} B > ${BUNDLE_SOFT_CAP_BYTES} B`,
			);
		}

		// 6. Validate (in-memory, before upload).
		const validation = validateBundle({ entries });
		if (!validation.pass) {
			throw new Error(
				`OKF_BUNDLE_INVALID: ${validation.errors.length} error(s) — first: ${validation.errors[0].rule} at ${validation.errors[0].path}`,
			);
		}

		// 7. Pack tarball (Node Buffer).
		const tarball = await packTarball(entries);

		// 8. Upload to Convex storage.
		const tarBytes = new Uint8Array(
			tarball.buffer,
			tarball.byteOffset,
			tarball.byteLength,
		);
		// Uint8Array is a valid Blob input under both Node ≥18 and the Convex
		// Node runtime. Funnel through `unknown` array because the lib's
		// `BlobPart` narrowing rejects `Uint8Array<ArrayBufferLike>` even though
		// it is accepted at runtime.
		const blob = new Blob(
			[tarBytes] as unknown as ConstructorParameters<typeof Blob>[0],
			{ type: "application/x-tar" },
		);
		const storageId = await ctx.storage.store(blob);
		const bundleUrl = await ctx.storage.getUrl(storageId);
		if (bundleUrl === null) {
			throw new Error(
				`OKF_STORAGE_FAILED: storage.getUrl returned null for ${storageId}`,
			);
		}

		// 9. Schedule TTL-bound purge — via V8 internal mutation.
		const ttlSeconds = args.urlTtl ?? DEFAULT_URL_TTL_SECONDS;
		if (ttlSeconds > 0) {
			await ctx.scheduler.runAfter(
				ttlSeconds * 1000,
				internal.okfBundle._deleteBundleStorage,
				{ storageId },
			);
		}
		const urlExpiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

		// 10. Manifest.
		return {
			bundleUrl,
			storageId,
			size: tarball.byteLength,
			fileCount: entries.length,
			manifest: {
				types: {
					memoryCount: memoryFiles.length,
					briefingCount: briefingFiles.length,
					taskCount: taskFiles.length,
				},
				truncated: truncated || fetchTruncated,
				urlExpiresAt,
			},
		};
	},
});
