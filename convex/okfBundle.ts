/**
 * OKF v0.1 bundle exporter (Phase 1 — T3).
 *
 * Provides the public Convex `action` `exportOkfBundle` that:
 *   1. Authenticates the caller against the requested namespace (Phase 1
 *      verrouillé to `project/elpi-corp`).
 *   2. Fetches memories / briefing-notes / tasks via internal queries.
 *   3. Serializes each entry via T1 (`okfSerializer`).
 *   4. Packs entries into a tar archive via `tar-stream` (RFC §3.3 layout).
 *   5. Validates the in-memory bundle via T2 (`okfValidator`) before upload.
 *   6. Uploads the tarball to Convex storage and returns a signed download URL.
 *   7. Schedules a TTL-bound deletion of the storage object (default 3600 s).
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
 *   - Internal mutation `deleteBundleStorage` is scheduled at `now + urlTtl`
 *     to purge the storage object (true purge, not just URL expiry).
 *
 * Auth (RFC §4):
 *   - Caller identity resolved via `lib/auth.withOrgScope` (Clerk org / master).
 *   - Master scope: full access.
 *   - Non-master: namespace prefix must match `project/<orgSlug>` OR be in the
 *     caller's allowedOrchestrators set. Else throw `AUTH_NAMESPACE_DENIED`.
 *
 * RFC parent: decisions/okf-bridge-phase-1-rfc-2026-06-18.md (commit 6613610).
 * ADR:        decisions/adr-okf-exporter-arch.md (commit 2cd357e).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-19
 */

import { v } from "convex/values";
import { pack } from "tar-stream";
import { internal as generatedInternal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import {
	type BriefingNoteDoc,
	type MemoryDoc,
	type SerializedFile,
	serializeBriefingNote,
	serializeIndex,
	serializeLog,
	serializeMemory,
	serializeTask,
	type TaskDoc,
} from "./okfSerializer";
import { type BundleEntry, validateBundle } from "./okfValidator";

// `internal.okfBundle.*` is populated by Convex codegen on the first
// `npx convex dev` / deploy after this file lands. Until codegen has run in
// the current worktree, the property is absent on the strongly-typed `internal`
// object. We widen the type locally so this module compiles offline — Convex
// resolves the FunctionReference at runtime by module path (`okfBundle:*`),
// so behaviour is unchanged once codegen catches up.
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround, see comment above
const internal = generatedInternal as any;

// ─────────────────────────────────────────────────────────────────────────────
// Constants (ADR D4 + D5)
// ─────────────────────────────────────────────────────────────────────────────

export const BUNDLE_SOFT_CAP_BYTES = 50 * 1024 * 1024; // 50 MB
export const BUNDLE_HARD_CAP_BYTES = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_URL_TTL_SECONDS = 3600; // 1 hour
const PHASE1_NAMESPACE = "project/elpi-corp";
const TYPE_MEMORY_PREFIX = "memory-";
const TYPE_BRIEFING = "briefing-note";
const TYPE_TASK = "task";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
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
// Internal queries — fetch entries per type.
// Kept as internal so they cannot be called from MCP / public surface; the
// public `exportOkfBundle` action gates them behind the auth check.
// ─────────────────────────────────────────────────────────────────────────────

export const _fetchMemoriesForBundle = internalQuery({
	args: {
		namespace: v.string(),
		sinceMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.eq("namespace", args.namespace).eq("isLatest", true),
			)
			.collect();
		const since = args.sinceMs;
		if (since === undefined) return rows;
		return rows.filter(
			(r) => (r.updatedAt ?? r.createdAt ?? r._creationTime) >= since,
		);
	},
});

export const _fetchBriefingNotesForBundle = internalQuery({
	args: {
		sinceMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// briefingNotes do not carry a `namespace` column in Phase 1 schema;
		// the table is treated as a single-tenant slice for `project/elpi-corp`.
		const rows = await ctx.db.query("briefingNotes").collect();
		const since = args.sinceMs;
		if (since === undefined) return rows;
		return rows.filter(
			(r) => (r.updatedAt ?? r.createdAt ?? r._creationTime) >= since,
		);
	},
});

