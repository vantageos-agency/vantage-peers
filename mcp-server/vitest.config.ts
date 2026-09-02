import { defineConfig } from "vitest/config";

/**
 * Vitest config for VP MCP server unit tests.
 *
 * VP_TEST_MODE=1 prevents server-http.ts from binding a Bun socket at
 * import time (see bottom of server-http.ts). BEARER_SECRET_MASTER is set
 * to a known value so the /authorize + /token mint flows do not 500 on
 * missing-env when the route handlers run inside Hono's app.request().
 *
 * CLERK_SERVICE_ACCOUNT_USER_ID mirrors the root vitest.config.ts value
 * ("test-service-account-user-id"). convex/lib/auth.ts's withOrgScope grants
 * the service-account carve-out ONLY when this env var matches the
 * convex-test identity's `.subject`. block_task_cause.tool.test.ts,
 * fail_task.tool.test.ts and update-task-mcp-optional-caller-still-refused.test.ts
 * exercise real MCP tool handlers -> real convex-test mutations end-to-end
 * with that exact subject and were failing RBAC_DENIED ("no organization
 * attached") when this suite ran standalone (`cd mcp-server && npx vitest
 * run`) because only the root config carried this var — the mcp-server
 * config, which is the one actually consulted for this command, did not.
 */
export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: ["test/**/*.test.ts", "src/__tests__/**/*.test.ts"],
		env: {
			VP_TEST_MODE: "1",
			BEARER_SECRET_MASTER: "test-master-token",
			PUBLIC_BASE_URL: "http://localhost:3000",
			CONVEX_URL_INTERNAL: "http://localhost:9999",
			CLERK_SERVICE_ACCOUNT_USER_ID: "test-service-account-user-id",
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			include: ["server-http.ts"],
			reportsDirectory: "./coverage",
		},
	},
});
