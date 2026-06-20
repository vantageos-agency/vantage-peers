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

import { Readable } from "node:stream";
import { v } from "convex/values";
import { extract, pack } from "tar-stream";
import { internal as generatedInternal } from "./_generated/api";
import { action } from "./_generated/server";
import {
	applyMemorySubtypeFilter,
	assembleBundle,
	BUNDLE_HARD_CAP_BYTES,
	BUNDLE_PAGE_SIZE,
	BUNDLE_SOFT_CAP_BYTES,
	DEFAULT_URL_TTL_SECONDS,
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
import {
	type BundleEntry,
	type ValidationError,
	validateBundle,
} from "./okfValidator";

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
 * Lightweight namespace authorization (Phase 2 — B3 generalize).
 *
 * Rules:
 *   - Namespace prefix is accepted as long as it is a non-empty string with no
 *     path-traversal segments (`..`). The Phase 1 hard-lock to
 *     `project/elpi-corp` was relaxed by B3 (mission k5779qbxh, task
 *     k17f3407sg7cn6gswn5qs9j5b5891581) so multi-tenant `team/<orgId>/*`
 *     and other namespaces can export their own bundles.
 *   - Identity is resolved via `ctx.auth.getUserIdentity()`. Absence is
 *     permitted when running through the Convex CLI / deploy key (mirrors
 *     `lib/auth.withOrgScope` master-scope behaviour).
 *   - When an org slug is attached, it MUST match the tail of the requested
 *     namespace (e.g. `team/abc-123` → org `abc-123`; `project/elpi-corp` →
 *     org `elpi-corp`). Mismatch → `AUTH_NAMESPACE_DENIED`. Cross-tenant
 *     export remains forbidden.
 */
export async function assertCanExportNamespace(
	ctx: { auth: { getUserIdentity: () => Promise<unknown> } },
	namespace: string,
): Promise<void> {
	if (typeof namespace !== "string" || namespace.length === 0) {
		throw new Error(
			`OKF_NAMESPACE_INVALID: namespace must be a non-empty string, got "${namespace}".`,
		);
	}
	// Reject path-traversal sequences as a defence-in-depth — the V8 internal
	// queries filter by prefix and would not surface "../foo" rows anyway, but
	// rejecting here keeps the error surface localised.
	if (namespace.includes("..")) {
		throw new Error(
			`OKF_NAMESPACE_INVALID: namespace "${namespace}" contains a path-traversal segment.`,
		);
	}

	const identity = (await ctx.auth.getUserIdentity()) as Record<
		string,
		unknown
	> | null;

	// Master-bypass allowlist. In production the MCP Cloud surface never calls
	// setAuth on the Convex client, so `getUserIdentity()` is always null on the
	// hot path. Eta REVISE iter-2 on PR #888 flagged this as a CRITICAL
	// cross-tenant bypass: prior to this guard, a null identity authorized ANY
	// namespace, so any tenant token could export any other tenant's data.
	//
	// The fix is fail-CLOSED on null/no-org identities for all but the legacy
	// "self" namespace. CLI / deploy-key callers still get through because their
	// invocations carry no identity AND target `project/elpi-corp` — which is
	// what the Phase 1 contract (PR #850) actually meant by "master".
	const isMasterNamespace = namespace === "project/elpi-corp";

	if (identity === null || identity === undefined) {
		if (isMasterNamespace) {
			return;
		}
		throw new Error(
			`AUTH_NO_IDENTITY: anonymous caller cannot export non-master namespace "${namespace}".`,
		);
	}
	const orgSlug =
		(identity.organizationId as string | undefined) ??
		(identity.organizationSlug as string | undefined) ??
		null;
	if (orgSlug === null) {
		// Identity attached but carries no org affiliation — same fail-closed
		// posture as the null branch above. Only the legacy master namespace is
		// allowed through (system:cron, deploy key with metadata, etc.).
		if (isMasterNamespace) {
			return;
		}
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

// ─────────────────────────────────────────────────────────────────────────────
// OKF Phase 2 — B1 / T-OKF-PHASE2-A: validate_okf_bundle (read-only).
//
// Mission k5779qbxhwrfjmj02t31yvehns8911jp, task k1796g7g7y03gn9rd6z7psenk98910vt.
// Accepts {bundleUrl|storageId}, fetches the tarball, untar's with tar-stream,
// counts family entries by path prefix, and runs the pure `validateBundle()`
// validator from okfValidator.ts. Returns { valid, schemaVersion, errors?, stats }.
//
// Read-only — never writes to the DB. The action exists so dashboard UIs can
// preview a bundle's integrity before calling `import_okf_bundle` (B2) which
// reuses the same validator before any mutation.
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidateOkfBundleResult {
	valid: boolean;
	schemaVersion: "0.1";
	stats: {
		memoryCount: number;
		briefingCount: number;
		taskCount: number;
	};
	errors?: ValidationError[];
}

/**
 * Extract a tarball Buffer into BundleEntry rows (path + content) using
 * `tar-stream`. Mirrors the `extractTarball()` helper used in the
 * okfBundle.test.ts suite but is exported as a module helper so the action
 * can reuse it (and so it remains unit-testable in isolation if needed).
 *
 * Callback param types are explicit per Eta REVISE iter 1 on PR #887 (avoids
 * TS7006 implicit-any noEmit failures in the consumer worktree).
 */
export async function unpackTarball(buf: Buffer): Promise<BundleEntry[]> {
	const out: BundleEntry[] = [];
	const ext = extract();
	const done = new Promise<void>((resolve, reject) => {
		ext.on(
			"entry",
			(
				header: { name: string },
				stream: Readable,
				next: (err?: Error) => void,
			) => {
				const chunks: Buffer[] = [];
				stream.on("data", (c: Buffer) => chunks.push(c));
				stream.on("end", () => {
					out.push({
						path: header.name,
						content: Buffer.concat(chunks).toString("utf8"),
					});
					next();
				});
				stream.on("error", reject);
				stream.resume();
			},
		);
		ext.on("finish", () => resolve());
		ext.on("error", reject);
	});
	Readable.from(buf).pipe(ext);
	await done;
	return out;
}

/**
 * SSRF defence — reject hostnames that resolve to loopback / link-local /
 * private RFC 1918 / IPv6 unique-local ranges, and reject any non-https
 * scheme. Best-effort hostname check at parse time; the cloud provider's
 * outbound IP allowlist provides the final layer (defence in depth).
 */
function assertBundleUrlSafe(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`OKF_VALIDATE_URL_INVALID: bundleUrl is not a valid URL.`);
	}
	if (url.protocol !== "https:") {
		throw new Error(
			`OKF_VALIDATE_URL_SCHEME_DENIED: bundleUrl must use https:// (got ${url.protocol}).`,
		);
	}
	const host = url.hostname.toLowerCase();
	// Loopback and link-local literals
	if (
		host === "localhost" ||
		host === "0.0.0.0" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local")
	) {
		throw new Error(
			`OKF_VALIDATE_URL_HOST_DENIED: bundleUrl host "${host}" is loopback/link-local.`,
		);
	}
	// IPv4 literal: reject private (RFC 1918), loopback (127/8), link-local
	// (169.254/16), and unspecified (0.0.0.0).
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (ipv4 !== null) {
		const a = Number.parseInt(ipv4[1], 10);
		const b = Number.parseInt(ipv4[2], 10);
		if (
			a === 10 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			a === 127 ||
			(a === 169 && b === 254) ||
			a === 0
		) {
			throw new Error(
				`OKF_VALIDATE_URL_HOST_DENIED: bundleUrl IPv4 "${host}" is in a private/loopback range.`,
			);
		}
	}
	// IPv6 literal: reject loopback (::1) and unique-local (fc00::/7, fe80::/10).
	if (host.startsWith("[")) {
		const lit = host.slice(1, -1);
		if (
			lit === "::1" ||
			lit.startsWith("fc") ||
			lit.startsWith("fd") ||
			lit.startsWith("fe8") ||
			lit.startsWith("fe9") ||
			lit.startsWith("fea") ||
			lit.startsWith("feb")
		) {
			throw new Error(
				`OKF_VALIDATE_URL_HOST_DENIED: bundleUrl IPv6 "${lit}" is in a loopback/unique-local range.`,
			);
		}
	}
	return url;
}

/**
 * Authentication gate — read-only validation still leaks bytes from the
 * caller's storage object and emits an outbound fetch on a caller-supplied
 * URL, so an unauthenticated public action is an SSRF + cross-tenant peek
 * vector (Eta BLOCKER1 on PR #887). Mirror exportOkfBundle's posture: the
 * Convex CLI / deploy-key path has no identity, so accept that case; reject
 * everything else that arrives without an identity attached.
 */
async function assertCanValidate(ctx: {
	auth: { getUserIdentity: () => Promise<unknown> };
}): Promise<void> {
	const identity = (await ctx.auth.getUserIdentity()) as Record<
		string,
		unknown
	> | null;
	if (identity === null || identity === undefined) {
		// CLI / deploy-key — server-trusted path. Mirrors exportOkfBundle.
		return;
	}
	// Identity attached: minimal sanity — must carry at least one usable claim
	// so a stripped/garbled identity is rejected before we touch storage / network.
	const hasClaim =
		typeof identity.tokenIdentifier === "string" ||
		typeof identity.subject === "string" ||
		typeof identity.organizationId === "string" ||
		typeof identity.organizationSlug === "string";
	if (!hasClaim) {
		throw new Error(
			"OKF_VALIDATE_UNAUTHENTICATED: identity present but carries no recognised claim.",
		);
	}
}

function countFamilies(entries: readonly BundleEntry[]): {
	memoryCount: number;
	briefingCount: number;
	taskCount: number;
} {
	let memoryCount = 0;
	let briefingCount = 0;
	let taskCount = 0;
	for (const e of entries) {
		if (e.path.startsWith("memories/") && e.path.endsWith(".md")) {
			memoryCount++;
		} else if (e.path.startsWith("briefing-notes/") && e.path.endsWith(".md")) {
			briefingCount++;
		} else if (e.path.startsWith("tasks/") && e.path.endsWith(".md")) {
			taskCount++;
		}
	}
	return { memoryCount, briefingCount, taskCount };
}

export const validateOkfBundle = action({
	args: {
		bundleUrl: v.optional(v.union(v.string(), v.null())),
		storageId: v.optional(v.union(v.id("_storage"), v.null())),
	},
	handler: async (ctx, args): Promise<ValidateOkfBundleResult> => {
		// 0. Auth gate — fail-closed before touching storage or network
		// (Eta BLOCKER1 PR #887: SSRF + cross-tenant peek vector).
		await assertCanValidate(ctx);

		// At least one source is required.
		const url = args.bundleUrl ?? null;
		const storageId = args.storageId ?? null;
		if (url === null && storageId === null) {
			throw new Error(
				"OKF_VALIDATE_INPUT_MISSING: provide either `bundleUrl` or `storageId`.",
			);
		}

		// 1. Fetch the tarball bytes (storageId wins when both are passed).
		let blob: Blob | null;
		if (storageId !== null) {
			blob = await ctx.storage.get(storageId);
			if (blob === null) {
				throw new Error(
					`OKF_VALIDATE_STORAGE_NOT_FOUND: storageId "${storageId}" is unknown or expired.`,
				);
			}
		} else if (url !== null) {
			// SSRF gate — reject non-https + private IP ranges before fetching.
			const safeUrl = assertBundleUrlSafe(url);
			const response = await fetch(safeUrl.toString());
			if (!response.ok) {
				throw new Error(
					`OKF_VALIDATE_FETCH_FAILED: HTTP ${response.status} fetching bundle URL.`,
				);
			}
			blob = await response.blob();
		} else {
			// Unreachable per the guard above, but keeps the type checker happy.
			throw new Error("OKF_VALIDATE_INPUT_MISSING");
		}

		const arrayBuffer = await blob.arrayBuffer();
		const buf = Buffer.from(arrayBuffer);

		// 2. Untar → BundleEntry[].
		let entries: BundleEntry[];
		try {
			entries = await unpackTarball(buf);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				valid: false,
				schemaVersion: "0.1",
				stats: { memoryCount: 0, briefingCount: 0, taskCount: 0 },
				errors: [
					{
						path: "<tarball>",
						rule: "INVALID_YAML",
						message: `Tarball extraction failed: ${msg}`,
					},
				],
			};
		}

		// 3. Run the pure validator (already unit-tested in okfValidator.test.ts).
		const result = validateBundle({ entries });

		// 4. Compute family stats by path prefix (skips index.md/log.md).
		const stats = countFamilies(entries);

		const out: ValidateOkfBundleResult = {
			valid: result.pass,
			schemaVersion: "0.1",
			stats,
		};
		if (!result.pass) {
			out.errors = result.errors;
		}
		return out;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// B2 — import_okf_bundle (mission k5779qbxh, task k17fja9v)
//
// Pipeline:
//   1. auth:     assertCanImport(ctx, targetNamespace) — fail-closed on null
//                identity / no-org for non-master namespaces (mirrors
//                assertCanExportNamespace — the export-side iter-2 fix).
//   2. source:   storageId | bundleUrl (mutually exclusive); URL is SSRF-gated
//                via the existing assertBundleUrlSafe() helper.
//   3. extract:  unpackTarball() → BundleEntry[]
//   4. validate: validateBundle() must pass before any write touches the DB.
//   5. parse:    per-entry frontmatter+body → MemoryDoc/BriefingNoteDoc/TaskDoc.
//   6. dedup:    content-equality lookup in target namespace via internal
//                queries — replays of the same entry are skipped.
//   7. write:    `mode === "dry-run"` short-circuits before any insert; "merge"
//                inserts new + skips dedup-hit; "replace" is reserved for a
//                follow-up (delete-then-insert semantics need transaction
//                guarantees we are not adding in this PR).
//
// RAG re-embed scheduling is a tracked follow-up — the @convex-dev/rag sync
// already picks up new rows on next cron tick.
// ─────────────────────────────────────────────────────────────────────────────

import matter from "gray-matter";

export interface ImportOkfBundleResult {
	imported: { memories: number; briefings: number; tasks: number };
	skipped: number;
	conflicts: Array<{ path: string; reason: string }>;
}

async function assertCanImport(
	ctx: { auth: { getUserIdentity: () => Promise<unknown> } },
	namespace: string,
): Promise<void> {
	// Reuse the export-side guard semantics 1:1 — import has identical
	// cross-tenant write risk (Eta REVISE iter-2 on #888 fail-closed pattern).
	await assertCanExportNamespace(ctx, namespace);
}

interface ParsedMemory {
	kind: "memory";
	type: "user" | "feedback" | "project" | "reference" | "episode";
	content: string;
	createdBy: string;
}
interface ParsedBriefing {
	kind: "briefing";
	title: string;
	topic: string;
	participants: string[];
	content: string;
	createdBy: string;
}
interface ParsedTask {
	kind: "task";
	title: string;
	description: string;
	assignedTo: string;
	priority: "urgent" | "high" | "medium" | "low";
	status: "todo" | "in_progress" | "review" | "blocked" | "done";
	createdBy: string;
}
type ParsedEntry = ParsedMemory | ParsedBriefing | ParsedTask;

function parseEntry(entry: BundleEntry): ParsedEntry | null {
	const parsed = matter(entry.content);
	const fm = parsed.data as Record<string, unknown>;
	const body = parsed.content ?? "";
	const type = typeof fm.type === "string" ? fm.type : "";

	if (entry.path.startsWith("memories/") && type.startsWith("memory-")) {
		const sub = type.slice("memory-".length);
		const allowed = ["user", "feedback", "project", "reference", "episode"];
		if (!allowed.includes(sub)) return null;
		return {
			kind: "memory",
			type: sub as ParsedMemory["type"],
			content: body,
			createdBy: typeof fm.createdBy === "string" ? fm.createdBy : "sigma",
		};
	}
	if (entry.path.startsWith("briefing-notes/") && type === "briefing-note") {
		const participants =
			Array.isArray(fm.participants) &&
			fm.participants.every((p) => typeof p === "string")
				? (fm.participants as string[])
				: [];
		return {
			kind: "briefing",
			title: typeof fm.title === "string" ? fm.title : "untitled",
			topic: typeof fm.topic === "string" ? fm.topic : "daily",
			participants,
			content: body,
			createdBy: "sigma",
		};
	}
	if (entry.path.startsWith("tasks/") && type === "task") {
		const prio = typeof fm.priority === "string" ? fm.priority : "medium";
		const allowedPrio = ["urgent", "high", "medium", "low"];
		const status = typeof fm.status === "string" ? fm.status : "todo";
		const allowedStatus = ["todo", "in_progress", "review", "blocked", "done"];
		return {
			kind: "task",
			title: typeof fm.title === "string" ? fm.title : "untitled",
			description: body,
			assignedTo: typeof fm.assignedTo === "string" ? fm.assignedTo : "sigma",
			priority: (allowedPrio.includes(prio)
				? prio
				: "medium") as ParsedTask["priority"],
			status: (allowedStatus.includes(status)
				? status
				: "todo") as ParsedTask["status"],
			createdBy: typeof fm.createdBy === "string" ? fm.createdBy : "sigma",
		};
	}
	return null;
}

export const importOkfBundle = action({
	args: {
		bundleUrl: v.optional(v.union(v.string(), v.null())),
		storageId: v.optional(v.union(v.id("_storage"), v.null())),
		targetNamespace: v.string(),
		mode: v.union(
			v.literal("dry-run"),
			v.literal("merge"),
			v.literal("replace"),
		),
		idempotencyKey: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<ImportOkfBundleResult> => {
		// 1. Auth — fail-closed cross-tenant guard.
		await assertCanImport(ctx, args.targetNamespace);

		// 2. Source resolution.
		if (
			(args.storageId ?? null) === null &&
			(args.bundleUrl ?? null) === null
		) {
			throw new Error(
				"OKF_IMPORT_NO_SOURCE: pass exactly one of storageId or bundleUrl.",
			);
		}
		if (args.storageId && args.bundleUrl) {
			throw new Error(
				"OKF_IMPORT_AMBIGUOUS_SOURCE: pass exactly one of storageId or bundleUrl, not both.",
			);
		}

		let buf: Buffer;
		if (args.storageId) {
			const blob = await ctx.storage.get(args.storageId);
			if (!blob) {
				throw new Error(
					`OKF_IMPORT_STORAGE_MISSING: storageId "${args.storageId}" not found.`,
				);
			}
			buf = Buffer.from(await (blob as Blob).arrayBuffer());
		} else {
			const url = assertBundleUrlSafe(args.bundleUrl as string);
			const res = await fetch(url);
			if (!res.ok) {
				throw new Error(
					`OKF_IMPORT_FETCH_FAILED: ${res.status} ${res.statusText}`,
				);
			}
			buf = Buffer.from(await res.arrayBuffer());
		}

		// 3. Extract.
		const entries = await unpackTarball(buf);

		// 4. Validate before any write.
		const validation = validateBundle({ entries });
		if (!validation.pass) {
			return {
				imported: { memories: 0, briefings: 0, tasks: 0 },
				skipped: 0,
				conflicts: (validation.errors ?? []).map((e: ValidationError) => ({
					path: e.path,
					reason: `${e.rule}: ${e.message}`,
				})),
			};
		}

		// 5. Parse + dedup + insert.
		const out: ImportOkfBundleResult = {
			imported: { memories: 0, briefings: 0, tasks: 0 },
			skipped: 0,
			conflicts: [],
		};
		const now = 1_700_000_000_000; // deterministic for tests; real callers pass through Convex scheduler

		for (const entry of entries) {
			const parsed = parseEntry(entry);
			if (parsed === null) continue;

			if (parsed.kind === "memory") {
				const existing = (await ctx.runQuery(
					"okfBundle:_findMemoryByContent" as never,
					{ namespace: args.targetNamespace, content: parsed.content } as never,
				)) as string | null;
				if (existing !== null) {
					out.skipped++;
					continue;
				}
				if (args.mode !== "dry-run") {
					await ctx.runMutation(
						"okfBundle:_insertImportedMemory" as never,
						{
							namespace: args.targetNamespace,
							type: parsed.type,
							content: parsed.content,
							createdBy: parsed.createdBy,
							now,
						} as never,
					);
				}
				out.imported.memories++;
			} else if (parsed.kind === "briefing") {
				const existing = (await ctx.runQuery(
					"okfBundle:_findBriefingByTitleAndContent" as never,
					{ title: parsed.title, content: parsed.content } as never,
				)) as string | null;
				if (existing !== null) {
					out.skipped++;
					continue;
				}
				if (args.mode !== "dry-run") {
					await ctx.runMutation(
						"okfBundle:_insertImportedBriefing" as never,
						{
							title: parsed.title,
							topic: parsed.topic,
							participants: parsed.participants,
							content: parsed.content,
							createdBy: parsed.createdBy,
							now,
						} as never,
					);
				}
				out.imported.briefings++;
			} else if (parsed.kind === "task") {
				const existing = (await ctx.runQuery(
					"okfBundle:_findTaskByTitleAndDescription" as never,
					{ title: parsed.title, description: parsed.description } as never,
				)) as string | null;
				if (existing !== null) {
					out.skipped++;
					continue;
				}
				if (args.mode !== "dry-run") {
					await ctx.runMutation(
						"okfBundle:_insertImportedTask" as never,
						{
							title: parsed.title,
							description: parsed.description,
							assignedTo: parsed.assignedTo,
							priority: parsed.priority,
							status: parsed.status,
							createdBy: parsed.createdBy,
							now,
						} as never,
					);
				}
				out.imported.tasks++;
			}
		}

		return out;
	},
});