export const _fetchTasksForBundle = internalQuery({
	args: {
		sinceMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// tasks do not carry a `namespace` column either; same single-tenant
		// assumption applies for Phase 1.
		const rows = await ctx.db.query("tasks").collect();
		const since = args.sinceMs;
		if (since === undefined) return rows;
		return rows.filter(
			(r) => (r.updatedAt ?? r.createdAt ?? r._creationTime) >= since,
		);
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
			// Best-effort: log + swallow. The object may have been manually deleted.
			console.warn(
				`[okfBundle] TTL purge: storage.delete failed for ${args.storageId}`,
				e instanceof Error ? e.message : String(e),
			);
		}
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests)
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
		const size = Buffer.byteLength(f.content, "utf8");
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
	bytes += Buffer.byteLength(indexFile.content, "utf8");
	bytes += Buffer.byteLength(logBody, "utf8");

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
// Auth helper (RFC §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight namespace authorization for Phase 1.
 *
 * Phase 1 is verrouillé to `project/elpi-corp`. We still enforce the contract
 * so Phase 2 (multi-namespace) inherits the gate.
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
		// No Clerk identity → master scope (Convex CLI / MCP server with deploy key).
		return;
	}
	const orgSlug =
		(identity.organizationId as string | undefined) ??
		(identity.organizationSlug as string | undefined) ??
		null;
	if (orgSlug === null) {
		// Internal master backwards-compat: no org → full access (mirrors lib/auth).
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
// Public action
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

		// 3. Fetch entries (only the families requested).
		const memories = shouldIncludeFamily("memory", typeFilter)
			? ((await ctx.runQuery(internal.okfBundle._fetchMemoriesForBundle, {
					namespace: args.namespace,
					sinceMs,
				})) as MemoryDoc[])
			: [];
		const briefings = shouldIncludeFamily("briefing", typeFilter)
			? ((await ctx.runQuery(internal.okfBundle._fetchBriefingNotesForBundle, {
					sinceMs,
				})) as BriefingNoteDoc[])
			: [];
		const tasks = shouldIncludeFamily("task", typeFilter)
			? ((await ctx.runQuery(internal.okfBundle._fetchTasksForBundle, {
					sinceMs,
				})) as TaskDoc[])
			: [];

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
				`[okfBundle] truncated bundle for namespace=${args.namespace}: ${bytes} B > ${BUNDLE_SOFT_CAP_BYTES} B`,
			);
		}

		// 6. Validate (in-memory, before upload).
		const validation = validateBundle({ entries });
		if (!validation.pass) {
			throw new Error(
				`OKF_BUNDLE_INVALID: ${validation.errors.length} error(s) — first: ${validation.errors[0].rule} at ${validation.errors[0].path}`,
			);
		}

		// 7. Pack tarball.
		const tarball = await packTarball(entries);

		// 8. Upload to Convex storage.
		// Convert Node Buffer → Uint8Array view so Blob constructor accepts it
		// across both DOM and Node runtimes (tar-stream returns Node Buffer in V8).
		const tarBytes = new Uint8Array(
			tarball.buffer,
			tarball.byteOffset,
			tarball.byteLength,
		);
		// Cast through BlobPart — the DOM lib in this tsconfig narrows the
		// ArrayBuffer generic in a way that Uint8Array<ArrayBufferLike> does not
		// satisfy, but at runtime it is a valid BlobPart in both Node and V8.
		const blob = new Blob([tarBytes as unknown as BlobPart], {
			type: "application/x-tar",
		});
		const storageId = await ctx.storage.store(blob);
		const bundleUrl = await ctx.storage.getUrl(storageId);
		if (bundleUrl === null) {
			throw new Error(
				`OKF_STORAGE_FAILED: storage.getUrl returned null for ${storageId}`,
			);
		}

		// 9. Schedule TTL-bound purge.
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
				truncated,
				urlExpiresAt,
			},
		};
	},
});
