import { defineConfig } from "vitest/config";

/**
 * Vitest config for VP MCP server unit tests.
 *
 * VP_TEST_MODE=1 prevents server-http.ts from binding a Bun socket at
 * import time (see bottom of server-http.ts). BEARER_SECRET_MASTER is set
 * to a known value so the /authorize + /token mint flows do not 500 on
 * missing-env when the route handlers run inside Hono's app.request().
 */
export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: ["test/**/*.test.ts"],
		env: {
			VP_TEST_MODE: "1",
			BEARER_SECRET_MASTER: "test-master-token",
			PUBLIC_BASE_URL: "http://localhost:3000",
			CONVEX_URL_INTERNAL: "http://localhost:9999",
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			include: ["server-http.ts"],
			reportsDirectory: "./coverage",
		},
	},
});
