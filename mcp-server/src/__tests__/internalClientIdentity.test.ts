/**
 * Proves that internalClient() (mcp-server/src/auth.ts) presents a verifiable
 * service-account identity on every outgoing Convex call — not just that a
 * token-minting module exists and compiles.
 *
 * The trap this closes: createServiceAccountConvexClient() was fully
 * implemented and unit-tested (serviceAccountAuth.test.ts) but never called
 * from the real request path. buildInternalClient() constructed a bare
 * `new ConvexHttpClient(url)` with no .setAuth() — every MCP tool call went
 * out with zero identity, and Convex's withOrgScope() treated "no identity"
 * as isMaster=true (unfiltered cross-tenant reads).
 *
 * These tests assert on the actual constructed client returned by
 * internalClient(), not on serviceAccountAuth.ts in isolation.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _setInternalClientForTest, internalClient } from "../auth.js";
import {
	_resetServiceAccountCacheForTest,
	_setServiceAccountDepsForTest,
	type ServiceAccountDeps,
} from "../serviceAccountAuth.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	process.env.CONVEX_URL_INTERNAL = "https://internal.convex.cloud";
	_setInternalClientForTest(null);
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	_setServiceAccountDepsForTest(null);
	_resetServiceAccountCacheForTest();
	_setInternalClientForTest(null);
	vi.restoreAllMocks();
});

function fakeJwt(): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
		"base64url",
	);
	const payload = Buffer.from(
		JSON.stringify({
			sub: "user_service_account_mcp",
			exp: Math.floor(Date.now() / 1000) + 3600,
		}),
	).toString("base64url");
	return `${header}.${payload}.`;
}

function workingDeps(): ServiceAccountDeps {
	return {
		createSignInTicket: vi.fn().mockResolvedValue("ticket-abc"),
		exchangeTicketForSession: vi.fn().mockResolvedValue("sess_123"),
		getSessionToken: vi.fn().mockResolvedValue({
			jwt: fakeJwt(),
			exp: Date.now() + 3_600_000,
		}),
	};
}

describe("internalClient() outgoing identity", () => {
	test("setAuth() is called with a non-empty token before a query goes out", async () => {
		_setServiceAccountDepsForTest(workingDeps());

		const client = internalClient();

		const setAuthSpy = vi.spyOn(client, "setAuth");
		// Any Convex network error is fine here — we only care that setAuth
		// was invoked with a real token before the wire call was attempted.
		await client.query("some:query" as never, {}).catch(() => {});

		expect(setAuthSpy).toHaveBeenCalledTimes(1);
		const [token] = setAuthSpy.mock.calls[0] as [string];
		expect(typeof token).toBe("string");
		expect(token.length).toBeGreaterThan(0);
	});

	test("fail-closed: when the service-account credential is not configured, the outgoing call throws and never proceeds unauthenticated", async () => {
		_setServiceAccountDepsForTest(null); // no credential configured

		const client = internalClient();

		const setAuthSpy = vi.spyOn(client, "setAuth");

		await expect(client.query("some:query" as never, {})).rejects.toThrow();
		expect(setAuthSpy).not.toHaveBeenCalled();
	});
});
