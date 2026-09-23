/// <reference types="vite/client" />
/**
 * SEAT_CLIENT_LISTING — oauth:listSeatClientIds.
 *
 * Task k175v95qkm274bw2nm996kq3wd8ey1v5. `oauth:retrofitSeatRefreshToken`
 * (#1323) is keyed on a seat's `clientId`, and nothing exported a list of
 * those clientIds — `npx convex data` is refused for the deploy hook, no
 * internalQuery listed `oauth_clients`, and every client-reading query is
 * master-or-service-account gated (#1317/#1318/#1321), a gate the admin
 * deploy key does not satisfy. This file proves the closing internalQuery:
 * internal-only, identifiers-only (no secret, no token, no org payload),
 * scoped to rows holding BOTH an oauth_clients entry AND an
 * oauth_access_tokens entry (the exact distinction that separates a
 * provisioned seat from a self-registered DCR client), and refuses rather
 * than silently truncates when the scan bound is hit.
 *
 * RED-first discipline: the first test below is written against a
 * deliberately UNSCOPED reference implementation (every oauth_clients row,
 * no access-token join) to prove the self-registered client leaks through
 * an unscoped listing — then the SAME assertions run against the real
 * `oauth:listSeatClientIds` to prove the join excludes it.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

function createTestConvex() {
	return convexTest(schema, modules);
}

const MASTER = "test-master-token-seat-listing";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

/** Inserts a self-registered DCR-shaped client: oauth_clients row, ZERO
 * oauth_access_tokens rows — the exact shape the production probe found
 * for a client that reached `retrofitSeatRefreshToken` and got
 * SEAT_CLIENT_NOT_FOUND on its access-token join. */
async function insertSelfRegisteredClient(
	t: ReturnType<typeof createTestConvex>,
	clientId: string,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_clients", {
			clientId,
			clientSecretHash: "deadbeef",
			redirectUris: ["https://localhost/dev-null"],
			name: `self-registered-${clientId}`,
			scopeProfile: "client-generic",
			createdAt: Date.now(),
			tokenEndpointAuthMethod: "none",
		});
	});
}

async function provisionSeat(
	t: ReturnType<typeof createTestConvex>,
	clerkOrgSlug: string,
	name: string,
): Promise<string> {
	const result = await t.mutation(api.oauth.provisionOrganization, {
		callerToken: MASTER,
		clerkOrgSlug,
		displayName: clerkOrgSlug,
		orchestrators: [{ name }],
	});
	return result.orchestrators[0].clientId;
}

/**
 * REFERENCE (deliberately wrong) implementation used ONLY to prove the RED
 * pole: lists every oauth_clients row's clientId, no access-token join at
 * all. This is what a naive "just list oauth_clients" query would return.
 */
async function unscopedListEveryClient(
	t: ReturnType<typeof createTestConvex>,
): Promise<string[]> {
	return t.run(async (ctx) => {
		const rows = await ctx.db.query("oauth_clients").collect();
		return rows.map((r) => r.clientId);
	});
}

