/**
 * server.ts (stdio bootstrap) built a bare `new ConvexHttpClient(convexUrl)`
 * and never called .setAuth() — Convex saw no identity, so withOrgScope's
 * fail-closed branch (convex/lib/auth.ts) refused every scope-guarded query
 * and requireAuthenticatedCaller refused every mutation.
 *
 * This proves the stdio bootstrap now routes through
 * createServiceAccountConvexClient (authenticatedConvexClient.ts) — the SAME
 * factory server-http.ts's non-Clerk /mcp branch already used — by asserting
 * on the outgoing call itself: the underlying Convex client's .setAuth() is
 * invoked with a minted token BEFORE a query reaches the wire. It never
 * inspects a tool result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { instances, registerToolsMock, capturedConvex } = vi.hoisted(() => ({
	instances: [] as Array<{
		url: string;
		setAuth: ReturnType<typeof vi.fn>;
		clearAuth: ReturnType<typeof vi.fn>;
		query: ReturnType<typeof vi.fn>;
		mutation: ReturnType<typeof vi.fn>;
		action: ReturnType<typeof vi.fn>;
	}>,
	registerToolsMock: vi.fn(),
	capturedConvex: { current: undefined as unknown },
}));

vi.mock("convex/browser", () => {
	class FakeConvexHttpClient {
		url: string;
		setAuth = vi.fn();
		clearAuth = vi.fn();
		query = vi.fn().mockResolvedValue("ok");
		mutation = vi.fn().mockResolvedValue("ok");
		action = vi.fn().mockResolvedValue("ok");
		constructor(url: string) {
			this.url = url;
			instances.push(this);
		}
	}
	return { ConvexHttpClient: FakeConvexHttpClient };
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
	McpServer: class {
		connect = vi.fn().mockResolvedValue(undefined);
	},
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
	StdioServerTransport: class {},
}));

vi.mock("../tools.js", () => ({
	registerTools: (...args: unknown[]) => {
		capturedConvex.current = args[1];
		return registerToolsMock(...args);
	},
}));

const ORIGINAL_ENV = { ...process.env };
const FAKE_JWT = "eyJhbGciOiJSUzI1NiJ9.stdio-service-account.sig";

describe("stdio bootstrap (server.ts) — service-account identity", () => {
	beforeEach(() => {
		vi.resetModules();
		instances.length = 0;
		registerToolsMock.mockClear();
		capturedConvex.current = undefined;
		process.env.CONVEX_URL = "https://stdio-test.convex.cloud";
	});

	afterEach(async () => {
		process.env = { ...ORIGINAL_ENV };
		const serviceAccountAuth = await import("../serviceAccountAuth.js");
		serviceAccountAuth._setServiceAccountDepsForTest(null);
		serviceAccountAuth._resetServiceAccountCacheForTest();
	});

	it("reaches Convex WITH an identity attached: setAuth() fires with a minted token before the wire call", async () => {
		// Deps must be injected on the SAME module instance server.ts's import
		// graph resolves to — after vi.resetModules(), that means importing
		// serviceAccountAuth.js dynamically here, not via a static top-of-file
		// import (which would be a stale, pre-reset module instance).
		const { _setServiceAccountDepsForTest } = await import(
			"../serviceAccountAuth.js"
		);
		_setServiceAccountDepsForTest(
			{
				createSignInTicket: vi.fn().mockResolvedValue("fake-ticket"),
				exchangeTicketForSession: vi.fn().mockResolvedValue("fake-session"),
				getSessionToken: vi.fn().mockResolvedValue({
					jwt: FAKE_JWT,
					exp: Date.now() + 60_000,
				}),
			},
			{
				userId: "test-service-account-user",
				domain: "https://test.clerk.accounts.dev",
				template: "convex",
			},
		);

		await import("../../server.js");

		expect(registerToolsMock).toHaveBeenCalledTimes(1);
		const convex = capturedConvex.current as {
			query: (...a: unknown[]) => Promise<unknown>;
		};
		expect(convex).toBeDefined();

		await convex.query("fake:query", {});

		expect(instances).toHaveLength(1);
		const client = instances[0];
		expect(client.url).toBe("https://stdio-test.convex.cloud");
		// The token-set call is the outgoing-identity assertion — never a tool
		// result.
		expect(client.setAuth).toHaveBeenCalledWith(FAKE_JWT);
		expect(client.query).toHaveBeenCalledWith("fake:query", {});
	});
});
