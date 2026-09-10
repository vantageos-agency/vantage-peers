/**
 * server.ts (stdio bootstrap) hand-typed `version: "2.18.0"` into its
 * `new McpServer(...)` construction instead of deriving it from
 * package.json the way server-http.ts already does. This left the stdio
 * transport's `initialize` reply out of sync with the manifest the package
 * actually publishes.
 *
 * This test never hardcodes a version string — it reads package.json at
 * test time and asserts the advertised version equals that value, so it
 * cannot rot at the next version bump.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { capturedOptions, registerToolsMock } = vi.hoisted(() => ({
	capturedOptions: { current: undefined as { version?: string } | undefined },
	registerToolsMock: vi.fn(),
}));

vi.mock("convex/browser", () => {
	class FakeConvexHttpClient {
		setAuth = vi.fn();
		clearAuth = vi.fn();
		query = vi.fn().mockResolvedValue("ok");
		mutation = vi.fn().mockResolvedValue("ok");
		action = vi.fn().mockResolvedValue("ok");
		constructor(_url: string) {}
	}
	return { ConvexHttpClient: FakeConvexHttpClient };
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
	McpServer: class {
		constructor(options: { version?: string }) {
			capturedOptions.current = options;
		}
		connect = vi.fn().mockResolvedValue(undefined);
	},
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
	StdioServerTransport: class {},
}));

vi.mock("../tools.js", () => ({
	registerTools: (...args: unknown[]) => registerToolsMock(...args),
}));

const ORIGINAL_ENV = { ...process.env };

describe("stdio bootstrap (server.ts) — advertised version", () => {
	beforeEach(() => {
		vi.resetModules();
		capturedOptions.current = undefined;
		registerToolsMock.mockClear();
		process.env.CONVEX_URL = "https://stdio-version-test.convex.cloud";
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	it("advertises the version from package.json, not a hardcoded literal", async () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
		) as { version: string };

		await import("../../server.js");

		expect(capturedOptions.current?.version).toBe(manifest.version);
	});
});
