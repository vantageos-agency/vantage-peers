/**
 * OKF v0.1 bundle exporter — V8-runtime split (Phase 1 — T3 REVISE).
 *
 * Runtime split (Eta REVISE verdict on PR #846):
 *   - This module hosts the V8-runtime primitives: internal queries (DB reads
 *     for memories / briefingNotes / tasks), the internal mutation for the
 *     TTL-bound storage purge, and all pure helpers (`assembleBundle`,
 *     `shouldIncludeFamily`, `applyMemorySubtypeFilter`, `parseSinceArg`,
 *     `stripFrontmatterFence`). NO `"use node"` directive — these primitives
 *     must run in the V8 runtime so `internalQuery` / `internalMutation`
 *     remain valid Convex registrations.
 *   - The public `exportOkfBundle` action + the `tar-stream` packer
 *     (`packTarball`) + the auth helper live in `convex/okfBundleNode.ts`
 *     under `"use node"`. They invoke the V8 primitives via
 *     `ctx.runQuery(internal.okfBundle.*)` / `ctx.runMutation(internal.okfBundle.*)`.
 *
 * IMPORTANT — no Node globals:
 *   `Buffer` is forbidden in this module (V8 runtime has no Buffer). UTF-8 byte
 *   length is computed via `TextEncoder` (Web standard, available in both V8
 *   and Node runtimes).
 *
 * Bundle layout (RFC §3.3):
 *   index.md
 *   log.md
 *   memories/<id>.md
 *   briefing-notes/<id>.md
 *   tasks/<id>.md
 *
 * Caps (ADR D4):
 *   - Soft cap  50 MB → manifest flag `truncated: true`, packing halts early.
 *   - Hard cap 100 MB → action throws `OKF_BUNDLE_REFUSED`.
 *
 * URL TTL (ADR D5):
 *   - Default 3600 s, configurable via `urlTtl` arg.
 *
 * Eta fix-pattern reference: m9781h39qvcyy4hsphthz7eg5s88yc1f
 * RFC parent: decisions/okf-bridge-phase-1-rfc-2026-06-18.md (commit 6613610).
 * ADR:        decisions/adr-okf-exporter-arch.md (commit 2cd357e).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-19
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
	type BriefingNoteDoc,
	type MemoryDoc,
	type SerializedFile,
	serializeIndex,
	serializeLog,
	type TaskDoc,
} from "./okfSerializer";
import type { BundleEntry } from "./okfValidator";
import { creatorValidator, memoryTypeValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (ADR D4 + D5) — re-exported for the Node-runtime action.
// ─────────────────────────────────────────────────────────────────────────────

export const BUNDLE_SOFT_CAP_BYTES = 50 * 1024 * 1024; // 50 MB
export const BUNDLE_HARD_CAP_BYTES = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_URL_TTL_SECONDS = 3600; // 1 hour
export const PHASE1_NAMESPACE = "project/elpi-corp";
// Pagination batch size for V8 internal queries (Eta REVISE iter 2 fix).
// Keeps each runQuery() return payload well under the Convex 16 MB
// function-return cap that triggered the original failure
// (`exportOkfBundle` 16 MB byte limit error on `.collect()` unfiltered reads).
export const BUNDLE_PAGE_SIZE = 256;
const TYPE_MEMORY_PREFIX = "memory-";
const TYPE_BRIEFING = "briefing-note";
const TYPE_TASK = "task";

// ─────────────────────────────────────────────────────────────────────────────
// Namespace → org-scope mapping (Eta REVISE iter 2 — cross-namespace leak fix)
//
// Phase 1 locks every export to `project/elpi-corp` (master / internal Alpha
// tenant). Per `convex/schema.ts` lines 252-254 + 304-306, briefingNotes and
// tasks use `orgId` for multi-tenant scoping where `null`/`undefined` ==
// master, and a Clerk org slug like `"acme-hr"` == client-scoped row.
//
// `memories` already has a first-class `namespace` column so it is filtered
// directly by the existing `by_namespace` index (no extra mapping needed).
//
// For briefingNotes/tasks we derive the expected orgId from the requested
// namespace:
//   - `project/elpi-corp`           → `undefined` (master)
//   - `project/<other>` (Phase 2)   → `<other>` (Clerk org slug)
//
// `matchesNamespaceScope` is applied as a belt-and-braces in-memory filter
// after the index-bounded pagination scan to guarantee zero cross-namespace
// leak even for legacy rows missing an orgId.
// ─────────────────────────────────────────────────────────────────────────────

export function expectedOrgIdForNamespace(
	namespace: string,
): string | undefined {
	if (namespace === PHASE1_NAMESPACE) return undefined;
	const tail = namespace.split("/").slice(1).join("/");
	return tail === "" ? undefined : tail;
}

export function matchesNamespaceScope(
	row: { orgId?: string | null | undefined },
	namespace: string,
): boolean {
	const expected = expectedOrgIdForNamespace(namespace);
	const actual = row.orgId ?? undefined;
	return actual === expected;
}

// ─────────────────────────────────────────────────────────────────────────────
// V8-safe UTF-8 byte length (no Buffer).
// TextEncoder is a Web standard available in both V8 and Node runtimes; it
// yields identical results to `Buffer.byteLength(s, "utf8")` for arbitrary
// JS strings. Allocating a Uint8Array per call is cheap relative to the
// surrounding I/O and avoids the Buffer global which is undefined under V8.
// ─────────────────────────────────────────────────────────────────────────────

const UTF8 = new TextEncoder();
function byteLengthUtf8(s: string): number {
	return UTF8.encode(s).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal queries — fetch entries per type.
// Kept as internal so they cannot be called from MCP / public surface; the
// public `exportOkfBundle` action gates them behind the auth check.
// ─────────────────────────────────────────────────────────────────────────────

// All three internal queries now return a paginated page (Eta REVISE iter 2
// fix-pattern m978c0zyjav9tjmp4aq8b04j8n88zhwm). The Node-runtime action
// drives the cursor loop via `collectAllPages()` in `okfBundleNode.ts`.
//
// Each query MUST scope its index lookup by the requested namespace and apply
// `matchesNamespaceScope()` as a belt-and-braces post-filter to guarantee
// zero cross-namespace leak. The `sinceMs` filter is applied last on the
// already-scoped page (the original bug was that `.collect()` was unbounded
// AND cross-namespace, defeating `assertCanExportNamespace`).
//
// Return shape mirrors `ctx.db.query().paginate(...)`:
//   { page: T[], isDone: boolean, continueCursor: string }

const PAGINATION_OPTS_VALIDATOR = v.object({
	numItems: v.number(),
	cursor: v.union(v.string(), v.null()),
});

export const _fetchMemoriesForBundle = internalQuery({
	args: {
		namespace: v.string(),
		sinceMs: v.optional(v.number()),
		paginationOpts: PAGINATION_OPTS_VALIDATOR,
	},
	handler: async (ctx, args) => {
		const result = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.eq("namespace", args.namespace).eq("isLatest", true),
			)
			.paginate(args.paginationOpts);
		const since = args.sinceMs;
		// Defense-in-depth: re-assert namespace match (the by_namespace index
		// already guarantees it, but we mirror the briefing/task guard for
		// uniformity and to catch any future index-config regression).
		const scoped = result.page.filter((r) => r.namespace === args.namespace);
		const filtered =
			since === undefined
				? scoped
				: scoped.filter(
						(r) => (r.updatedAt ?? r.createdAt ?? r._creationTime) >= since,
					);
		return {
			page: filtered,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

export const _fetchBriefingNotesForBundle = internalQuery({
	args: {
		namespace: v.string(),
		sinceMs: v.optional(v.number()),
		paginationOpts: PAGINATION_OPTS_VALIDATOR,
	},
	handler: async (ctx, args) => {
		const expectedOrgId = expectedOrgIdForNamespace(args.namespace);
		// Use the `by_orgId` index for tenant-scoped reads. Convex treats
		// `q.eq("orgId", undefined)` as matching rows where the field is unset
		// (master tenant), which is the Phase 1 case for `project/elpi-corp`.
		const result = await ctx.db
			.query("briefingNotes")
			.withIndex("by_orgId", (q) => q.eq("orgId", expectedOrgId))
			.paginate(args.paginationOpts);
		const since = args.sinceMs;
		const scoped = result.page.filter((r) =>
			matchesNamespaceScope(r, args.namespace),
		);
		const filtered =
			since === undefined
				? scoped
				: scoped.filter(
						(r) => (r.updatedAt ?? r.createdAt ?? r._creationTime) >= since,
					);
		return {
			page: filtered,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

export const _fetchTasksForBundle = internalQuery({
	args: {
		namespace: v.string(),
		sinceMs: v.optional(v.number()),
		paginationOpts: PAGINATION_OPTS_VALIDATOR,
	},
	handler: async (ctx, args) => {
		const expectedOrgId = expectedOrgIdForNamespace(args.namespace);
		const result = await ctx.db
			.query("tasks")
			.withIndex("by_orgId", (q) => q.eq("orgId", expectedOrgId))
			.paginate(args.paginationOpts);
		const since = args.sinceMs;
		const scoped = result.page.filter((r) =>
			matchesNamespaceScope(r, args.namespace),
		);
		const filtered =
			since === undefined
				? scoped
				: scoped.filter(
						(r) => (r.updatedAt ?? r.createdAt ?? r._creationTime) >= since,
					);
		return {
			page: filtered,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutation — TTL-bound storage purge (ADR D5)
// ─────────────────────────────────────────────────────────────────────────────

export const _deleteBundleStorage = internalMutation({
	args: { storageId: v.string() },
	handler: async (ctx, args) => {
		try {
			await ctx.storage.delete(args.storageId as never);
		} catch (e) {
			console.warn(
				`[okfBundle] TTL purge: storage.delete failed for ${args.storageId}`,
				e instanceof Error ? e.message : String(e),
			);
		}
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests + the Node-runtime action)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip a leading `---\n...\n---\n` YAML frontmatter fence from a markdown
 * document, returning only the body. Used to satisfy OKF spec §1.5 which
 * forbids frontmatter on `log.md` even though the T1 serializer emits one.
 * If no fence is detected, returns the input unchanged.
 */
