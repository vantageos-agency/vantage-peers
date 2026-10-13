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

import { isFleetStamp, type OrgRef, sameOrg } from "@vantageos/cloud-identity";
import { v } from "convex/values";
import type { DatabaseReader } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { lookupOrgMapping, orgRefOfRow } from "./lib/authOrgMapping";
import { fleetOperatorRef } from "./lib/operatorOrg";
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
import { actorIdResolver, taskActorIdFields } from "./lib/actorIds";
import { stampOfNamespace } from "./lib/memoryTenant";
import { agentIdOfLabelInOrg } from "./lib/rosterLabels";

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
// Namespace → organisation, BY ID (Eta REVISE iter 2 — cross-namespace leak fix;
// module F1 — the organisation is its permanent Clerk org ID, never its slug).
//
// Phase 1 locks every export to `project/elpi-corp` (master / internal Alpha
// tenant). briefingNotes and tasks carry the owning organisation's permanent
// Clerk org ID (`clerkOrgId`, beside the renamable slug label `orgId`); a row
// with neither is the fleet's. The namespace names an organisation by that ID
// (`team/<orgId>`) or, for a namespace written before IDs, by its slug label:
//   - `project/elpi-corp`           -> the FLEET: rows stamped with the operator
//                                      org's ID, and unstamped rows;
//   - `team/<id>` / `project/<x>`   -> the active organisation the segment names
//                                      (found by ID, else by its current label);
//                                      its rows are the rows stamped with ITS ID.
//
// `memories` already has a first-class `namespace` column so it is filtered
// directly by the existing `by_namespace` index (no extra mapping needed).
//
// `ownsRow` is applied as a belt-and-braces in-memory filter after the
// index-bounded pagination scan to guarantee zero cross-namespace leak even for
// legacy rows missing an ID. The organisation compare is the package's
// (`sameOrg`, `isFleetStamp`): a label match never grants.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a namespace's briefing-note and task rows live. */
export type NamespaceTarget =
	| { kind: "fleet"; operator: OrgRef | undefined }
	| {
			kind: "org";
			org: OrgRef;
			slug: string;
			/** The organisation's permanent ID; absent while its mapping row carries none. */
			clerkOrgId: string | undefined;
	  }
	| { kind: "none" };

/**
 * The segment of a namespace that names its organisation (`team/<seg>`,
 * `project/<seg>`), or undefined when it names none (the fleet).
 */
function organisationSegment(namespace: string): string | undefined {
	const tail = namespace.split("/").slice(1).join("/");
	return tail === "" ? undefined : tail;
}

export async function namespaceTarget(
	db: DatabaseReader,
	namespace: string,
): Promise<NamespaceTarget> {
	const segment =
		namespace === PHASE1_NAMESPACE ? undefined : organisationSegment(namespace);
	if (segment === undefined) {
		return { kind: "fleet", operator: await fleetOperatorRef(db) };
	}
	const mapping =
		(await lookupOrgMapping({ db }, { clerkOrgId: segment })) ??
		(await lookupOrgMapping({ db }, segment));
	if (mapping === null || !mapping.isActive) return { kind: "none" };
	return {
		kind: "org",
		org: { id: mapping.clerkOrgId, label: mapping.clerkOrgSlug },
		slug: mapping.clerkOrgSlug,
		clerkOrgId: mapping.clerkOrgId,
	};
}

/** The `clerkOrgId` values whose index ranges hold the target's rows (undefined = unstamped). */
function targetKeys(target: NamespaceTarget): (string | undefined)[] {
	if (target.kind === "none") return [];
	if (target.kind === "org") {
		return target.clerkOrgId === undefined ? [] : [target.clerkOrgId];
	}
	return typeof target.operator?.id === "string"
		? [target.operator.id, undefined]
		: [undefined];
}

/** Does this row belong to the namespace's organisation? Decided by ID, by the package. */
export function ownsRow(
	row: { orgId?: string | null; clerkOrgId?: string | null },
	target: NamespaceTarget,
): boolean {
	if (target.kind === "none") return false;
	const stamp = orgRefOfRow({
		...(row.orgId == null ? {} : { orgId: row.orgId }),
		...(row.clerkOrgId == null ? {} : { clerkOrgId: row.clerkOrgId }),
	});
	if (target.kind === "fleet") return isFleetStamp(stamp, target.operator);
	return sameOrg(stamp, target.org);
}

