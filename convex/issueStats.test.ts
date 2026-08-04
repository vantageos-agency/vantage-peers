/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// issueStats.test.ts — bug #1135
// ─────────────────────────────────────────────────────────────────────────────
// calculateStats' GitHub issues fetch() must not let a thrown network error
// (DNS, ECONNREFUSED, timeout, TLS) escape uncaught as "fetch failed". It must
// be caught, logged, and return null — consistent with the existing !ok path
// (which already returns null on an HTTP error response) — so one repo's
// network blip degrades gracefully instead of aborting the whole
// calculateAllRepos cron loop (which does not isolate per-repo failures).
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("errorMonitorAutoResolver") &&
			!path.includes("errorMonitorActions"),
	),
);

function createT() {
	return convexTest(schema, modules);
}

describe("issueStats.calculateStats — thrown fetch failure (bug #1135)", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.stubEnv("GITHUB_TOKEN", "test-github-token");
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.unstubAllEnvs();
	});

	test("a thrown fetch (network failure) does not crash the action — returns null", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

		const t = createT();

		// RED (pre-fix): this call throws an uncaught "fetch failed" TypeError.
		// GREEN (post-fix): the action catches it, logs, and resolves to null.
		await expect(
			t.action(internal.issueStats.calculateStats, {
				repo: "vantageos/vantage-memory",
			}),
		).resolves.toBeNull();

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	test("a non-JSON body (thrown .json() parse error) does not crash the action — returns null", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.reject(new SyntaxError("Unexpected token in JSON")),
		});

		const t = createT();

		await expect(
			t.action(internal.issueStats.calculateStats, {
				repo: "vantageos/vantage-memory",
			}),
		).resolves.toBeNull();
	});
});
