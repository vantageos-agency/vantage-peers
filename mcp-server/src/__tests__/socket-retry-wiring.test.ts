/**
 * PR #1264 REVISE — the reviewer's finding is exact: the 9 passing tests in
 * socket-retry.test.ts all exercise the PURE helper (socketRetry.ts) in
 * isolation. Not one of them goes through the actual WIRING that decides
 * which Convex verbs get retried — authenticatedConvexClient.ts's
 * `RETRIED_METHODS` set (the service-account Proxy) and `withQueryRetry`
 * (the clerkJwt-branch monkey-patch). Proof: the reviewer changed
 *
 *   const RETRIED_METHODS = new Set(["query"]);
 * to
 *   const RETRIED_METHODS = new Set(["query", "mutation"]);
 *
 * and the entire 105-file suite stayed green — the one safety property this
 * whole change exists to establish (mutations are never blindly replayed on
 * a dead socket, because a replay could double-apply a side effect) had no
 * instrument at all.
 *
 * This file closes that gap by driving the REAL wiring, not the pure helper:
 *
 *   - createServiceAccountConvexClient's Proxy (the master/flotte path) —
 *     with an injected underlying ConvexHttpClient (via a `convex/browser`
 *     module mock) whose method throws the socket-close error on the first
 *     call and resolves on the second. The Clerk token mint itself is
 *     stubbed via serviceAccountAuth.ts's own `_setServiceAccountDepsForTest`
 *     test hook — no live Clerk call happens here.
 *   - withQueryRetry / selectConvexClientForRequest's clerkJwt branch (the
 *     org-scoped path) — with a directly-injected fake client, per the
 *     `createPlainClient` seam mcp-identity-forwarding.test.ts already
 *     established.
 *
 * Each pole below counts underlying calls, not just "did it throw" — a test
 * that only asserts "throws" would also pass if the retry wrapper were
 * removed entirely (a mutation with no retry logic still throws on its one
 * and only call). Counting calls is what actually pins the property.
 *
 * ACCEPTANCE: applying the reviewer's exact one-line edit to
 * authenticatedConvexClient.ts (RETRIED_METHODS gains "mutation") must turn
 * the "MUTATION pole" test below RED. See the PR's REVISE response for the
 * captured failure output under that edit.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// Must be declared via vi.hoisted — vi.mock() factories are hoisted above
// all other module-scope statements, so a plain `let` declared after this
// file's imports would still be in the temporal dead zone the first time
// "convex/browser" is resolved (which happens while authenticatedConvexClient.ts
// itself is being imported, below).
const convexBrowserMockState = vi.hoisted(() => ({
	target: null as unknown as Record<string, ReturnType<typeof import("vitest")["vi"]["fn"]>>,
}));

vi.mock("convex/browser", () => ({
	// A plain arrow function cannot be invoked with `new` — the constructor
	// stub must be a real `function` so `new ConvexHttpClientCtor(url)` in
	// authenticatedConvexClient.ts resolves to our injected fake target.
	ConvexHttpClient: vi.fn().mockImplementation(function ConvexHttpClient() {
		return convexBrowserMockState.target;
	}),
}));

import type { ConvexHttpClient } from "convex/browser";
import {
	createServiceAccountConvexClient,
	selectConvexClientForRequest,
	withQueryRetry,
} from "../authenticatedConvexClient.js";
import {
	_resetServiceAccountCacheForTest,
	_setServiceAccountDepsForTest,
	type ServiceAccountDeps,
} from "../serviceAccountAuth.js";

function socketCloseError(): Error {
	return new Error("The socket connection was closed unexpectedly");
}

function fakeUnderlyingTarget(): {
	setAuth: ReturnType<typeof vi.fn>;
	clearAuth: ReturnType<typeof vi.fn>;
	query: ReturnType<typeof vi.fn>;
	mutation: ReturnType<typeof vi.fn>;
	action: ReturnType<typeof vi.fn>;
} {
	return {
		setAuth: vi.fn(),
		clearAuth: vi.fn(),
		query: vi.fn(),
		mutation: vi.fn(),
		action: vi.fn(),
	};
}

const fixedMintedToken = {
	jwt: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.",
	exp: Date.now() + 60_000,
};

/**
 * Stubs the Clerk token mint via serviceAccountAuth.ts's own test hook — the
 * seam that file already exposes for exactly this purpose. No network call
 * to Clerk happens; createServiceAccountConvexClient still calls
 * getServiceAccountToken() and target.setAuth() before every attempt, same
 * as production.
 */
function stubServiceAccountToken(): void {
	const deps: ServiceAccountDeps = {
		createSignInTicket: vi.fn().mockResolvedValue("ticket-abc"),
		exchangeTicketForSession: vi.fn().mockResolvedValue("sess-abc"),
		getSessionToken: vi.fn().mockResolvedValue(fixedMintedToken),
	};
	_setServiceAccountDepsForTest(deps);
}

afterEach(() => {
	_setServiceAccountDepsForTest(null);
	_resetServiceAccountCacheForTest();
	vi.clearAllMocks();
});

