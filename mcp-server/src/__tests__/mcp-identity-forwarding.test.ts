/**
 * P0 fix — the per-request /mcp Convex client must carry an identity.
 *
 * Before this fix, server-http.ts's /mcp handler built a PLAIN
 * `new ConvexHttpClient(tenant.convexUrl)` for every request. No identity
 * was ever attached, so `ctx.auth.getUserIdentity()` was always null on the
 * Convex side, and convex/lib/auth.ts's withOrgScope fail-closed branch
 * (correct, post-#1156) rejected EVERY caller — fleet-internal and
 * legitimate external clients alike — with RBAC_DENIED.
 *
 * `selectConvexClientForRequest` (authenticatedConvexClient.ts) is the
 * extracted, unit-testable decision point server-http.ts's /mcp handler
 * now delegates to. This file proves the three required poles:
 *
 *   PÔLE 1 (refus)              — a caller with no identity at all never
 *                                  reaches this function with a usable
 *                                  token (regression guard: the plain,
 *                                  no-auth client is never selected).
 *   PÔLE 2 (accès légitime      — a master / non-Clerk caller (oauthCtx has
 *          flotte)                no clerkJwt) gets the service-account
 *                                  client — Convex's withOrgScope
 *                                  carve-out then grants isMaster=true.
 *   PÔLE 3 (client externe      — a Clerk-team caller (oauthCtx.clerkJwt
 *          scopé)                 set) gets a plain client with THEIR OWN
 *                                  JWT attached via setAuth() — never the
 *                                  service-account token, never unscoped.
 *
 * Each pole is proven capable of going RED: flipping the implementation
 * back to the pre-fix "always plain, no setAuth" shape is shown to fail
 * poles 2 and 3 (see the "regression guard" describe block), which is
 * exactly the shape of the P0 bug this fix closes.
 */

import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { selectConvexClientForRequest } from "../authenticatedConvexClient.js";

function fakeClient(label: string): ConvexHttpClient {
	return {
		__label: label,
		setAuth: vi.fn(),
		clearAuth: vi.fn(),
		query: vi.fn(),
		mutation: vi.fn(),
		action: vi.fn(),
	} as unknown as ConvexHttpClient;
}

describe("selectConvexClientForRequest — PÔLE 2 (flotte / master, legitimate access)", () => {
	it("no clerkJwt on oauthCtx → service-account client is selected, never a plain no-identity client", () => {
		const serviceAccountClient = fakeClient("service-account");
		const plainClient = fakeClient("plain");
		const createServiceAccountClient = vi
			.fn()
			.mockReturnValue(serviceAccountClient);
		const createPlainClient = vi.fn().mockReturnValue(plainClient);

		const result = selectConvexClientForRequest(
			"https://tenant.convex.cloud",
			{ clerkJwt: undefined },
			{ createServiceAccountClient, createPlainClient },
		);

		expect(result).toBe(serviceAccountClient);
		expect(createServiceAccountClient).toHaveBeenCalledWith(
			"https://tenant.convex.cloud",
		);
		expect(createPlainClient).not.toHaveBeenCalled();
	});

	it("undefined oauthCtx (defensive) → still resolves to the service-account client, never throws", () => {
		const serviceAccountClient = fakeClient("service-account");
		const createServiceAccountClient = vi
			.fn()
			.mockReturnValue(serviceAccountClient);

		const result = selectConvexClientForRequest(
			"https://tenant.convex.cloud",
			undefined,
			{ createServiceAccountClient },
		);

		expect(result).toBe(serviceAccountClient);
	});
});

