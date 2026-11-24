import { configDefaults, defineConfig } from "vitest/config";

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
		// resources/ vendors separate repos (e.g. vantage-peers-dashboard, a
		// standalone UI project) whose *.test.* files reference paths that do
		// not exist in this tree and pollute every unscoped `vitest run` with
		// spurious reds. They are NOT part of this backend monorepo's suite
		// (Laurent Day 155: "exclure resources/ de la config vitest"). Extraction
		// of the vendored dashboard to its own repo remains the real fix.
		//
		// .claude/worktrees/ holds throwaway full checkouts made by agents (git
		// ignored, 9 on this host when measured). An unscoped `vitest run` from
		// the root otherwise runs EVERY test file of EVERY stale checkout as well,
		// multiplying the CPU-bound instrument suites (publicRegistrations
		// ResolveCallerInstrument is ~5 CPU-s per measurement) by the number of
		// worktrees and starving the real suite; it also reports their stale
		// reds as this tree's (task k1745b7rdfs6v7xxe9v4ph70nn8jtx19).
		exclude: [
			...configDefaults.exclude,
			"resources/**",
			".claude/worktrees/**",
		],
		env: {
			VP_TEST_MODE: "1",
			// server.ts (stdio) refuses to serve against a backend that fails the
			// compat boot check (src/backendContract.ts). Tests that boot it do so
			// against a placeholder URL by design; the boot check itself is covered
			// by mcp-server/test/backend-compat-boot.test.ts, which spawns server.ts
			// WITHOUT this switch.
			VP_BOOT_CHECK_OFFLINE: "1",
			BEARER_SECRET_MASTER: "test-master-token",
			PUBLIC_BASE_URL: "http://localhost:3000",
			CONVEX_URL_INTERNAL: "http://localhost:9999",
			CLERK_SERVICE_ACCOUNT_USER_ID: "test-service-account-user-id",
		},
	},
});
