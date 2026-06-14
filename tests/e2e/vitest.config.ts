import { defineConfig } from "vitest/config";

/**
 * Vitest config for CRUD-T3 PROD Railway e2e smoke matrix.
 *
 * These tests hit the real Railway PROD MCP endpoint via HTTPS.
 * They require VP_MCP_PROD_URL and VP_MCP_BEARER_TOKEN to be set.
 * When absent, all tests skip gracefully (suite exits 0).
 *
 * Timeout: 30 s per test — PROD network round-trips can be slow.
 * No mock / no local server spin-up.
 */
export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: ["tests/e2e/**/*.spec.ts"],
		testTimeout: 30_000,
		// Sequential execution — tests within each entity describe block share
		// state (created IDs). Running in parallel risks race conditions in
		// afterAll cleanup.
		fileParallelism: false,
	},
});
