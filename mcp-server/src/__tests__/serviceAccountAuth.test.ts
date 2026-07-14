/**
 * Unit tests for the Clerk service-account token minting/caching logic
 * (mcp-server/src/serviceAccountAuth.ts).
 *
 * These are UNIT tests: the Clerk Backend SDK / Frontend API calls are
 * injected via _setServiceAccountDepsForTest, so no live network call to
 * Clerk happens here. This verifies OUR caching/refresh/error-handling logic
 * is correct; it does NOT prove the real Clerk sign-in-ticket exchange works
 * end-to-end against a live Clerk instance — that requires the provisioned
 * CLERK_SECRET_KEY / CLERK_SERVICE_ACCOUNT_USER_ID credential and a live
 * smoke test during activation (see task return message).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
	_resetServiceAccountCacheForTest,
	_setServiceAccountDepsForTest,
	getServiceAccountToken,
	type ServiceAccountDeps,
} from "../serviceAccountAuth.js";

afterEach(() => {
	_setServiceAccountDepsForTest(null);
});

function fakeJwt(expEpochSeconds: number): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
		"base64url",
	);
	const payload = Buffer.from(
		JSON.stringify({ sub: "user_service_account_mcp", exp: expEpochSeconds }),
	).toString("base64url");
	return `${header}.${payload}.`;
}

describe("getServiceAccountToken", () => {
	test("returns null when the service-account credential is not configured", async () => {
		_setServiceAccountDepsForTest(null);
		const token = await getServiceAccountToken();
		expect(token).toBeNull();
	});

	test("mints a fresh session via sign-in ticket exchange on first call", async () => {
		const createSignInTicket = vi.fn().mockResolvedValue("ticket-abc");
		const exchangeTicketForSession = vi.fn().mockResolvedValue("sess_123");
		const getSessionToken = vi.fn().mockResolvedValue({
			jwt: fakeJwt(Math.floor(Date.now() / 1000) + 60),
			exp: Date.now() + 60_000,
		});
		const deps: ServiceAccountDeps = {
			createSignInTicket,
			exchangeTicketForSession,
			getSessionToken,
		};
		_setServiceAccountDepsForTest(deps);

		const token = await getServiceAccountToken();

		expect(createSignInTicket).toHaveBeenCalledTimes(1);
		expect(exchangeTicketForSession).toHaveBeenCalledWith(
			"ticket-abc",
			expect.any(String),
		);
		expect(getSessionToken).toHaveBeenCalledWith("sess_123", "convex");
		expect(token).toContain(".");
	});

	test("reuses the cached session (no new sign-in ticket) for a second call within TTL", async () => {
		const createSignInTicket = vi.fn().mockResolvedValue("ticket-abc");
		const exchangeTicketForSession = vi.fn().mockResolvedValue("sess_123");
		const getSessionToken = vi.fn().mockResolvedValue({
			jwt: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
			exp: Date.now() + 3_600_000,
		});
		_setServiceAccountDepsForTest({
			createSignInTicket,
			exchangeTicketForSession,
			getSessionToken,
		});

		const first = await getServiceAccountToken();
		const second = await getServiceAccountToken();

		expect(first).toBe(second);
		// Cached token was still valid (far from expiry) — no re-mint at all.
		expect(getSessionToken).toHaveBeenCalledTimes(1);
		expect(createSignInTicket).toHaveBeenCalledTimes(1);
	});

	test("re-mints a template token from the existing session (no new sign-in ticket) once the cached token nears expiry", async () => {
		const createSignInTicket = vi.fn().mockResolvedValue("ticket-abc");
		const exchangeTicketForSession = vi.fn().mockResolvedValue("sess_123");
		const getSessionToken = vi
			.fn()
			.mockResolvedValueOnce({
				jwt: fakeJwt(Math.floor(Date.now() / 1000) + 1),
				exp: Date.now() + 1_000, // expires almost immediately -> within refresh margin
			})
			.mockResolvedValueOnce({
				jwt: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
				exp: Date.now() + 3_600_000,
			});
		_setServiceAccountDepsForTest({
			createSignInTicket,
			exchangeTicketForSession,
			getSessionToken,
		});

		const first = await getServiceAccountToken();
		const second = await getServiceAccountToken();

		expect(first).not.toBe(second);
		// Re-minted via the SAME session — never re-ran the sign-in-ticket flow.
		expect(createSignInTicket).toHaveBeenCalledTimes(1);
		expect(exchangeTicketForSession).toHaveBeenCalledTimes(1);
		expect(getSessionToken).toHaveBeenCalledTimes(2);
	});

	test("falls back to a new sign-in ticket flow when the cached session stops yielding tokens", async () => {
		const createSignInTicket = vi
			.fn()
			.mockResolvedValueOnce("ticket-1")
			.mockResolvedValueOnce("ticket-2");
		const exchangeTicketForSession = vi
			.fn()
			.mockResolvedValueOnce("sess_expired")
			.mockResolvedValueOnce("sess_new");
		const getSessionToken = vi
			.fn()
			.mockResolvedValueOnce({
				jwt: fakeJwt(Math.floor(Date.now() / 1000) + 1),
				exp: Date.now() + 1_000,
			})
			.mockResolvedValueOnce(null) // session expired server-side
			.mockResolvedValueOnce({
				jwt: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
				exp: Date.now() + 3_600_000,
			});
		_setServiceAccountDepsForTest({
			createSignInTicket,
			exchangeTicketForSession,
			getSessionToken,
		});

		await getServiceAccountToken(); // primes cache with a near-expiry token
		const second = await getServiceAccountToken(); // session returns null -> new ticket flow

		expect(second).not.toBeNull();
		expect(createSignInTicket).toHaveBeenCalledTimes(2);
		expect(exchangeTicketForSession).toHaveBeenCalledTimes(2);
	});
});

afterEach(() => {
	_resetServiceAccountCacheForTest();
});