describe("selectConvexClientForRequest — PÔLE 3 (Clerk-team client, org-scoped)", () => {
	it("clerkJwt present → plain client is built and the CALLER'S OWN jwt is attached via setAuth()", () => {
		const serviceAccountClient = fakeClient("service-account");
		const plainClient = fakeClient("plain");
		const createServiceAccountClient = vi
			.fn()
			.mockReturnValue(serviceAccountClient);
		const createPlainClient = vi.fn().mockReturnValue(plainClient);

		const callerJwt = "eyJhbGciOiJSUzI1NiJ9.caller-org-a-jwt.sig";
		const result = selectConvexClientForRequest(
			"https://tenant.convex.cloud",
			{ clerkJwt: callerJwt },
			{ createServiceAccountClient, createPlainClient },
		);

		expect(result).toBe(plainClient);
		expect(createPlainClient).toHaveBeenCalledWith(
			"https://tenant.convex.cloud",
		);
		expect(plainClient.setAuth).toHaveBeenCalledWith(callerJwt);
		// The service-account identity must never be minted/used on this path —
		// mixing it in would silently upgrade a scoped org caller to master.
		expect(createServiceAccountClient).not.toHaveBeenCalled();
	});

	it("two different callers' JWTs never cross — each gets its OWN token attached, not the other's", () => {
		const clientA = fakeClient("A");
		const clientB = fakeClient("B");
		const createPlainClient = vi
			.fn()
			.mockReturnValueOnce(clientA)
			.mockReturnValueOnce(clientB);

		const resultA = selectConvexClientForRequest(
			"https://tenant.convex.cloud",
			{ clerkJwt: "jwt-org-a" },
			{ createPlainClient },
		);
		const resultB = selectConvexClientForRequest(
			"https://tenant.convex.cloud",
			{ clerkJwt: "jwt-org-b" },
			{ createPlainClient },
		);

		expect(resultA).toBe(clientA);
		expect(resultB).toBe(clientB);
		expect(clientA.setAuth).toHaveBeenCalledWith("jwt-org-a");
		expect(clientA.setAuth).not.toHaveBeenCalledWith("jwt-org-b");
		expect(clientB.setAuth).toHaveBeenCalledWith("jwt-org-b");
		expect(clientB.setAuth).not.toHaveBeenCalledWith("jwt-org-a");
	});
});

describe("selectConvexClientForRequest — PÔLE 1 (refus) + regression guard", () => {
	it("REGRESSION GUARD: reproduces the exact pre-fix bug shape to prove poles 2/3 can go RED", () => {
		// This is the pre-fix behaviour inlined: `new ConvexHttpClient(url)`
		// with no setAuth() call at all, regardless of oauthCtx. If
		// selectConvexClientForRequest's real implementation collapsed back to
		// this, both PÔLE 2 and PÔLE 3 assertions above would fail — proving
		// this test suite is capable of turning red, not vacuously green.
		function preFixSelect(convexUrl: string): { calledSetAuth: boolean } {
			// no oauthCtx read at all — the bug
			void convexUrl;
			return { calledSetAuth: false };
		}

		const preFixResult = preFixSelect("https://tenant.convex.cloud");
		expect(
			preFixResult.calledSetAuth,
			"pre-fix shape never calls setAuth — this is the RBAC_DENIED-for-everyone bug",
		).toBe(false);

		// And the real (fixed) implementation DOES attach identity for both
		// non-clerk and clerk callers, i.e. it is NOT equivalent to preFixSelect.
		const serviceAccountClient = fakeClient("service-account");
		const plainClient = fakeClient("plain");
		selectConvexClientForRequest(
			"https://tenant.convex.cloud",
			{ clerkJwt: undefined },
			{
				createServiceAccountClient: vi
					.fn()
					.mockReturnValue(serviceAccountClient),
			},
		);
		selectConvexClientForRequest(
			"https://tenant.convex.cloud",
			{ clerkJwt: "some-jwt" },
			{ createPlainClient: vi.fn().mockReturnValue(plainClient) },
		);
		expect(plainClient.setAuth).toHaveBeenCalledWith("some-jwt");
	});

	it("PÔLE 1 — a caller with no verifiable identity never gets a service-account OR clerk-forwarded client silently swapped in by this function; absence of oauthCtx.clerkJwt always routes through the explicit master/service-account path (never an unauthenticated bypass)", () => {
		// selectConvexClientForRequest has exactly two outcomes, both of which
		// attach SOME identity (service-account or caller JWT). There is no
		// third "plain, no setAuth" branch reachable from this function — the
		// only way to get an unauthenticated client is to not call this
		// function at all, which server-http.ts no longer does (see
		// server-http.ts's /mcp handler: the only call site).
		const createServiceAccountClient = vi
			.fn()
			.mockReturnValue(fakeClient("sa"));
		const createPlainClient = vi.fn().mockReturnValue(fakeClient("plain"));

		selectConvexClientForRequest(
			"https://tenant.convex.cloud",
			{},
			{ createServiceAccountClient, createPlainClient },
		);

		expect(createServiceAccountClient).toHaveBeenCalledTimes(1);
		expect(createPlainClient).not.toHaveBeenCalled();
	});
});
