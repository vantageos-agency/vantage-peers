/// <reference types="vite/client" />
/**
 * convex/__tests__/searchNamespaceAuthorityEndToEnd.test.ts
 *
 * THE GAP THIS CLOSES. `convex/search.ts`'s three public actions — `recall`,
 * `textSearch`, `hybridSearch` — resolve the namespace they search from the
 * VERIFIED scope (`resolveSearchNamespace`, which bridges to `withOrgScope`
 * through `internal.lib.auth.resolveOrgScopeForAction`) instead of accepting it
 * from the caller. That fix was real and typechecked, and it had NO end-to-end
 * assertion: the module built its RAG client at MODULE LOAD from a live
 * embedding key, so every convex-test suite in this directory excluded `search`
 * from its `import.meta.glob`, and the guard's only gate was `tsc` plus a
 * careful read.
 *
 * HOW THE MODULE BECAME COVERABLE. Two changes in convex/search.ts, both
 * documented at the seam itself:
 *   1. the RAG client is built on FIRST USE (`getRag()`) rather than at import,
 *      so the module loads with no AI key present;
 *   2. every `rag.search` goes through one module-local `ragSearch()` whose
 *      backend a test may substitute via `__setRagSearcherForTests`.
 *
 * WHY THAT SEAM CANNOT BYPASS THE GUARD IN PRODUCTION.
 *   - It is strictly DOWNSTREAM of the decision: `ragSearch` is reached only
 *     after `resolveSearchNamespace` returned non-null, and the namespace it
 *     receives is the RESOLVED one. A substituted searcher can observe which
 *     namespace was searched (exactly what is asserted below); it cannot change
 *     which namespaces are permitted.
 *   - It is NOT a Convex registration — not a query/mutation/action, absent
 *     from `api.*` and `internal.*` — so it is unreachable from the
 *     deployment's /api/action endpoint, the very surface this class of leak
 *     was measured on.
 *   - The DENY poles below install NO searcher at all. They assert the refusal
 *     while the real (unbuilt, keyless) client is still in place, so a refused
 *     caller is proven to return before any search backend is touched — the
 *     deny pole does not depend on the seam existing.
 *
 * EVERY POLE RUNS UNDER AN ORDINARY SCOPED IDENTITY unless it is explicitly the
 * master regression pole. A suite authenticating as `CLERK_SERVICE_ACCOUNT_USER_ID`
 * ("test-service-account-user-id" in vitest.config.ts) would pass with the
 * authorization DELETED and would prove nothing.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { __setRagSearcherForTests } from "../search";

// `search` is deliberately INCLUDED here (the point of this suite). `ragSync`
// stays excluded: it is an internalAction over rag.add with no authority gate of
// its own and no bearing on the property under test.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";
const ORDINARY_A = "ordinary-member-of-org-a";
const ORDINARY_NO_ORG = "ordinary-signed-in-user-with-no-org";

// Guard the guard: were either of these the configured service account,
// withOrgScope's by-id master carve-out would fire and every assertion below
// would pass vacuously.
for (const subject of [ORDINARY_A, ORDINARY_NO_ORG]) {
	if (subject === SERVICE_ACCOUNT_USER_ID) {
		throw new Error(
			`test-integrity: ${subject} must not be the service-account id`,
		);
	}
}

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const asOrgMember = (
	t: ReturnType<typeof createT>,
	subject: string,
	orgSlug: string,
) =>
	t.withIdentity({
		subject,
		organizationId: orgSlug,
		organizationSlug: orgSlug,
	} as Parameters<typeof t.withIdentity>[0]);

const asNoOrg = (t: ReturnType<typeof createT>) =>
	t.withIdentity({ subject: ORDINARY_NO_ORG } as Parameters<
		typeof t.withIdentity
	>[0]);

const asMaster = (t: ReturnType<typeof createT>) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Parameters<
		typeof t.withIdentity
	>[0]);

// ─────────────────────────────────────────────────────────────────────────────
// The observing searcher. Records every namespace handed to the RAG backend and
// returns ONE synthetic hit tagged with that namespace, so an ALLOW pole can
// assert both "rows came back" and "they came from the resolved namespace".
// ─────────────────────────────────────────────────────────────────────────────

let searchedNamespaces: string[] = [];

type SeamSearcher = Parameters<typeof __setRagSearcherForTests>[0];

/**
 * A real `memories` row, so the synthetic hit the searcher returns carries a
 * genuine `v.id("memories")` and the actions' `returns` validators are
 * exercised for real rather than bypassed.
 */
