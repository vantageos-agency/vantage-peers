/**
 * Proves the service-account env-var contract is SELECTIVE, not a blanket
 * refusal — the exact gap the production incident exposed.
 *
 * Incident (measured, Railway log verbatim): every authenticated MCP call
 * returned 503 with
 *   "[auth] Convex lookup failed: [mcp-server] no service-account identity
 *    available (CLERK_SECRET_KEY / CLERK_SERVICE_ACCOUNT_USER_ID not
 *    configured) — refusing to send an unauthenticated Convex query()"
 * because neither CLERK_SECRET_KEY nor CLERK_SERVICE_ACCOUNT_USER_ID was
 * provisioned anywhere. The fail-closed design (serviceAccountAuth.ts:77-84,
 * authenticatedConvexClient.ts:43-54) did exactly what it was built to do:
 * refuse rather than silently fall back to an anonymous Convex call. But
 * `git grep -rln "Authentication service unavailable" -- mcp-server/src`
 * shows only auth.ts — no test ever crossed this boundary in either
 * direction.
 *
 * A test that only proves "missing config -> refuse" does not prove the
 * refusal is CONDITIONAL on that specific cause. Without the positive
 * control (config present -> does NOT refuse for this reason), a guard that
 * throws unconditionally — regardless of configuration — would also pass a
 * refusal-only test, and that would be a broken guard wearing a passing test
 * as camouflage.
 *
 * Boundary chosen: loadConfig() (via the test-only _loadConfigForTest hook)
 * and the proxy refusal in createServiceAccountConvexClient(). This is the
 * closest boundary that stays meaningful without live-network machinery:
 * loadConfig() reads real process.env, and the negative-path proxy tests
 * exercise createServiceAccountConvexClient() end-to-end with real env vars
 * unset, so getServiceAccountToken() genuinely returns null via the real
 * loadConfig() (no dependency override involved in the negative tests).
 *
 * NOT covered by this file, and why: the actual Hono request handler in
 * auth.ts:531-541 (the try/catch around
 * internalClient().query("mcpTenants:getTenantByTokenHash") that emits the
 * literal HTTP 503 "Authentication service unavailable" JSON response) is not
 * exercised here. Driving that would require constructing a full Hono
 * request/response cycle plus a real or mocked mcpTenants:getTenantByTokenHash
 * Convex query, which is disproportionate machinery for what this test needs
 * to prove: that the refusal is selective on the two named env vars. The
 * positive-path assertions below use injected deps (_setServiceAccountDepsForTest,
 * same pattern as internalClientIdentity.test.ts) specifically so no live
 * Clerk network call happens in this suite either.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createServiceAccountConvexClient } from "../authenticatedConvexClient.js";
import {
	_loadConfigForTest,
	_resetServiceAccountCacheForTest,
	_setServiceAccountDepsForTest,
	type ServiceAccountDeps,
} from "../serviceAccountAuth.js";

const ORIGINAL_ENV = { ...process.env };

function clearServiceAccountEnv(): void {
	delete process.env.CLERK_SECRET_KEY;
	delete process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
	delete process.env.CLERK_DOMAIN;
	delete process.env.CLERK_JWT_TEMPLATE;
}

beforeEach(() => {
	clearServiceAccountEnv();
});

afterEach(() => {
	// Restore the full environment so no case leaks into the next test — a
	// reused tree is not a clean room.
	process.env = { ...ORIGINAL_ENV };
	clearServiceAccountEnv();
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (key.startsWith("CLERK_")) process.env[key] = value;
	}
	_setServiceAccountDepsForTest(null);
	_resetServiceAccountCacheForTest();
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
		createSignInTicket: vi.fn().mockResolvedValue("ticket-fake"),
		exchangeTicketForSession: vi.fn().mockResolvedValue("sess_fake"),
		getSessionToken: vi.fn().mockResolvedValue({
			jwt: fakeJwt(),
			exp: Date.now() + 3_600_000,
		}),
	};
}

describe("service-account env-var contract — negative pole (config absent)", () => {
	test("loadConfig() returns null when CLERK_SECRET_KEY is missing", () => {
		process.env.CLERK_SERVICE_ACCOUNT_USER_ID = "user_fake_service_account";
		// CLERK_SECRET_KEY intentionally left unset.
		expect(_loadConfigForTest()).toBeNull();
	});

	test("loadConfig() returns null when CLERK_SERVICE_ACCOUNT_USER_ID is missing", () => {
		process.env.CLERK_SECRET_KEY = "sk_test_fake_00000000000000000000";
		// CLERK_SERVICE_ACCOUNT_USER_ID intentionally left unset.
		expect(_loadConfigForTest()).toBeNull();
	});

	test("loadConfig() returns null when both are missing", () => {
		// Both intentionally left unset (cleared in beforeEach).
		expect(_loadConfigForTest()).toBeNull();
	});

	test.each([
		{
			label: "CLERK_SECRET_KEY missing",
			setup: () => {
				process.env.CLERK_SERVICE_ACCOUNT_USER_ID =
					"user_fake_service_account";
			},
		},
		{
			label: "CLERK_SERVICE_ACCOUNT_USER_ID missing",
			setup: () => {
				process.env.CLERK_SECRET_KEY = "sk_test_fake_00000000000000000000";
			},
		},
		{
			label: "both missing",
			setup: () => {
				/* nothing set — both stay unset */
			},
		},
	])(
		"createServiceAccountConvexClient() refuses and NAMES both env vars in the error when $label",
		async ({ setup }) => {
			setup();

			// No deps override here on purpose: getServiceAccountToken() must go
			// through the REAL loadConfig() reading process.env, exactly as it
			// does on the production request path.
			const client = createServiceAccountConvexClient(
				"https://internal.convex.cloud",
			);

			await expect(
				client.query("some:query" as never, {}),
			).rejects.toThrow(
				/CLERK_SECRET_KEY.*CLERK_SERVICE_ACCOUNT_USER_ID.*not configured/,
			);
		},
	);
});

