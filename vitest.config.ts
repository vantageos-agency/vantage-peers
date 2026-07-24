import { defineConfig } from "vitest/config";

/**
 * Root vitest config for the vantage-memory monorepo.
 *
 * Sets VP_TEST_MODE=1 so mcp-server/server-http.ts skips its Bun.serve()
 * bootstrap when tests are run from the repo root (the mcp-server directory
 * has its own vitest.config.ts that also sets this, but that config is only
 * consulted when running `vitest` from within mcp-server/).
 *
 * BEARER_SECRET_MASTER must match what mcp-server/test/*.test.ts expects
 * ("test-master-token"). Convex tests use vi.stubEnv() to override this
 * per-suite with their own values and are unaffected.
 *
 * PUBLIC_BASE_URL and CONVEX_URL_INTERNAL are required by server-http.ts
 * import-time initialisation even in test mode.
 */
export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		env: {
			VP_TEST_MODE: "1",
			BEARER_SECRET_MASTER: "test-master-token",
			PUBLIC_BASE_URL: "http://localhost:3000",
			CONVEX_URL_INTERNAL: "http://localhost:9999",
			CLERK_SERVICE_ACCOUNT_USER_ID: "test-service-account-user-id",
		},
	},
});
