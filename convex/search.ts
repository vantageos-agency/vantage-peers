"use node";
import { actingOrgArgs, actionScopeArgs } from "./lib/actingOrg";
import { getModelId, RAG } from "@convex-dev/rag";
import { embed } from "ai";
import { v } from "convex/values";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./lib/functions";
import {
	getAITextEmbeddingProvider,
	getEmbeddingModelName,
} from "./lib/aiClient";
import { isNamespaceAllowedForScope, verifiedActorValidator } from "./lib/auth";
import { filterValueMap, isLiveRagEntry } from "./lib/retired";
import { memoryTypeValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// RAG instance — backed by an OpenAI-compatible embedding endpoint.
// Model: text-embedding-3-small → 1536 dimensions
//
// AI key selection (checked at module load time inside RAG):
//   AI_GATEWAY_API_KEY set → Vercel AI Gateway (recommended, existing prod path)
//   OPENAI_API_KEY set     → api.openai.com direct (BYOK self-host, no Vercel)
//   Neither set            → throws a clear error at runtime
//
// Optional: set AI_GATEWAY_BASE_URL to override the Vercel gateway endpoint.
//
// Filter strategy:
//   "namespace" → the memory's namespace (e.g. "global", "orchestrator/pi")
//   "type"      → the memory's type (e.g. "user", "feedback")
//   "isLatest"  → boolean string "true"/"false" — RAG filters are string/number only
//
// Entry key: memoryId string — used to replace the RAG entry when a memory
//            is superseded via storeMemory with an "updates" relation.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CLIENT IS BUILT LAZILY, AND WHAT THE TEST SEAM CANNOT DO.
//
// This module used to build its RAG client at MODULE LOAD:
//   const gateway = getAITextEmbeddingProvider();   // reads AI_GATEWAY_API_KEY
//   export const rag = new RAG(components.rag, {...});
// which THROWS without a live embedding key. Every convex-test suite in this
// repo therefore excluded `search` from its `import.meta.glob` (see the
// identical exclusion comments in anonymousCallerServedTenantRows.test.ts,
// client-scope-global-namespace.test.ts, kb-ingest.test.ts) — so the authority
// gate below (`resolveSearchNamespace`) had NO end-to-end assertion at all: its
// only gate was `tsc` and a careful read. That is what
// convex/__tests__/searchNamespaceAuthorityEndToEnd.test.ts now closes.
//
// Building the client on FIRST USE instead makes the module importable with no
// key present. Production behaviour is unchanged: the first `rag.add`/
// `rag.search` still constructs exactly the same client from exactly the same
// env vars, and still throws exactly the same clear error when no key is set —
// one call later than before, never never.
//
// THE SEAM CANNOT BYPASS THE GUARD, for three independent reasons:
//   1. `ragSearch` is reached ONLY AFTER `resolveSearchNamespace` has already
//      returned a non-null namespace, and the namespace handed to it is the
//      RESOLVED one. A substituted searcher receives a namespace the guard
//      already authorised; it is downstream of the decision and cannot revisit
//      it. It can observe what was searched — which is precisely what the test
//      asserts — it cannot widen what may be searched.
//   2. `__setRagSearcherForTests` is a plain module-local variable setter. It is
//      NOT a Convex registration (not `query`/`mutation`/`action`, not exported
//      through `api.*` or `internal.*`), so it is unreachable from the
//      deployment's /api/query, /api/mutation and /api/action endpoints — the
//      surface every leak in this class was measured on. No network caller can
//      call it.
//   3. It is never called from non-test code: `grep -rn
//      "__setRagSearcherForTests" convex/ mcp-server/src/` returns only the
//      definition here and the test file.
// ─────────────────────────────────────────────────────────────────────────────

const EMBEDDING_DIMENSION = 1536;

function buildEmbeddingModel() {
	const gateway = getAITextEmbeddingProvider();
	return gateway.textEmbeddingModel(getEmbeddingModelName());
}

function buildRag() {
	return new RAG(components.rag, {
		textEmbeddingModel: buildEmbeddingModel(),
		embeddingDimension: EMBEDDING_DIMENSION,
		filterNames: ["namespace", "type", "isLatest"],
	});
}

type RagClient = ReturnType<typeof buildRag>;

let ragInstance: RagClient | null = null;

/**
 * The RAG client, built on first use. Replaces the former module-load
 * `export const rag` (see the block comment above); `convex/ragSync.ts` calls
 * `getRag().add(...)` through this same accessor so there is one client, not
 * two.
 */
export function getRag(): RagClient {
	if (ragInstance === null) {
		ragInstance = buildRag();
	}
	return ragInstance;
}

type RagSearchArgs = Parameters<RagClient["search"]>[1];
type RagSearchResult = Awaited<ReturnType<RagClient["search"]>>;
type RagSearcher = (
	ctx: ActionCtx,
	args: RagSearchArgs,
) => Promise<RagSearchResult>;

let ragSearcherOverride: RagSearcher | null = null;

/**
 * TEST SEAM — substitutes the search backend ONLY. See the block comment above
 * for why this cannot bypass `resolveSearchNamespace`: it sits strictly
 * downstream of the guard, it is not a Convex registration, and it is called
 * from no non-test code. Pass `null` to restore the real client.
 */
export function __setRagSearcherForTests(searcher: RagSearcher | null): void {
	ragSearcherOverride = searcher;
}

type QueryEmbedder = (text: string) => Promise<number[]>;
let queryEmbedderOverride: QueryEmbedder | null = null;

/**
 * TEST SEAM -- substitutes the query EMBEDDER only (counts embedding calls in
 * tests). Same safety argument as `__setRagSearcherForTests`: a module-local
 * setter, not a Convex registration, called from no non-test code, and it sits
 * downstream of `resolveSearchNamespace`.
 */
export function __setQueryEmbedderForTests(embedder: QueryEmbedder | null): void {
	queryEmbedderOverride = embedder;
}

/** Embeds the query with the SAME model and dimension the RAG instance uses. */
async function embedQuery(text: string): Promise<number[]> {
	if (queryEmbedderOverride !== null) return queryEmbedderOverride(text);
	const { embedding } = await embed({
		model: buildEmbeddingModel(),
		value: text,
	});
	return embedding;
}

/**
 * One namespace search with a PRE-COMPUTED query embedding. Mirrors what
 * `RAG.search` sends to the component (client/index.ts ~lines 427-445): the
 * embedding AND, for a hybrid search, the text query -- passing an embedding
 * array as `query` through `RAG.search` would silently drop the BM25 half of a
 * hybrid search, so the component is called directly. Under the searcher test
 * seam the embedding is handed over as the `query` instead.
 */
function ragSearchEmbeddedRaw(
	ctx: ActionCtx,
	args: RagSearchArgs,
	embedding: number[],
): Promise<RagSearchResult> {
	if (ragSearcherOverride !== null) {
		return ragSearcherOverride(ctx, { ...args, query: embedding });
	}
	const a = args as RagSearchArgs & {
		vectorWeight?: number;
		textWeight?: number;
	};
	return ctx.runAction(components.rag.search.search, {
		embedding,
		dimension: EMBEDDING_DIMENSION,
		namespace: a.namespace,
		modelId: getModelId(buildEmbeddingModel()),
		filters: a.filters ?? [],
		limit: a.limit ?? 10,
		vectorScoreThreshold: a.vectorScoreThreshold,
		chunkContext: { before: 0, after: 0 },
		textQuery:
			a.searchType === "hybrid" && typeof a.query === "string"
				? a.query
				: undefined,
		textWeight: a.textWeight,
		vectorWeight: a.vectorWeight,
	}) as unknown as Promise<RagSearchResult>;
}


/**
 * Drops the hits whose own filterValues say they are retired (convex/lib/retired.ts
 * isLiveRagEntry). Applied by BOTH search wrappers below, so no RAG read in this
 * repo can return a retired entry: `getRag().search(` and
 * `components.rag.search.search` appear nowhere else (pinned by
 * convex/__tests__/retiredRowsConformance.test.ts).
 */
function liveEntriesOnly(
	res: RagSearchResult,
	args: RagSearchArgs,
): RagSearchResult {
	const wantedType = filterValueMap(args.filters ?? []).get("type");
	const kept = new Set(
		res.entries
			.filter((e) =>
				isLiveRagEntry(
					e.filterValues,
					typeof wantedType === "string" ? wantedType : undefined,
				),
			)
			.map((e) => e.entryId),
	);
	return {
		...res,
		results: res.results.filter((r) => kept.has(r.entryId)),
		entries: res.entries.filter((e) => kept.has(e.entryId)),
	} as RagSearchResult;
}

async function ragSearchEmbedded(
	ctx: ActionCtx,
	args: RagSearchArgs,
	embedding: number[],
): Promise<RagSearchResult> {
	return liveEntriesOnly(await ragSearchEmbeddedRaw(ctx, args, embedding), args);
}

/** Every `rag.search` in this module goes through here. */
async function ragSearch(
	ctx: ActionCtx,
	args: RagSearchArgs,
): Promise<RagSearchResult> {
	const raw =
		ragSearcherOverride !== null
			? await ragSearcherOverride(ctx, args)
			: await getRag().search(ctx, args);
	return liveEntriesOnly(raw, args);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: build filter list for a recall/search call
// isLatest is stored as the string "true" (RAG filter values must be strings)
// ─────────────────────────────────────────────────────────────────────────────

function buildFilters(opts: {
	namespace?: string;
	type?: string;
	onlyLatest?: boolean;
}): Array<{ name: string; value: string }> {
	const filters: Array<{ name: string; value: string }> = [];
	if (opts.onlyLatest !== false) {
		filters.push({ name: "isLatest", value: "true" });
	}
	if (opts.namespace !== undefined) {
		filters.push({ name: "namespace", value: opts.namespace });
	}
	if (opts.type !== undefined) {
		filters.push({ name: "type", value: opts.type });
	}
	return filters;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveSearchNamespace — the authority gate for every RAG search below.
//
// THE DEFECT THIS CLOSES. These three actions took `namespace` from the CALLER
// and passed it straight into `rag.search({ namespace, filters: buildFilters({
// namespace, ... }) })`, with no identity resolved anywhere. That is a
// cross-tenant read of the EMBEDDING INDEX: every tenant's vectors were one
// string away, and the deployment's /api/action endpoint is reachable from the
// open internet with no Authorization header at all.
//
// An action has no `ctx.db`, so it cannot call `withOrgScope` directly — that
// is exactly how this surface came to derive its scope from an argument. The
// bridge is `internal.lib.auth.resolveOrgScopeForAction` (see
// convex/lib/auth.ts), which runs `withOrgScope` in a V8 query while Convex
// propagates the caller's identity across `ctx.runQuery`, so the scope is
// still derived from the VERIFIED principal.
//
// RESOLUTION, never acceptance. The returned namespace is the one actually
// searched:
//   - master (the fleet's own callers, via withOrgScope's named by-id
//     service-account carve-out) -> the requested namespace, unchanged;
//   - a verified org -> the requested namespace ONLY IF it lies inside that
//     org's own `team/<slug>` subtree, otherwise REFUSED;
//   - no verified organisation -> REFUSED.
//
// REFUSAL SHAPE — `null`, which every call site renders as the typed empty
// array. These are READ surfaces (`recall`/`textSearch`/`hybridSearch` back
// the MCP recall tools and are subscribed reactively through the dashboard),
// so a refusal must not throw: an unauthenticated read returns nothing, it
// does not crash the caller. Narrow only, never widen — a caller may confirm
// its own subtree, never select another's.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveSearchNamespace(
	ctx: ActionCtx,
	requestedNamespace: string | undefined,
	verifiedActor?: { agentId: Id<"agents">; orgSlug: string },
): Promise<string | null> {
	const scope = await ctx.runQuery(
		internal.lib.auth.resolveOrgScopeForAction,
		actionScopeArgs(ctx),
	);

	const requested = requestedNamespace ?? "global";

	// The repo's one tenant-namespace predicate decides (convex/lib/auth.ts):
	// master -> any namespace; a verified org -> its own `team/<slug>` subtree;
	// no verified organisation -> nothing. A namespace outside the caller's own
	// subtree (including the fleet-common `global`, which is not this tenant's
	// data to read) is AUTH_NAMESPACE_DENIED, answered as null.
	if (isNamespaceAllowedForScope(scope, requested)) return requested;

	// A seat acting for its organisation owns two more roots than a member
	// (project/<org slug>, orchestrator/<its verified agent ID>), the ones
	// storeMemory writes and listMemories reads. The memories rule decides, in a
	// query (an action has no db); only a namespace the team predicate refused
	// reaches it, and a refused caller (no organisation) is never asked.
	if (scope.refused) return null;
	const seatMay = await ctx.runQuery(
		internal.lib.seatNamespace.mayReadMemoryNamespaceForAction,
		{
			namespace: requested,
			...actionScopeArgs(ctx),
			...(verifiedActor !== undefined ? { verifiedActor } : {}),
		},
	);
	return seatMay ? requested : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ragSearchTree -- a search on an org KB root reaches the org's documents.
//
// THE DEFECT. kb:storeDocumentChunked files every KB document in the RAG
// namespace `team/<orgId>/<docId>`. RAG searches ONE namespace by exact name
// (verified in node_modules/@convex-dev/rag: `getCompatibleNamespace` matches
// the namespace string; filters only select INSIDE a namespace and are OR'd),
// so a search on `team/<orgId>` found nothing and a seat could only find a
// document whose docId it already knew.
//
// DESIGN CHOSEN: resolve the org's live document namespaces at query time from
// the `memories` rows the ingest already writes (kbMutations
// .listDocNamespacesUnderRoot, index-backed, range-bounded to the segment
// subtree `team/<root>/`), then search each. Rejected:
//   - a second RAG filter value (`kbRoot`): filters only select inside the
//     namespace being searched, and the documents live in DIFFERENT namespaces,
//     so no filter value can make `team/<orgId>` reach them; adding a new
//     filter name would also make every existing namespace "incompatible" in
//     getCompatibleNamespace (filterNames must match) and silently empty them.
//   - dual-writing each chunk into a root namespace: doubles embeddings and
//     needs a re-embedding backfill for every pre-existing document.
// This route needs NO backfill: pre-existing documents are covered because the
// memories rows and their exact-namespace RAG entries already exist.
//
// FAIL-CLOSED. The fan-out applies ONLY to a namespace the caller has already
// been authorised for (resolveSearchNamespace ran first) and that has the KB
// root shape `team/<one segment>`. The enumeration is bounded by the segment
// range inside the query, so `team/<X>suffix/...` and another org are never
// read; any other namespace is searched exactly as before (one call). The root
// itself is always searched too, so entries filed directly at `team/<orgId>`
// are still returned.
//
// RESIDUE (named): at most KB_ROOT_MAX_DOCS documents are searched per call
// (embedding cost grows per document). An org with more live documents than
// that gets the first KB_ROOT_MAX_DOCS by docId order on a ROOT search, with a
// console.warn; every document stays findable by its exact namespace. Lifting
// the cap needs a root-namespace dual-write plus a resumable re-embedding
// backfill, deliberately not done here.
// ─────────────────────────────────────────────────────────────────────────────

const KB_ROOT_MAX_DOCS = 50;
const KB_ROOT_BATCH = 10;

/** `team/<one non-empty segment>`: the shape of an org KB root. */
function isKbRootNamespace(ns: string): boolean {
	return /^team\/[^/]+$/.test(ns);
}

// ─────────────────────────────────────────────────────────────────────────────
// RETIRED ENTRIES NEVER REACH A CALLER.
//
// @convex-dev/rag ORs its filters (component/embeddings/index.js:49 `q.or(...)`,
// component/search.js:129 "OR across filter conditions", client/index.d.ts:421
// "These are OR'd together"). buildFilters passes [isLatest=true, namespace=ns],
// so EVERY entry of the namespace matches on `namespace=ns` whatever its
// isLatest: the filter selects nothing. A superseded or soft-deleted entry was
// therefore returned by recall / text_search / hybrid_search. Two layers, both
// applied to every result of every RAG-backed search path (exact namespace and
// root fan-out):
//   1. the entry's own filterValues: isLatest must be exactly "true" (an entry
//      re-indexed by ragSync.markRagEntrySuperseded carries "false"), and the
//      `type` filter, when asked for, must equal the entry's type (OR'd too);
//   2. the memories row the entry's key names must still be isLatest=true
//      (kbMutations.latestMemoryIds): this covers entries retired BEFORE the
//      re-index existed, whose RAG entry still says "true".
// Each component call asks for RETIRED_OVERFETCH x the wanted limit (cap
// RETIRED_FETCH_CAP) so dropping retired entries does not shorten a page in the
// ordinary case. RESIDUE: a namespace whose top-ranked entries are mostly
// retired can still return fewer than `limit`; never more, and never a retired one.
// ─────────────────────────────────────────────────────────────────────────────

const RETIRED_OVERFETCH = 3;
const RETIRED_FETCH_CAP = 200;

async function dropRetired(
	ctx: ActionCtx,
	res: RagSearchResult,
): Promise<RagSearchResult> {
	// Entry level is already applied by ragSearch / ragSearchEmbedded
	// (liveEntriesOnly). Row level: the memories row the entry's key names must
	// still be isLatest=true (kbMutations.latestMemoryIds), which also covers an
	// entry retired before the re-index existed.
	const keys = res.entries.map((e) => e.key ?? "").filter((k) => k !== "");
	const live = new Set(
		keys.length === 0
			? []
			: await ctx.runQuery(internal.kbMutations.latestMemoryIds, { ids: keys }),
	);
	const kept = new Set(
		res.entries.filter((e) => live.has(e.key ?? "")).map((e) => e.entryId),
	);
	return {
		...res,
		results: res.results.filter((r) => kept.has(r.entryId)),
		entries: res.entries.filter((e) => kept.has(e.entryId)),
	} as RagSearchResult;
}

async function ragSearchTree(
	ctx: ActionCtx,
	ns: string,
	build: (target: string) => RagSearchArgs,
): Promise<RagSearchResult> {
	const limit = build(ns).limit ?? 10;
	const wide = (target: string): RagSearchArgs => ({
		...build(target),
		limit: Math.min(
			Math.max(limit, limit * RETIRED_OVERFETCH),
			Math.max(limit, RETIRED_FETCH_CAP),
		),
	});
	const finish = async (r: RagSearchResult): Promise<RagSearchResult> => {
		const live = await dropRetired(ctx, r);
		return { ...live, results: live.results.slice(0, limit) } as RagSearchResult;
	};
	if (!isKbRootNamespace(ns)) return finish(await ragSearch(ctx, wide(ns)));

	const { namespaces, truncated } = await ctx.runQuery(
		internal.kbMutations.listDocNamespacesUnderRoot,
		{ root: ns, max: KB_ROOT_MAX_DOCS },
	);
	if (truncated) {
		console.warn(
			`KB root search on ${ns} truncated at ${KB_ROOT_MAX_DOCS} documents`,
		);
	}
	const targets = [ns, ...namespaces];
	// COST: the query is embedded ONCE and that vector is handed to every
	// per-namespace search (a text search embeds nothing). With no document the
	// plain single call is already one embedding.
	if (targets.length === 1) return finish(await ragSearch(ctx, wide(ns)));
	const rootArgs = wide(ns);
	const embedding =
		rootArgs.searchType === "text" || typeof rootArgs.query !== "string"
			? null
			: await embedQuery(rootArgs.query);
	const search = (t: string): Promise<RagSearchResult> =>
		embedding === null
			? ragSearch(ctx, wide(t))
			: ragSearchEmbedded(ctx, wide(t), embedding);
	const parts: RagSearchResult[] = [];
	for (let i = 0; i < targets.length; i += KB_ROOT_BATCH) {
		const batch = targets.slice(i, i + KB_ROOT_BATCH);
		parts.push(...(await Promise.all(batch.map(search))));
	}
	const results = parts
		.flatMap((p) => p.results)
		.sort((a, b) => b.score - a.score);
	const entries = parts.flatMap((p) => p.entries);
	return finish({ ...parts[0], results, entries } as RagSearchResult);
}

// ─────────────────────────────────────────────────────────────────────────────
// recallResult shape — what all search functions return
// ─────────────────────────────────────────────────────────────────────────────

const recallResultValidator = v.object({
	memoryId: v.id("memories"),
	score: v.number(),
	namespace: v.string(),
	type: memoryTypeValidator,
	content: v.string(),
});

// ─────────────────────────────────────────────────────────────────────────────
// recall — semantic vector search via @convex-dev/rag
// ─────────────────────────────────────────────────────────────────────────────

export const recall = action({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		query: v.string(),
		namespace: v.optional(v.string()),
		// The agent the transport verified for a seat (forwarded by the MCP client wrapper).
		verifiedActor: v.optional(verifiedActorValidator),
		type: v.optional(memoryTypeValidator),
		limit: v.optional(v.number()),
		scoreThreshold: v.optional(v.number()),
	},
	returns: v.array(recallResultValidator),
	handler: async (ctx, args) => {
		// Authority gate — see resolveSearchNamespace above. A refused caller
		// reads NOTHING; the namespace actually searched is the RESOLVED one,
		// never the raw argument.
		const ns = await resolveSearchNamespace(
			ctx,
			args.namespace,
			args.verifiedActor,
		);
		if (ns === null) return [] as never;

		const limit = args.limit ?? 10;
		const scoreThreshold = args.scoreThreshold ?? 0.15;

		const { results, entries } = await ragSearchTree(ctx, ns, (target) => ({
			namespace: target,
			query: args.query,
			searchType: "vector",
			limit,
			vectorScoreThreshold: scoreThreshold,
			filters: buildFilters({ namespace: target, type: args.type }),
		}));

		// Build an entry map for quick lookup of filterValues by entryId
		const entryMap = new Map(entries.map((e) => [e.entryId, e]));

		return results
			.map((r) => {
				const entry = entryMap.get(r.entryId);
				if (entry === undefined) return null;

				const nsFilter = entry.filterValues.find((f) => f.name === "namespace");
				const typeFilter = entry.filterValues.find((f) => f.name === "type");
				const text = r.content.map((c) => c.text).join(" ");

				return {
					// RAG key is the memoryId string we set in storeMemory
					memoryId: (entry.key ?? "") as unknown as string,
					score: r.score,
					namespace: (nsFilter?.value as string) ?? ns,
					type: (typeFilter?.value as string) ?? "user",
					content: text,
				};
			})
			.filter(
				(r): r is NonNullable<typeof r> => r !== null && r.memoryId !== "",
			) as Array<{
			memoryId: string;
			score: number;
			namespace: string;
			type: string;
			content: string;
		}> as never;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// textSearch — BM25 full-text search via @convex-dev/rag
// ─────────────────────────────────────────────────────────────────────────────

export const textSearch = action({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		query: v.string(),
		namespace: v.optional(v.string()),
		// The agent the transport verified for a seat (forwarded by the MCP client wrapper).
		verifiedActor: v.optional(verifiedActorValidator),
		type: v.optional(memoryTypeValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			memoryId: v.id("memories"),
			namespace: v.string(),
			type: memoryTypeValidator,
			content: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		// Authority gate — see resolveSearchNamespace above. A refused caller
		// reads NOTHING; the namespace actually searched is the RESOLVED one,
		// never the raw argument.
		const ns = await resolveSearchNamespace(
			ctx,
			args.namespace,
			args.verifiedActor,
		);
		if (ns === null) return [] as never;

		const limit = args.limit ?? 10;

		const { results, entries } = await ragSearchTree(ctx, ns, (target) => ({
			namespace: target,
			query: args.query,
			searchType: "text",
			limit,
			filters: buildFilters({ namespace: target, type: args.type }),
		}));

		const entryMap = new Map(entries.map((e) => [e.entryId, e]));

		return results
			.map((r) => {
				const entry = entryMap.get(r.entryId);
				if (entry === undefined) return null;

				const nsFilter = entry.filterValues.find((f) => f.name === "namespace");
				const typeFilter = entry.filterValues.find((f) => f.name === "type");
				const text = r.content.map((c) => c.text).join(" ");

				return {
					memoryId: (entry.key ?? "") as unknown as string,
					namespace: (nsFilter?.value as string) ?? ns,
					type: (typeFilter?.value as string) ?? "user",
					content: text,
				};
			})
			.filter(
				(r): r is NonNullable<typeof r> => r !== null && r.memoryId !== "",
			) as never;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// hybridSearch — vector + BM25, merged via RRF inside @convex-dev/rag
// ─────────────────────────────────────────────────────────────────────────────

export const hybridSearch = action({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		query: v.string(),
		namespace: v.optional(v.string()),
		// The agent the transport verified for a seat (forwarded by the MCP client wrapper).
		verifiedActor: v.optional(verifiedActorValidator),
		type: v.optional(memoryTypeValidator),
		limit: v.optional(v.number()),
		vectorWeight: v.optional(v.number()),
		textWeight: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			memoryId: v.id("memories"),
			rrfScore: v.number(),
			namespace: v.string(),
			type: memoryTypeValidator,
			content: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		// Authority gate — see resolveSearchNamespace above. A refused caller
		// reads NOTHING; the namespace actually searched is the RESOLVED one,
		// never the raw argument.
		const ns = await resolveSearchNamespace(
			ctx,
			args.namespace,
			args.verifiedActor,
		);
		if (ns === null) return [] as never;

		const limit = args.limit ?? 10;

		const buildSearchArgs = (target: string): RagSearchArgs => {
			const searchArgs: RagSearchArgs = {
				namespace: target,
				query: args.query,
				searchType: "hybrid",
				limit,
				filters: buildFilters({ namespace: target, type: args.type }),
			};
			if (args.vectorWeight !== undefined) {
				(searchArgs as Record<string, unknown>).vectorWeight =
					args.vectorWeight;
			}
			if (args.textWeight !== undefined) {
				(searchArgs as Record<string, unknown>).textWeight = args.textWeight;
			}
			return searchArgs;
		};

		const { results, entries } = await ragSearchTree(
			ctx,
			ns,
			buildSearchArgs,
		);

		const entryMap = new Map(entries.map((e) => [e.entryId, e]));

		return results
			.map((r) => {
				const entry = entryMap.get(r.entryId);
				if (entry === undefined) return null;

				const nsFilter = entry.filterValues.find((f) => f.name === "namespace");
				const typeFilter = entry.filterValues.find((f) => f.name === "type");
				const text = r.content.map((c) => c.text).join(" ");

				return {
					memoryId: (entry.key ?? "") as unknown as string,
					rrfScore: r.score,
					namespace: (nsFilter?.value as string) ?? ns,
					type: (typeFilter?.value as string) ?? "user",
					content: text,
				};
			})
			.filter(
				(r): r is NonNullable<typeof r> => r !== null && r.memoryId !== "",
			) as never;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// searchFixPatterns — semantic search over fix patterns via RAG
// Searches the "fixpatterns" namespace. Returns pattern IDs + scores,
// then hydrates with full pattern data from the DB.
// ─────────────────────────────────────────────────────────────────────────────

export const searchFixPatterns = action({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		query: v.string(),
		limit: v.optional(v.number()),
		scoreThreshold: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			patternId: v.string(),
			score: v.number(),
			symptom: v.string(),
			rootCause: v.string(),
			validatedFix: v.optional(v.string()),
			tags: v.array(v.string()),
			stack: v.array(v.string()),
			sourceProject: v.string(),
			severity: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		// A CONSTANT NAMESPACE IS NOT AN AUTHORISATION.
		//
		// This action was the one search surface `resolveSearchNamespace` did not
		// gate, and it looked safe for the wrong reason: unlike its three siblings
		// above it takes NO `namespace` argument at all, so there was no
		// caller-supplied string to distrust — it hardcoded `"fixpatterns"` and
		// resolved no identity of any kind. A hardcoded literal in place of a
		// resolved value is exactly the defect class
		// `.claude/rules/authority-attached-to-anonymous-object.md` names: the
		// authority is attached to a constant rather than to the verified
		// principal, so /api/action on the open internet reached the fleet's whole
		// fix-pattern embedding index with no Authorization header.
		//
		// MECHANISM REUSED, NOT INVENTED — this calls the SAME
		// `resolveSearchNamespace` gate the three siblings call, with the constant
		// as the requested namespace, and the semantics fall out of the existing
		// rule with no new branch anywhere:
		//   - master (withOrgScope's named by-id service-account carve-out)
		//     -> "fixpatterns", unchanged. The fleet's own callers keep working.
		//   - a verified org -> REFUSED, because "fixpatterns" does not lie inside
		//     that org's `team/<slug>` subtree. This matches the decision already
		//     taken for the fleet-common `global` namespace in the same gate ("not
		//     this tenant's data to read") and the master-only read this repo now
		//     applies to the `fixPatterns` table itself.
		//   - no verified organisation (anonymous OR signed-in-without-org)
		//     -> REFUSED.
		// REFUSAL SHAPE — the typed empty array, never a throw: these actions back
		// reactively-subscribed read surfaces (R-50/R-51), identical to the
		// siblings' `if (ns === null) return [] as never`.
		const ns = await resolveSearchNamespace(ctx, "fixpatterns");
		if (ns === null) return [] as never;

		const limit = args.limit ?? 10;
		const scoreThreshold = args.scoreThreshold ?? 0.15;

		// `ns` (the RESOLVED namespace), never the literal, is what is searched —
		// the same discipline the siblings follow.
		const { results, entries } = await ragSearch(ctx, {
			namespace: ns,
			query: args.query,
			searchType: "vector",
			limit,
			vectorScoreThreshold: scoreThreshold,
			filters: [
				{ name: "namespace", value: ns },
				{ name: "isLatest", value: "true" },
			],
		});

		const entryMap = new Map(entries.map((e) => [e.entryId, e]));

		// Collect pattern IDs from results
		const patternResults: Array<{ patternId: string; score: number }> = [];
		for (const r of results) {
			const entry = entryMap.get(r.entryId);
			if (entry?.key) {
				patternResults.push({ patternId: entry.key, score: r.score });
			}
		}

		// Hydrate with full pattern data
		const hydrated: Array<{
			patternId: string;
			score: number;
			symptom: string;
			rootCause: string;
			validatedFix?: string;
			tags: string[];
			stack: string[];
			sourceProject: string;
			severity: string;
		}> = [];

		for (const { patternId, score } of patternResults) {
			const pattern: Awaited<ReturnType<typeof ctx.runQuery>> =
				await ctx.runQuery(api.fixPatterns.get, {
					...actingOrgArgs(ctx),
					patternId: patternId as never,
				});
			if (pattern !== null) {
				hydrated.push({
					patternId,
					score,
					symptom: (pattern as Record<string, string>).symptom,
					rootCause: (pattern as Record<string, string>).rootCause,
					validatedFix: (pattern as Record<string, string | undefined>)
						.validatedFix,
					tags: (pattern as Record<string, string[]>).tags,
					stack: (pattern as Record<string, string[]>).stack,
					sourceProject: (pattern as Record<string, string>).sourceProject,
					severity: (pattern as Record<string, string>).severity,
				});
			}
		}

		return hydrated;
	},
});