export function stripFrontmatterFence(content: string): string {
	const re = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
	return content.replace(re, "");
}

/**
 * Decide whether a given OKF type filter should include the given entity
 * family. `filter === null` (or empty) means "include all three families".
 *
 * Recognised type tokens:
 *   - "memory-*"      → memories (any subtype)
 *   - "memory-<sub>"  → memories where serialized type === literal
 *   - "briefing-note" → briefingNotes
 *   - "task"          → tasks
 */
export function shouldIncludeFamily(
	family: "memory" | "briefing" | "task",
	filter: readonly string[] | null | undefined,
): boolean {
	if (filter === null || filter === undefined || filter.length === 0) {
		return true;
	}
	if (family === "memory") {
		return filter.some(
			(t) => t === "memory-*" || t.startsWith(TYPE_MEMORY_PREFIX),
		);
	}
	if (family === "briefing") return filter.includes(TYPE_BRIEFING);
	return filter.includes(TYPE_TASK);
}

/**
 * Filter serialized memory files by subtype tokens when the caller passed a
 * memory-<sub> literal filter (no wildcard). When `memory-*` is among the
 * tokens — or no token at all — keep all memories.
 */
export function applyMemorySubtypeFilter(
	files: readonly SerializedFile[],
	memories: readonly MemoryDoc[],
	filter: readonly string[] | null | undefined,
): SerializedFile[] {
	if (filter === null || filter === undefined || filter.length === 0) {
		return [...files];
	}
	if (filter.includes("memory-*")) return [...files];
	const allowed = new Set(
		filter.filter((t) => t.startsWith(TYPE_MEMORY_PREFIX)),
	);
	if (allowed.size === 0) return [];
	return files.filter((_, i) => allowed.has(`memory-${memories[i].type}`));
}