describe("createServiceAccountConvexClient — WIRING (RETRIED_METHODS), not the pure helper", () => {
	it("MUTATION pole: socket-close on mutation() makes exactly ONE underlying call and the error propagates", async () => {
		stubServiceAccountToken();
		const target = fakeUnderlyingTarget();
		target.mutation
			.mockRejectedValueOnce(socketCloseError())
			.mockResolvedValueOnce("mutation-would-have-retried");
		convexBrowserMockState.target = target;

		const client = createServiceAccountConvexClient(
			"https://tenant.convex.cloud",
		);

		await expect(
			(client.mutation as (...a: unknown[]) => Promise<unknown>)(
				"api.foo.bar",
				{},
			),
		).rejects.toThrow("socket connection was closed unexpectedly");
		expect(target.mutation).toHaveBeenCalledTimes(1);
	});

	it("QUERY pole (twin): socket-close on query() makes exactly TWO underlying calls and the caller receives the value", async () => {
		stubServiceAccountToken();
		const target = fakeUnderlyingTarget();
		target.query
			.mockRejectedValueOnce(socketCloseError())
			.mockResolvedValueOnce("query-value");
		convexBrowserMockState.target = target;

		const client = createServiceAccountConvexClient(
			"https://tenant.convex.cloud",
		);

		const result = await (
			client.query as (...a: unknown[]) => Promise<unknown>
		)("api.foo.bar", {});

		expect(result).toBe("query-value");
		expect(target.query).toHaveBeenCalledTimes(2);
	});

	it("ACTION pole: socket-close on action() makes exactly ONE underlying call and the error propagates (same non-retry shape as mutation)", async () => {
		stubServiceAccountToken();
		const target = fakeUnderlyingTarget();
		target.action
			.mockRejectedValueOnce(socketCloseError())
			.mockResolvedValueOnce("action-would-have-retried");
		convexBrowserMockState.target = target;

		const client = createServiceAccountConvexClient(
			"https://tenant.convex.cloud",
		);

		await expect(
			(client.action as (...a: unknown[]) => Promise<unknown>)(
				"api.foo.bar",
				{},
			),
		).rejects.toThrow("socket connection was closed unexpectedly");
		expect(target.action).toHaveBeenCalledTimes(1);
	});
});

describe("withQueryRetry — the clerkJwt client path's wiring (query wrapped, mutation left untouched)", () => {
	it("QUERY pole: socket-close makes exactly TWO underlying calls and resolves the value", async () => {
		const originalQuery = vi
			.fn()
			.mockRejectedValueOnce(socketCloseError())
			.mockResolvedValueOnce("query-value");
		const client = {
			setAuth: vi.fn(),
			query: originalQuery,
			mutation: vi.fn(),
		} as unknown as ConvexHttpClient;

		const wrapped = withQueryRetry(client);
		const result = await (
			wrapped.query as (...a: unknown[]) => Promise<unknown>
		)("api.foo.bar", {});

		expect(result).toBe("query-value");
		expect(originalQuery).toHaveBeenCalledTimes(2);
		expect(wrapped).toBe(client); // reference-identical, per the doc comment
	});

	it("MUTATION pole: mutation() is never wrapped — exactly ONE call, error propagates untouched", async () => {
		const originalMutation = vi
			.fn()
			.mockRejectedValueOnce(socketCloseError());
		const client = {
			setAuth: vi.fn(),
			query: vi.fn(),
			mutation: originalMutation,
		} as unknown as ConvexHttpClient;

		const wrapped = withQueryRetry(client);

		await expect(
			(wrapped.mutation as (...a: unknown[]) => Promise<unknown>)(
				"api.foo.bar",
				{},
			),
		).rejects.toThrow("socket connection was closed unexpectedly");
		expect(originalMutation).toHaveBeenCalledTimes(1);
		expect(wrapped.mutation).toBe(originalMutation);
	});
});

describe("selectConvexClientForRequest — clerkJwt branch, end-to-end through the real entry point", () => {
	it("mutation makes exactly ONE call and propagates; query makes exactly TWO calls and resolves — same client instance", async () => {
		const originalMutation = vi
			.fn()
			.mockRejectedValueOnce(socketCloseError());
		const originalQuery = vi
			.fn()
			.mockRejectedValueOnce(socketCloseError())
			.mockResolvedValueOnce("query-value");
		const plainClient = {
			setAuth: vi.fn(),
			query: originalQuery,
			mutation: originalMutation,
		} as unknown as ConvexHttpClient;
		const createPlainClient = vi.fn().mockReturnValue(plainClient);

		const client = selectConvexClientForRequest(
			"https://tenant.convex.cloud",
			{ clerkJwt: "caller-org-a-jwt" },
			{ createPlainClient },
		);

		expect(client).toBe(plainClient);
		expect(plainClient.setAuth).toHaveBeenCalledWith("caller-org-a-jwt");

		await expect(
			(client.mutation as (...a: unknown[]) => Promise<unknown>)(
				"api.foo.bar",
				{},
			),
		).rejects.toThrow("socket connection was closed unexpectedly");
		expect(originalMutation).toHaveBeenCalledTimes(1);

		const queryResult = await (
			client.query as (...a: unknown[]) => Promise<unknown>
		)("api.foo.bar", {});
		expect(queryResult).toBe("query-value");
		expect(originalQuery).toHaveBeenCalledTimes(2);
	});
});
