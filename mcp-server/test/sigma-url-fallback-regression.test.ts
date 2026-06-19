/**
 * Day 107 — Sigma URL fallback removed (Cédric Self-host BLOCKER root cause).
 *
 * Regression test for PR #875.
 *
 * auth.ts:247 + server-http.ts:65 used to fall back to
 * "https://vantage-peers-production.up.railway.app" (Sigma's VantagePeers
 * Cloud URL) when PUBLIC_BASE_URL env was unset. Any Self-host deploy that
 * forgot the env var silently advertised Sigma's PRM endpoint in
 * `WWW-Authenticate: resource_metadata=`, breaking every Self-host
 * customer's DCR chain with `invalid_client`.
 *
 * Fix: derive from Hono Context's Host + x-forwarded-proto headers (RFC
 * 8414 §2 — issuer MUST be the URL the client used). Env fallback only if
 * Host is absent. Fail closed (HTTP 500) when neither is set.
 *
 * Eta REVISE iter 1 verdict on PR #875:
 *   https://github.com/vantageos-agency/vantage-peers/pull/875#issuecomment-4753478609
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-19
 */

import type { ConvexHttpClient } from "convex/browser";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setInternalClientForTest, bearerAuthMiddleware } from "../src/auth.js";

const SIGMA_CLOUD_URL = "vantage-peers-production.up.railway.app";

function buildEmptyConvex(): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue(null),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

describe("bearerAuthMiddleware publicBaseUrl derive-from-request (#875)", () => {
	beforeEach(() => {
		vi.stubEnv("CONVEX_URL_INTERNAL", "https://example.convex.cloud");
		vi.stubEnv("BEARER_SECRET_MASTER", "test-master-not-used-here");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		_setInternalClientForTest(null);
	});

	it("derives publicBaseUrl from Host + x-forwarded-proto (NOT hardcoded Sigma URL)", async () => {
		_setInternalClientForTest(buildEmptyConvex());

		const app = new Hono();
		app.use("*", bearerAuthMiddleware());
		app.get("/protected", (c) => c.json({ ok: true }));

		const res = await app.request("/protected", {
			headers: {
				host: "selfhost.example.com",
				"x-forwarded-proto": "https",
			},
		});
		expect(res.status).toBe(401);
		const header = res.headers.get("WWW-Authenticate");
		expect(header).toContain(
			'resource_metadata="https://selfhost.example.com/.well-known/oauth-protected-resource"',
		);
		// CRITICAL: must NOT leak Sigma's Cloud URL.
		expect(header).not.toContain(SIGMA_CLOUD_URL);
	});

	it("emits the request Host (not Sigma URL) even when PUBLIC_BASE_URL points to a different tenant", async () => {
		// Env says one thing, request Host says another — request wins per RFC 8414 §2.
		vi.stubEnv("PUBLIC_BASE_URL", "https://other-tenant.example.org");
		_setInternalClientForTest(buildEmptyConvex());

		const app = new Hono();
		app.use("*", bearerAuthMiddleware());
		app.get("/protected", (c) => c.json({ ok: true }));

		const res = await app.request("/protected", {
			headers: {
				host: "cedric-selfhost.io",
				"x-forwarded-proto": "https",
			},
		});
		expect(res.status).toBe(401);
		const header = res.headers.get("WWW-Authenticate");
		expect(header).toContain("cedric-selfhost.io");
		expect(header).not.toContain(SIGMA_CLOUD_URL);
		expect(header).not.toContain("other-tenant.example.org");
	});

	it("never emits Sigma Cloud URL for any tenant Host", async () => {
		_setInternalClientForTest(buildEmptyConvex());

		const tenants = [
			"customer-a.example.com",
			"customer-b.io",
			"localhost:3000",
			"127.0.0.1:8080",
		];

		const app = new Hono();
		app.use("*", bearerAuthMiddleware());
		app.get("/protected", (c) => c.json({ ok: true }));

		for (const host of tenants) {
			const res = await app.request("/protected", { headers: { host } });
			expect(res.status).toBe(401);
			const header = res.headers.get("WWW-Authenticate");
			expect(header, `host=${host}`).not.toContain(SIGMA_CLOUD_URL);
		}
	});
});