/**
 * Parse ISO 8601 `since` arg into epoch ms. Returns undefined for nullish
 * input; throws `OKF_INVALID_SINCE` for malformed values so callers see a
 * structured error instead of a silent ignore.
 */
export function parseSinceArg(
	since: string | null | undefined,
): number | undefined {
	if (since === null || since === undefined || since === "") return undefined;
	const ms = Date.parse(since);
	if (!Number.isFinite(ms)) {
		throw new Error(
			`OKF_INVALID_SINCE: "${since}" is not a valid ISO 8601 timestamp.`,
		);
	}
	return ms;
}

/**
 * Build the in-memory bundle (array of {path, content}) from the serialized
 * inputs + index/log. Respects the soft / hard size caps.
 *
 * @returns the bundle, the running byte count, and a `truncated` flag.
 * @throws  `OKF_BUNDLE_REFUSED` if the hard cap is exceeded by a single entry.
 */
export function assembleBundle(
	memoryFiles: readonly SerializedFile[],
	briefingFiles: readonly SerializedFile[],
	taskFiles: readonly SerializedFile[],
	memories: readonly MemoryDoc[],
	briefings: readonly BriefingNoteDoc[],
	tasks: readonly TaskDoc[],
	caps: { softCap: number; hardCap: number },
): { entries: BundleEntry[]; bytes: number; truncated: boolean } {
	const entries: BundleEntry[] = [];
	let bytes = 0;
	let truncated = false;

	const push = (f: SerializedFile): boolean => {
		const size = byteLengthUtf8(f.content);
		if (size > caps.hardCap) {
			throw new Error(
				`OKF_BUNDLE_REFUSED: single entry ${f.filePath} (${size} B) exceeds hard cap ${caps.hardCap} B.`,
			);
		}
		if (bytes + size > caps.hardCap) {
			throw new Error(
				`OKF_BUNDLE_REFUSED: bundle would exceed hard cap ${caps.hardCap} B at ${f.filePath}.`,
			);
		}
		if (bytes + size > caps.softCap) {
			truncated = true;
			return false; // stop appending further entries
		}
		entries.push({ path: f.filePath, content: f.content });
		bytes += size;
		return true;
	};

	// Push the index + log first so they are always present even if truncated.
	const indexFile = serializeIndex({
		memories: memories as MemoryDoc[],
		briefingNotes: briefings as BriefingNoteDoc[],
		tasks: tasks as TaskDoc[],
	});
	const logFile = serializeLog({
		memories: memories as MemoryDoc[],
		briefingNotes: briefings as BriefingNoteDoc[],
		tasks: tasks as TaskDoc[],
	});
	// OKF spec §1.5: log.md MUST NOT have YAML frontmatter. T1 serializer emits
	// one anyway (because it reuses the same emit helper); strip it here so the
	// bundle passes T2 validation. Body-only log content is preserved verbatim.
	const logBody = stripFrontmatterFence(logFile.content);
	entries.push({ path: indexFile.filePath, content: indexFile.content });
	entries.push({ path: logFile.filePath, content: logBody });
	bytes += byteLengthUtf8(indexFile.content);
	bytes += byteLengthUtf8(logBody);

	const all: SerializedFile[] = [
		...memoryFiles,
		...briefingFiles,
		...taskFiles,
	];
	for (const f of all) {
		if (!push(f)) break;
	}

	return { entries, bytes, truncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// B2 — import_okf_bundle internal queries + mutations (mission k5779qbxh)
//
// The Node-runtime action `okfBundleNode:importOkfBundle` orchestrates the
// import pipeline (auth → fetch → unpack → validate → per-entry parse+insert)
// and delegates DB writes to these V8-runtime helpers. Dedup strategy is
// content-equality scoped to the target namespace (memories) or to a small
// title+body lookup (briefings, tasks). First-cut O(N) per import — index
// optimisation deferred to a separate PR.
// ─────────────────────────────────────────────────────────────────────────────

export const _findMemoryByContent = internalQuery({
	args: { namespace: v.string(), content: v.string() },
	handler: async (ctx, { namespace, content }) => {
		const rows = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.eq("namespace", namespace).eq("isLatest", true),
			)
			.collect();
		const hit = rows.find((r) => r.content === content);
		return hit ? hit._id : null;
	},
});

export const _findBriefingByTitleAndContent = internalQuery({
	args: { title: v.string(), content: v.string() },
	handler: async (ctx, { title, content }) => {
		const rows = await ctx.db
			.query("briefingNotes")
			.withIndex("by_topic")
			.collect();
		const hit = rows.find((r) => r.title === title && r.content === content);
		return hit ? hit._id : null;
	},
});

export const _findTaskByTitleAndDescription = internalQuery({
	args: { title: v.string(), description: v.string() },
	handler: async (ctx, { title, description }) => {
		const rows = await ctx.db.query("tasks").withIndex("by_status").collect();
		const hit = rows.find(
			(r) => r.title === title && (r.description ?? "") === description,
		);
		return hit ? hit._id : null;
	},
});

export const _insertImportedMemory = internalMutation({
	args: {
		namespace: v.string(),
		type: memoryTypeValidator,
		content: v.string(),
		createdBy: creatorValidator,
		now: v.number(),
	},
	handler: async (ctx, args) => {
		return await ctx.db.insert("memories", {
			namespace: args.namespace,
			type: args.type,
			content: args.content,
			createdBy: args.createdBy,
			relations: [],
			isLatest: true,
			createdAt: args.now,
			updatedAt: args.now,
		});
	},
});

export const _insertImportedBriefing = internalMutation({
	args: {
		title: v.string(),
		topic: v.string(),
		participants: v.array(v.string()),
		content: v.string(),
		createdBy: creatorValidator,
		now: v.number(),
	},
	handler: async (ctx, args) => {
		return await ctx.db.insert("briefingNotes", {
			title: args.title,
			topic: args.topic,
			participants: args.participants,
			content: args.content,
			createdBy: args.createdBy,
			createdAt: args.now,
		});
	},
});

export const _insertImportedTask = internalMutation({
	args: {
		title: v.string(),
		description: v.optional(v.string()),
		assignedTo: v.string(),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		status: v.union(
			v.literal("todo"),
			v.literal("in_progress"),
			v.literal("review"),
			v.literal("blocked"),
			v.literal("done"),
		),
		createdBy: creatorValidator,
		now: v.number(),
	},
	handler: async (ctx, args) => {
		return await ctx.db.insert("tasks", {
			title: args.title,
			description: args.description,
			assignedTo: args.assignedTo,
			priority: args.priority,
			status: args.status,
			createdBy: args.createdBy,
			createdAt: args.now,
			updatedAt: args.now,
		});
	},
});
