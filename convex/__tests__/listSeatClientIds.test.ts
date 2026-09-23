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

	// ─────────────────────────────────────────────────────────────────────────
	// INTERNAL-ONLY — two controls, not one, because they prove different
	// things and neither substitutes for the other.
	//
	// Control A (below, "runtime attempt"): tries the ACTUAL public-path
	// call this property is about — `t.query(api.oauth.listSeatClientIds,
	// {})` — and asserts on what happens. MEASURED, not assumed: in THIS
	// harness (convex-test) it does NOT throw. It resolves successfully.
	// `node_modules/convex-test/dist/index.js`'s `getFunctionFromPath` looks
	// the export up by NAME ONLY and checks `func.isQuery` — a flag that is
	// `true` for BOTH `query()` and `internalQuery()` registrations, because
	// `api`/`internal` are the exact same `anyApi` Proxy
	// (`convex/_generated/api.js`) generating the identical path string
	// regardless of which namespace you read it from. So `t.query()` cannot
	// see internal/public visibility at all — that boundary is enforced by
	// the real Convex deployment's bundler (internal functions are excluded
	// from the client-facing function manifest) and the sync-protocol
	// server, NEITHER of which convex-test runs.
	//
	// I confirmed this both ways rather than assert it from reading the
	// harness source: with `listSeatClientIds` as `internalQuery` (the
	// shipped state), `t.query(api.oauth.listSeatClientIds, {})` resolved
	// with `[]`. I then temporarily changed the implementation to `query`
	// and reran the identical call — it ALSO resolved with `[]`, no
	// behavioural difference at all. A runtime attempt that succeeds
	// identically in both the internal and the public state proves nothing
	// about internal-only-ness in this harness; asserting a "refused" outcome
	// here would be dressing up a TypeError-shaped finding as a Convex
	// visibility refusal, which is exactly what was asked not to do. The
	// control below therefore asserts on what ACTUALLY happens (resolves,
	// does not throw) and documents why that is the honest, if weaker,
	// finding — this is Control A's whole and only claim.
	//
	// Control B (the next test): the actual internal-only guarantee, proven
	// at COMPILE time — the layer that DOES exist between this test suite
	// and a real deployment, since a client can only ever reach a function
	// through the `api` namespace's generated TYPE, and that type is what a
	// hand-written MCP tool or Convex client SDK call site would fail to
	// compile against.
	// ─────────────────────────────────────────────────────────────────────────
	test("runtime attempt (Control A): t.query(api.oauth.listSeatClientIds, ...) does NOT throw in convex-test — this harness has no visibility enforcement, so this control asserts the measured (non-)outcome rather than an assumed refusal", async () => {
		const t = createTestConvex();
		// @ts-expect-error — api.oauth has no listSeatClientIds member at the
		// TYPE level (see Control B below); calling through it anyway is the
		// attempt this test makes, exactly as asked: not reading the
		// declaration, actually trying the call.
		const attempt = t.query(api.oauth.listSeatClientIds, {});
		// MEASURED OUTCOME: resolves, does not throw. Confirmed identically
		// when the implementation was temporarily changed to `query` (see
		// comment block above) — same resolution, same value shape, in both
		// the internal and the public state. This is NOT a Convex
		// "could not find public function" refusal, and it is NOT a
		// TypeError either (there is no runtime type error to throw — the
		// Proxy accepts any property path). It is a plain successful
		// resolution. Recorded here as the honest finding rather than
		// asserted as a refusal it did not produce.
		await expect(attempt).resolves.toBeInstanceOf(Array);
	});

	// Control B — the actual internal/public boundary, proven at COMPILE
	// time. `api.oauth`'s generated TYPE (built from the `query`/
	// `internalQuery` declaration in convex/oauth.ts) only lists functions
	// declared with `query`/`mutation`/`action`. The line below must be a
	// type error today (listSeatClientIds is an internalQuery, absent from
	// `api.oauth`'s type) — if a future edit changed `internalQuery` to
	// `query`, the access would stop erroring, `@ts-expect-error` would
	// itself become an unused-directive error, and
	// `bunx tsc --noEmit -p convex` (the CI gate cited in this task's brief)
	// would fail. Proven RED against a reference exposed version: swapping
	// `internalQuery` for `query` in the implementation locally and rerunning
	// `bunx tsc --noEmit -p convex` turned this exact line's `@ts-expect-error`
	// into `TS2578: Unused '@ts-expect-error' directive` — verbatim in this
	// task's report.
	//
	// This test has no runtime assertion by design — its entire claim is
	// checked by the compiler, not by anything that executes. It exists
	// alongside Control A, not instead of it.
	test("compile-time proof (Control B): api.oauth has no listSeatClientIds member — checked by tsc, not by this test's runtime", () => {
		function assertApiOauthHasNoListSeatClientIdsAtCompileTime(): void {
			// @ts-expect-error — listSeatClientIds is an internalQuery; it
			// must NOT be a member of api.oauth's generated type. This
			// function is never called — it exists purely for tsc to check.
			api.oauth.listSeatClientIds;
		}
		void assertApiOauthHasNoListSeatClientIdsAtCompileTime;
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