type OrgPage<R> = {
	page: R[];
	isDone: boolean;
	continueCursor: string;
};
type PageOpts = { numItems: number; cursor: string | null };

// Reads the target's index ranges (one per `clerkOrgId` key) as ONE logical
// paginated scan. The continuation cursor carries its phase ("<n>|") so the
// callers' existing `while (!isDone)` loops are unchanged. Every page is a
// single bounded `.paginate`.
async function paginateOrgScopes<R>(
	target: NamespaceTarget,
	opts: PageOpts,
	read: (clerkOrgId: string | undefined, o: PageOpts) => Promise<OrgPage<R>>,
): Promise<OrgPage<R>> {
	const keys = targetKeys(target);
	const phased = opts.cursor === null ? null : /^(\d+)\|(.*)$/.exec(opts.cursor);
	const phase = phased === null ? 0 : Number(phased[1]);
	if (phase >= keys.length) {
		return { page: [], isDone: true, continueCursor: "" };
	}
	const inner = phased === null || phased[2] === "" ? null : phased[2];
	const r = await read(keys[phase], { numItems: opts.numItems, cursor: inner });
	if (!r.isDone) {
		return {
			page: r.page,
			isDone: false,
			continueCursor: `${phase}|${r.continueCursor}`,
		};
	}
	const last = phase === keys.length - 1;
	return {
		page: r.page,
		isDone: last,
		continueCursor: last ? r.continueCursor : `${phase + 1}|`,
	};
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
// `ownsRow()` as a belt-and-braces post-filter to guarantee
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
		// Use the `by_orgId_clerk_id` index for tenant-scoped reads: the organisation
		// is its permanent ID. The fleet namespace reads the operator-stamped range
		// and the unstamped one.
		const target = await namespaceTarget(ctx.db, args.namespace);
		const result = await paginateOrgScopes(
			target,
			args.paginationOpts,
			(clerkOrgId, o) =>
				ctx.db
					.query("briefingNotes")
					.withIndex("by_orgId_clerk_id", (q) => q.eq("clerkOrgId", clerkOrgId))
					.paginate(o),
		);
		const since = args.sinceMs;
		const scoped = result.page.filter((r) => ownsRow(r, target));
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
		const target = await namespaceTarget(ctx.db, args.namespace);
		const result = await paginateOrgScopes(
			target,
			args.paginationOpts,
			(clerkOrgId, o) =>
				ctx.db
					.query("tasks")
					.withIndex("by_orgId_status_clerk_id", (q) =>
						q.eq("clerkOrgId", clerkOrgId),
					)
					.paginate(o),
		);
		const since = args.sinceMs;
		const scoped = result.page.filter((r) => ownsRow(r, target));
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
 *
 * allow-local-identity: a false positive of the scope kind, not an identity
 * decision. `allowed` is the set of OKF memory SUBTYPE tokens the caller asked
 * for (`memory-user`, `memory-feedback`, ...), matched against each memory's
 * `type`. It names no caller, tenant, roster or organisation; the doctor reads
 * the variable name `allowed` as a caller's allow-list.
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
// title+body lookup (briefings, tasks).
//
// Bug #1134: the original helpers ran an unbounded `ctx.db.query(...).collect()`
// over the WHOLE index range (all rows for a namespace / all briefingNotes /
// all tasks) inside a single query execution. Once a namespace or table grows
// past the Convex 16 MB single-execution read ceiling, the dedup lookup — and
// therefore the whole import — throws mid-pipeline.
//
// Fix: mirror the paginated-fetch idiom already used by the export path
// (`_fetchMemoriesForBundle` et al., see comment block above). Each helper now
// returns ONE bounded page (`BUNDLE_PAGE_SIZE` rows) plus a cursor; the
// Node-runtime caller (`okfBundleNode.ts` `findExistingIdByPaginating()`)
// drives the cursor loop ACROSS SEPARATE FUNCTION INVOCATIONS and short-
// circuits the moment a match is found. Because each invocation is its own
// Convex execution, no single execution ever reads more than one page — the
// worst case (no match, full-table scan) costs many bounded executions
// instead of one unbounded one. In-process loop-and-discard within a single
// handler would NOT fix this: Convex's read ceiling is cumulative across all
// reads performed during one execution, so multiple `.paginate()` calls
// inside the same handler still sum toward the same 16 MB budget.
//
// Match predicate is UNCHANGED from the original implementation:
//   - memory:   namespace + isLatest==true (index scope) AND content equality
//   - briefing: title equality AND content equality (unscoped by namespace,
//     same as before — briefingNotes dedup was never namespace-scoped and
//     this PR does not change that semantic)
//   - task:     title equality AND description equality (unscoped, same as
//     before)
// ─────────────────────────────────────────────────────────────────────────────

const DEDUP_RESULT_VALIDATOR = v.object({
	id: v.union(v.string(), v.null()),
	isDone: v.boolean(),
	continueCursor: v.string(),
});

export const _findMemoryByContent = internalQuery({
	args: {
		namespace: v.string(),
		content: v.string(),
		paginationOpts: PAGINATION_OPTS_VALIDATOR,
	},
	returns: DEDUP_RESULT_VALIDATOR,
	handler: async (ctx, { namespace, content, paginationOpts }) => {
		const result = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.eq("namespace", namespace).eq("isLatest", true),
			)
			.paginate(paginationOpts);
		const hit = result.page.find(
			(r) => r.namespace === namespace && r.content === content,
		);
		return {
			id: hit ? hit._id : null,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

export const _findBriefingByTitleAndContent = internalQuery({
	args: {
		namespace: v.string(),
		title: v.string(),
		content: v.string(),
		paginationOpts: PAGINATION_OPTS_VALIDATOR,
	},
	returns: DEDUP_RESULT_VALIDATOR,
	handler: async (ctx, { namespace, title, content, paginationOpts }) => {
		// Follow-up to #1134 (task k175emjxz6d1pdb5qjv824m9sd8bs6fj): the
		// original bare `.withIndex("by_topic")` scan had no tenant dimension at
		// all, so an import from tenant A could dedup-match a row owned by
		// tenant B — the presence/absence of that "skip" leaked B's data across
		// the tenant boundary. Scope by the SAME organisation derivation already
		// used by the export-side reads above (`namespaceTarget` + `ownsRow`, by
		// permanent org ID), reusing the existing `by_orgId_clerk_id` index.
		const target = await namespaceTarget(ctx.db, namespace);
		const result = await paginateOrgScopes(target, paginationOpts, (clerkOrgId, o) =>
			ctx.db
				.query("briefingNotes")
				.withIndex("by_orgId_clerk_id", (q) => q.eq("clerkOrgId", clerkOrgId))
				.paginate(o),
		);
		const hit = result.page.find(
			(r) => ownsRow(r, target) && r.title === title && r.content === content,
		);
		return {
			id: hit ? hit._id : null,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

export const _findTaskByTitleAndDescription = internalQuery({
	args: {
		namespace: v.string(),
		title: v.string(),
		description: v.string(),
		paginationOpts: PAGINATION_OPTS_VALIDATOR,
	},
	returns: DEDUP_RESULT_VALIDATOR,
	handler: async (ctx, { namespace, title, description, paginationOpts }) => {
		// Same cross-tenant fix as `_findBriefingByTitleAndContent` above —
		// see that comment for the full rationale.
		const target = await namespaceTarget(ctx.db, namespace);
		const result = await paginateOrgScopes(target, paginationOpts, (clerkOrgId, o) =>
			ctx.db
				.query("tasks")
				.withIndex("by_orgId_status_clerk_id", (q) =>
					q.eq("clerkOrgId", clerkOrgId),
				)
				.paginate(o),
		);
		const hit = result.page.find(
			(r) =>
				ownsRow(r, target) &&
				r.title === title &&
				(r.description ?? "") === description,
		);
		return {
			id: hit ? hit._id : null,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

export const _insertImportedMemory = internalMutation({
	args: {
		namespace: v.string(),
		type: memoryTypeValidator,
		content: v.string(),
		createdBy: creatorValidator,
		// R-18 idempotency key — sha256(content) computed once by the importer
		// (convex/okfBundleNode.ts). Threaded so this mutation is an ATOMIC
		// findOrCreate: a replayed delivery returns the existing row instead of
		// writing a duplicate (the pre-fix check-then-insert was a TOCTOU — the
		// caller's paginated dedup and this insert were two separate round-trips
		// so a retry between them duplicated the row).
		contentHash: v.string(),
		now: v.number(),
	},
	returns: v.id("memories"),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("memories")
			// Scope the dedup to the LIVE row (isLatest:true). The by_namespace_contentHash
			// index carries isLatest because soft_delete_memory, the TTL cron, and the
			// `updates` relation all flip a memory to isLatest:false WITHOUT deleting it —
			// without this column a re-import would match a DEAD row, insert nothing, and
			// falsely report success, leaving the memory unrestored (Eta REVISE #1253).
			.withIndex("by_namespace_contentHash", (q) =>
				q
					.eq("namespace", args.namespace)
					.eq("isLatest", true)
					.eq("contentHash", args.contentHash),
			)
			.unique();
		if (existing !== null) return existing._id;
		// M10a: a team row carries its org's permanent ID, or no client org could
		// ever read it back (convex/lib/memoryTenant.ts).
		const clerkOrgId = await stampOfNamespace(ctx, args.namespace);
		// The author's ID, resolved in the namespace's own org (the operator org for
		// the fleet); a label that names no agent there leaves the column unset.
		const target = await namespaceTarget(ctx.db, args.namespace);
		const createdById = await actorIdResolver(
			ctx,
			target.kind === "org" ? target.slug : null,
		)(args.createdBy);
		return await ctx.db.insert("memories", {
			namespace: args.namespace,
			type: args.type,
			content: args.content,
			createdBy: args.createdBy,
			relations: [],
			isLatest: true,
			contentHash: args.contentHash,
			...(clerkOrgId === undefined ? {} : { clerkOrgId }),
			...(createdById === undefined ? {} : { createdById }),
			createdAt: args.now,
			updatedAt: args.now,
		});
	},
});

// The rows that already carry a content hash in the target's index ranges, read
// ONE bounded batch per range. The range is keyed by the organisation's permanent
// ID; a legacy row that shares the range key but is not the target's (an
// unstamped client row beside the fleet's unstamped range) is dropped by `ownsRow`.
const IMPORT_DEDUP_SCAN = 8;

export const _insertImportedBriefing = internalMutation({
	args: {
		namespace: v.string(),
		title: v.string(),
		topic: v.string(),
		participants: v.array(v.string()),
		content: v.string(),
		createdBy: creatorValidator,
		// R-18 idempotency key — sha256(title + "\n" + content), same TOCTOU fix
		// as `_insertImportedMemory`. Keyed on (clerkOrgId, contentHash) because
		// briefingNotes scope by the organisation's ID, mirroring
		// `_findBriefingByTitleAndContent`.
		contentHash: v.string(),
		now: v.number(),
	},
	returns: v.id("briefingNotes"),
	handler: async (ctx, args) => {
		// Tag the imported row with the SAME organisation the dedup lookup above
		// scopes on, so a subsequent import of the same tenant's bundle actually
		// finds its own prior copy instead of missing it because the ID was never
		// written (the row would silently fall outside the tenant's scope on
		// every future dedup lookup, forcing perpetual duplicate imports).
		// A NEW fleet import stays unstamped, exactly like a fresh fleet briefing
		// (briefingNotes.create writes `orgId: undefined` for the master); the
		// dedup lookup also finds the operator-stamped copy the backfill wrote.
		const target = await namespaceTarget(ctx.db, args.namespace);
		for (const clerkOrgId of targetKeys(target)) {
			const candidates = await ctx.db
				.query("briefingNotes")
				.withIndex("by_orgId_contentHash_clerk_id", (q) =>
					q.eq("clerkOrgId", clerkOrgId).eq("contentHash", args.contentHash),
				)
				.take(IMPORT_DEDUP_SCAN);
			const existing = candidates.find((row) => ownsRow(row, target));
			if (existing !== undefined) return existing._id;
		}
		if (target.kind === "none") {
			throw new Error(
				`OKF_IMPORT_NAMESPACE_UNKNOWN: namespace "${args.namespace}" names no active organisation; nothing is imported into it.`,
			);
		}
		return await ctx.db.insert("briefingNotes", {
			title: args.title,
			topic: args.topic,
			participants: args.participants,
			content: args.content,
			createdBy: args.createdBy,
			contentHash: args.contentHash,
			createdAt: args.now,
			...(target.kind === "org"
				? {
						orgId: target.slug,
						...(target.clerkOrgId === undefined
							? {}
							: { clerkOrgId: target.clerkOrgId }),
					}
				: {}),
		});
	},
});

export const _insertImportedTask = internalMutation({
	args: {
		namespace: v.string(),
		title: v.string(),
		description: v.optional(v.string()),
		// A LABEL carried by the bundle. It is resolved to an agent of the target
		// organisation; the row stores that agent's ID and its CURRENT label, never
		// the typed string.
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
		// R-18 idempotency key — sha256(title + "\n" + (description ?? "")),
		// same TOCTOU fix. Keyed on (clerkOrgId, contentHash), mirroring
		// `_findTaskByTitleAndDescription`.
		contentHash: v.string(),
		now: v.number(),
	},
	// null: the task's assignee names no active agent of the target organisation, so
	// it is not imported (the importer reports it as a conflict). An assignment
	// resolves to an agent of the task's own org, as at every task door.
	returns: v.union(v.id("tasks"), v.null()),
	handler: async (ctx, args) => {
		// Same organisation-tagging rationale as `_insertImportedBriefing` above.
		// NEW fleet import stays unstamped like a fresh fleet task; dedup also sees
		// the operator stamp.
		const target = await namespaceTarget(ctx.db, args.namespace);
		for (const clerkOrgId of targetKeys(target)) {
			const candidates = await ctx.db
				.query("tasks")
				.withIndex("by_orgId_contentHash_clerk_id", (q) =>
					q.eq("clerkOrgId", clerkOrgId).eq("contentHash", args.contentHash),
				)
				.take(IMPORT_DEDUP_SCAN);
			const existing = candidates.find((row) => ownsRow(row, target));
			if (existing !== undefined) return existing._id;
		}
		if (target.kind === "none") {
			throw new Error(
				`OKF_IMPORT_NAMESPACE_UNKNOWN: namespace "${args.namespace}" names no active organisation; nothing is imported into it.`,
			);
		}
		const orgSlug = target.kind === "org" ? target.slug : null;
		const assigneeId = await agentIdOfLabelInOrg(
			ctx,
			target.kind === "org"
				? {
						orgSlug: target.slug,
						...(target.clerkOrgId === undefined
							? {}
							: { clerkOrgId: target.clerkOrgId }),
					}
				: { orgSlug: null },
			args.assignedTo,
			"okfBundle:_insertImportedTask",
		);
		const assigneeRowId =
			assigneeId === undefined ? null : ctx.db.normalizeId("agents", assigneeId);
		const assignee =
			assigneeRowId === null ? null : await ctx.db.get(assigneeRowId);
		if (assignee === null) return null;
		return await ctx.db.insert("tasks", {
			title: args.title,
			description: args.description,
			assignedTo: assignee.name,
			assignedToId: assignee._id,
			priority: args.priority,
			status: args.status,
			createdBy: args.createdBy,
			contentHash: args.contentHash,
			createdAt: args.now,
			updatedAt: args.now,
			...(await taskActorIdFields(ctx, orgSlug, {
				createdBy: args.createdBy,
			})),
			...(target.kind === "org"
				? {
						orgId: target.slug,
						...(target.clerkOrgId === undefined
							? {}
							: { clerkOrgId: target.clerkOrgId }),
					}
				: {}),
		});
	},
});