async function seedMemoryKey(
	t: ReturnType<typeof createT>,
	namespace: string,
): Promise<string> {
	return await t.run(async (ctx) => {
		const id = await ctx.db.insert("memories", {
			namespace,
			type: "project",
			content: `row in ${namespace}`,
			createdBy: "sigma",
			relations: [],
			isLatest: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return id as string;
	});
}

function installObservingSearcher(entryKey = "unused-key"): void {
	const searcher = (async (
		_ctx: unknown,
		args: { namespace: string; filters?: Array<{ name: string; value: string }> },
	) => {
		searchedNamespaces.push(args.namespace);
		return {
			results: [
				{
					entryId: "entry-1",
					score: 0.99,
					content: [{ text: `row from ${args.namespace}` }],
				},
			],
			entries: [
				{
					entryId: "entry-1",
					key: entryKey,
					filterValues: [
						{ name: "namespace", value: args.namespace },
						{ name: "type", value: "project" },
					],
				},
			],
		};
	}) as unknown as SeamSearcher;
	__setRagSearcherForTests(searcher);
}

beforeEach(() => {
	searchedNamespaces = [];
	__setRagSearcherForTests(null);
});

afterEach(() => {
	__setRagSearcherForTests(null);
});

const SEARCH_ACTIONS = [
	{ name: "recall", ref: api.search.recall },
	{ name: "textSearch", ref: api.search.textSearch },
	{ name: "hybridSearch", ref: api.search.hybridSearch },
] as const;

for (const { name, ref } of SEARCH_ACTIONS) {
	describe(`search:${name} — namespace authority, end to end`, () => {
		// ── DENY POLE 1 — no verified organisation yields an empty result, never
		// rows. NO searcher is installed: if the guard let the call through, the
		// real keyless client would be built and this would throw rather than
		// return [], which is itself a failure of this assertion.
		test("a signed-in caller with NO verified organisation gets an empty result, never rows", async () => {
			const t = createT();
			const rows = await asNoOrg(t).action(ref, {
				query: "anything",
				namespace: "team/org-a",
			});

			expect(rows).toEqual([]);
			expect(searchedNamespaces).toEqual([]);
		});

		// ── DENY POLE 1b — anonymous (no credential at all), the shape measured
		// against live production for the sibling public queries.
		test("an anonymous caller (no credential at all) gets an empty result, never rows", async () => {
			const t = createT();
			const rows = await t.action(ref, {
				query: "anything",
				namespace: "global",
			});

			expect(rows).toEqual([]);
			expect(searchedNamespaces).toEqual([]);
		});

		// ── DENY POLE 2 — the cross-tenant pole. Org A explicitly asks for org
		// B's namespace. Org A's namespace resolved, or a refusal — never org
		// B's rows, and the RAG backend must never even be ASKED for org B's
		// namespace (asserted on searchedNamespaces, not merely on the rows).
		test("org A passing org B's namespace never reaches org B's namespace", async () => {
			const t = createT();
			await seedOrgMapping(t, "org-a");
			await seedOrgMapping(t, "org-b");
			installObservingSearcher(await seedMemoryKey(t, "team/org-b"));

			const rows = await asOrgMember(t, ORDINARY_A, "org-a").action(ref, {
				query: "anything",
				namespace: "team/org-b",
			});

			expect(searchedNamespaces).not.toContain("team/org-b");
			for (const row of rows as Array<{ namespace: string }>) {
				expect(row.namespace).not.toBe("team/org-b");
			}
		});

		// ── DENY POLE 2b — `global`, the fleet-common namespace, is not a
		// tenant's to read either. Same assertion, different requested value.
		test("org A passing the fleet-common `global` namespace never reaches it", async () => {
			const t = createT();
			await seedOrgMapping(t, "org-a");
			installObservingSearcher();

			await asOrgMember(t, ORDINARY_A, "org-a").action(ref, {
				query: "anything",
				namespace: "global",
			});

			expect(searchedNamespaces).not.toContain("global");
		});

		// ── DENY POLE 2c — the DEFAULT. Omitting `namespace` must not fall back
		// to `global` for an org-scoped caller (the pre-fix default was the raw
		// "global" string).
		test("org A omitting `namespace` does not silently fall back to `global`", async () => {
			const t = createT();
			await seedOrgMapping(t, "org-a");
			installObservingSearcher();

			await asOrgMember(t, ORDINARY_A, "org-a").action(ref, {
				query: "anything",
			});

			expect(searchedNamespaces).not.toContain("global");
		});

		// ── ALLOW POLE — the WITHHELD GRANT direction. An org-scoped caller
		// asking for its OWN subtree must actually receive rows; a guard that
		// refuses everyone is not a fix, it only looks like one.
		test("ALLOW pole — org A DOES search its own namespace and receives rows", async () => {
			const t = createT();
			await seedOrgMapping(t, "org-a");
			installObservingSearcher(await seedMemoryKey(t, "team/org-a"));

			const rows = await asOrgMember(t, ORDINARY_A, "org-a").action(ref, {
				query: "anything",
				namespace: "team/org-a",
			});

			expect(searchedNamespaces).toEqual(["team/org-a"]);
			expect(rows).toHaveLength(1);
		});

		// ── ALLOW POLE — a nested namespace inside the caller's own subtree.
		test("ALLOW pole — org A DOES search a nested namespace inside its own subtree", async () => {
			const t = createT();
			await seedOrgMapping(t, "org-a");
			installObservingSearcher(
				await seedMemoryKey(t, "team/org-a/project/x"),
			);

			await asOrgMember(t, ORDINARY_A, "org-a").action(ref, {
				query: "anything",
				namespace: "team/org-a/project/x",
			});

			expect(searchedNamespaces).toEqual(["team/org-a/project/x"]);
		});

		// ── MASTER REGRESSION POLE — the fleet's own callers keep working
		// exactly as today, including on `global`.
		test("master (the by-id service-account carve-out) still searches the requested namespace unchanged", async () => {
			const t = createT();
			installObservingSearcher(await seedMemoryKey(t, "global"));

			const rows = await asMaster(t).action(ref, {
				query: "anything",
				namespace: "global",
			});

			expect(searchedNamespaces).toEqual(["global"]);
			expect(rows).toHaveLength(1);
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// search:searchFixPatterns — the FOURTH search action, and the one this suite
// did not cover, because it is the only one that takes NO `namespace` argument.
//
// THAT ABSENCE IS WHY IT WAS MISSED, and it is the finding worth keeping: the
// three actions above were fixed because they accepted a caller-supplied
// namespace, an obvious thing to distrust. This one hardcoded
// `namespace: "fixpatterns"` and resolved no identity at all, so there was
// nothing caller-supplied to look suspicious — and a constant in place of a
// resolved value is not an authorisation. Any control whose population is
// "registrations taking a tenant-shaped argument" is blind to this shape by
// construction.
//
// It now calls the SAME `resolveSearchNamespace` gate with the constant as the
// requested namespace, so the existing rule decides it with no new branch:
// master gets "fixpatterns"; a verified org is refused because "fixpatterns" is
// not inside its own `team/<slug>` subtree (the same decision already taken for
// the fleet-common `global`); no verified organisation is refused.
// ─────────────────────────────────────────────────────────────────────────────

/** A real fixPatterns row, so the hydration step returns a genuine document. */
async function seedFixPatternKey(
	t: ReturnType<typeof createT>,
): Promise<string> {
	return await t.run(async (ctx) => {
		const id = await ctx.db.insert("fixPatterns", {
			symptom: "a fleet fix pattern",
			rootCause: "root cause",
			tags: [],
			stack: [],
			sourceProject: "vantage-peers",
			createdBy: "sigma",
			severity: "major",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return id as string;
	});
}

describe("search:searchFixPatterns — a CONSTANT namespace is not an authorisation", () => {
	// DENY POLE 1 — anonymous, no credential at all. No searcher is installed:
	// were the guard absent, the real keyless RAG client would be built and this
	// would throw rather than return [], which is itself a failed assertion.
	test("an anonymous caller (no credential at all) gets an empty result, never rows", async () => {
		const t = createT();

		const rows = await t.action(api.search.searchFixPatterns, {
			query: "anything",
		});

		expect(rows).toEqual([]);
		expect(searchedNamespaces).toEqual([]);
	});

	test("a signed-in caller with NO verified organisation gets an empty result, never rows", async () => {
		const t = createT();

		const rows = await asNoOrg(t).action(api.search.searchFixPatterns, {
			query: "anything",
		});

		expect(rows).toEqual([]);
		expect(searchedNamespaces).toEqual([]);
	});

	// DENY POLE 2 — the pole that matters most here, and the one an
	// "is-anyone-signed-in" guard would fail: an ORDINARY member of an ACTIVE
	// organisation. The RAG backend must never even be ASKED for "fixpatterns",
	// which is asserted on searchedNamespaces rather than only on the rows.
	test("an ORDINARY member of an ACTIVE organisation never reaches the fleet-wide `fixpatterns` namespace", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		installObservingSearcher(await seedFixPatternKey(t));

		const rows = await asOrgMember(t, ORDINARY_A, "org-a").action(
			api.search.searchFixPatterns,
			{ query: "anything" },
		);

		expect(searchedNamespaces).not.toContain("fixpatterns");
		expect(searchedNamespaces).toEqual([]);
		expect(rows).toEqual([]);
	});

	// MASTER REGRESSION POLE — the WITHHELD GRANT direction. The fleet's own
	// caller must still search "fixpatterns" and still receive the hydrated row;
	// a guard that refuses everyone is not a fix, it only looks like one.
	test("ALLOW pole — master (the by-id service-account carve-out) still searches `fixpatterns` and receives the hydrated row", async () => {
		const t = createT();
		installObservingSearcher(await seedFixPatternKey(t));

		const rows = await asMaster(t).action(api.search.searchFixPatterns, {
			query: "anything",
		});

		expect(searchedNamespaces).toEqual(["fixpatterns"]);
		expect(rows).toHaveLength(1);
		expect((rows as Array<{ symptom: string }>)[0].symptom).toBe(
			"a fleet fix pattern",
		);
	});
});