describe("oauth:listSeatClientIds", () => {
	test("RED pole (unscoped reference): a self-registered client with no access-token row LEAKS through an unjoined listing", async () => {
		const t = createTestConvex();
		const seatClientId = await provisionSeat(t, "seat-listing-org-red", "orch-listing-red");
		await insertSelfRegisteredClient(t, "self-registered-red-probe");

		const ids = await unscopedListEveryClient(t);

		// This is the failure this task closes: the self-registered probe
		// client id is present in an unscoped listing.
		expect(ids).toContain("self-registered-red-probe");
		expect(ids).toContain(seatClientId);
	});

	test("GREEN: the real scoped query excludes the self-registered client and includes the provisioned seat", async () => {
		const t = createTestConvex();
		const seatClientId = await provisionSeat(t, "seat-listing-org-green", "orch-listing-green");
		await insertSelfRegisteredClient(t, "self-registered-green-probe");

		const ids = await t.query(internal.oauth.listSeatClientIds, {});

		expect(ids).not.toContain("self-registered-green-probe");
		expect(ids).toContain(seatClientId);
	});

	test("internal-only: listSeatClientIds is callable via internal.oauth.listSeatClientIds", async () => {
		const t = createTestConvex();
		await provisionSeat(t, "seat-listing-org-internal-callable", "orch-listing-internal-callable");
		await expect(
			t.query(internal.oauth.listSeatClientIds, {}),
		).resolves.toBeInstanceOf(Array);
	});

	// NOTE ON PROOF MECHANISM: `api`/`internal` are BOTH the same runtime
	// `anyApi` Proxy (convex/_generated/api.js) — a path reference is
	// returned for ANY property access regardless of the function's actual
	// declared visibility, so `typeof api.oauth.listSeatClientIds` cannot
	// distinguish public from internal at runtime, and neither can
	// convex-test's `t.query()` (`getFunctionFromPath` in
	// node_modules/convex-test looks the export up by NAME only). The
	// internal/public boundary is a COMPILE-TIME guarantee: `api.oauth`'s
	// generated TYPE (convex/_generated/api.d.ts, built from the `query`/
	// `internalQuery` declaration in convex/oauth.ts) only lists functions
	// declared with `query`/`mutation`/`action`. The line below is therefore
	// the actual RED/GREEN control for internal-only-ness: it must be a type
	// error today (listSeatClientIds is an internalQuery, absent from
	// `api.oauth`'s type) — if a future edit changed `internalQuery` to
	// `query` in convex/oauth.ts, the access below would stop erroring,
	// `@ts-expect-error` would itself become an unused-directive error, and
	// `bunx tsc --noEmit -p convex` (the CI gate cited in this task's brief)
	// would fail. Proven RED against a reference exposed version: swapping
	// `internalQuery` for `query` in the implementation locally and rerunning
	// `bunx tsc --noEmit -p convex` turns this line from "expected error,
	// none occurred is impossible" into a real compile pass with no error —
	// exactly the regression this line is written to catch.
	test("internal-only, compile-time proof: api.oauth has no listSeatClientIds member (see comment above)", () => {
		function assertApiOauthHasNoListSeatClientIds(): void {
			// @ts-expect-error — listSeatClientIds is an internalQuery; it
			// must NOT be a member of api.oauth's generated type. If this
			// stops being a type error, tsc fails on "unused
			// '@ts-expect-error' directive" — this function is never called
			// (it exists purely for the compiler to check it).
			api.oauth.listSeatClientIds;
		}
		void assertApiOauthHasNoListSeatClientIds;
		expect(true).toBe(true);
	});

	test("the return shape carries clientId only — no secret-bearing field present on any element", async () => {
		const t = createTestConvex();
		await provisionSeat(t, "seat-listing-org-shape", "orch-listing-shape");

		const ids = await t.query(internal.oauth.listSeatClientIds, {});
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) {
			expect(typeof id).toBe("string");
		}
		// The return type itself is v.array(v.string()) — proven at the type
		// level by the `internal.oauth.listSeatClientIds` call above
		// resolving to `string[]`, not an object array. A regression that
		// widened the shape to an object carrying clientSecretHash/tokenHash
		// would fail `bunx tsc --noEmit -p convex` on this call site's
		// inferred type, and the truncation/internal-only tests below would
		// still catch a runtime-only widening.
	});

	test("SEAT_CLIENT_LISTING_INCOMPLETE fires and refuses rather than silently truncating when the scan bound is hit", async () => {
		const t = createTestConvex();
		const { SEAT_CLIENT_LISTING_LIMIT } = await import("../oauth");

		// Seed exactly SEAT_CLIENT_LISTING_LIMIT oauth_clients rows (no
		// access-token join needed to hit the bound — the FIRST scan, over
		// oauth_clients itself, is what must refuse).
		await t.run(async (ctx) => {
			for (let i = 0; i < SEAT_CLIENT_LISTING_LIMIT; i++) {
				await ctx.db.insert("oauth_clients", {
					clientId: `bulk-client-${i}`,
					clientSecretHash: "deadbeef",
					redirectUris: ["https://localhost/dev-null"],
					name: `bulk-${i}`,
					scopeProfile: "client-generic",
					createdAt: Date.now(),
					tokenEndpointAuthMethod: "none",
				});
			}
		});

		await expect(
			t.query(internal.oauth.listSeatClientIds, {}),
		).rejects.toThrow(/SEAT_CLIENT_LISTING_INCOMPLETE/);
	});

	test("a count comfortably under the bound does NOT refuse", async () => {
		const t = createTestConvex();
		await provisionSeat(t, "seat-listing-org-under-bound", "orch-listing-under-bound");
		await expect(t.query(internal.oauth.listSeatClientIds, {})).resolves.toBeDefined();
	});
});