describe("service-account env-var contract — positive pole (config present)", () => {
	test("loadConfig() returns a populated config when both env vars are set (fake values)", () => {
		process.env.CLERK_SECRET_KEY = "sk_test_fake_00000000000000000000";
		process.env.CLERK_SERVICE_ACCOUNT_USER_ID = "user_fake_service_account";

		const config = _loadConfigForTest();

		expect(config).not.toBeNull();
		expect(config?.secretKey).toBe("sk_test_fake_00000000000000000000");
		expect(config?.userId).toBe("user_fake_service_account");
		// Defaults apply when the optional overrides are absent.
		expect(config?.domain).toBe("https://sharp-sponge-67.clerk.accounts.dev");
		expect(config?.template).toBe("convex");
	});

	test("createServiceAccountConvexClient() does NOT refuse for 'not configured' when credential is present", async () => {
		process.env.CLERK_SECRET_KEY = "sk_test_fake_00000000000000000000";
		process.env.CLERK_SERVICE_ACCOUNT_USER_ID = "user_fake_service_account";
		// Inject a fake dependency surface so no live Clerk network call
		// happens — same technique as internalClientIdentity.test.ts. This
		// proves the refusal-avoidance is a property of config presence, not
		// an artifact of skipping the deps entirely.
		_setServiceAccountDepsForTest(workingDeps());

		const client = createServiceAccountConvexClient(
			"https://internal.convex.cloud",
		);

		const setAuthSpy = vi.spyOn(client, "setAuth");
		// The query itself may still fail on the wire (fake URL, no real
		// Convex deployment) — that is irrelevant to this assertion. What
		// matters is that it does NOT fail with the "not configured" refusal,
		// and that setAuth() was reached, proving the token was minted and
		// attached before the wire call was attempted.
		await client.query("some:query" as never, {}).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).not.toMatch(/not configured/);
		});

		expect(setAuthSpy).toHaveBeenCalledTimes(1);
		const [token] = setAuthSpy.mock.calls[0] as [string];
		expect(typeof token).toBe("string");
		expect(token.length).toBeGreaterThan(0);
	});
});
