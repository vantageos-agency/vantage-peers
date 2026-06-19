/**
 * S4.1 — Cross-tenant isolation E2E suite (Sigma scope: VP MCP tools).
 *
 * 5 template specs implemented (S41-001..S41-005). Sigma main thread copies
 * these as templates for S41-006..S41-040 (35 more). Theta implements
 * S41-041..S41-060 in the VCRM repo using the same pattern.
 *
 * Full scenario matrix: decisions/s41-cross-tenant-playwright-plan.md §5.
 *
 * Skip gate: requires VP_MCP_PROD_URL + VP_TEST_TOKEN_ALPHA/BETA/GAMMA.
 * Absent any → whole suite skips with 0 false-positives.
 *
 * NB framework: Vitest, not Playwright. The SUT is JSON-RPC over HTTP — no
 * browser. See plan §1 for trade-off rationale.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	callTool,
	initSession,
	resetSession,
} from "./fixtures/dummy-entity.js";
import {
	hasAllTenantCreds,
	resolveTenantEnv,
	seedTenant,
	TENANTS,
	teardownTenant,
} from "./fixtures/tenant-seed.js";

const SKIP = !hasAllTenantCreds();
const itc = SKIP ? it.skip : it;

if (SKIP) {
	console.warn(
		"[s41-cross-tenant] Missing one of VP_MCP_PROD_URL, VP_TEST_TOKEN_ALPHA, " +
			"VP_TEST_TOKEN_BETA, VP_TEST_TOKEN_GAMMA — skipping cross-tenant suite. " +
			"Set all four to run.",
	);
}

describe("S4.1 — cross-tenant isolation (VP MCP)", () => {
	const envAlpha = resolveTenantEnv("alpha");
	const envBeta = resolveTenantEnv("beta");
	const envGamma = resolveTenantEnv("gamma");

	beforeAll(async () => {
		if (SKIP || !envAlpha || !envBeta || !envGamma) return;
		resetSession();
		await seedTenant(envAlpha, TENANTS.alpha);
		resetSession();
		await seedTenant(envBeta, TENANTS.beta);
		resetSession();
		await seedTenant(envGamma, TENANTS.gamma);
		resetSession();
	}, 120_000);

	afterAll(async () => {
		if (SKIP || !envAlpha || !envBeta || !envGamma) return;
		resetSession();
		await teardownTenant(envAlpha, TENANTS.alpha);
		resetSession();
		await teardownTenant(envBeta, TENANTS.beta);
		resetSession();
		await teardownTenant(envGamma, TENANTS.gamma);
	}, 120_000);

	// ───────────────────────────────────────────────────────────────────────
	// S41-001 — recall positive: alpha sees its own roadmap memories.
	// ───────────────────────────────────────────────────────────────────────
	itc("S41-001 recall positive — alpha sees own roadmap data", async () => {
		const env = envAlpha;
		if (!env) return;
		const sessionId = await initSession(env);
		const res = (await callTool(env, sessionId, "recall", {
			query: "alpha Q1 roadmap signed off",
			namespace: "test-alpha-project-roadmap",
			limit: 5,
		})) as { content?: Array<{ text?: string }> };
		const text = res?.content?.[0]?.text ?? "";
		expect(text).toContain("alpha Q1 roadmap");
	});

	// ───────────────────────────────────────────────────────────────────────
	// S41-002 — recall negative: alpha CANNOT see beta data.
	// CRITICAL LEAK CHECK. If this test ever passes-with-beta-content → P0.
	// ───────────────────────────────────────────────────────────────────────
	itc(
		"S41-002 recall negative — alpha cannot leak beta roadmap data",
		async () => {
			const env = envAlpha;
			if (!env) return;
			const sessionId = await initSession(env);
			// Query for beta's unique string while authenticated as alpha.
			const res = (await callTool(env, sessionId, "recall", {
				query: "beta Q1 roadmap signed off",
				// Even attempt to target beta's namespace — must yield nothing.
				namespace: "test-beta-project-roadmap",
				limit: 10,
			})) as { content?: Array<{ text?: string }> };
			const text = res?.content?.[0]?.text ?? "";
			expect(text).not.toContain("beta Q1 roadmap signed off");
			expect(text).not.toContain("beta sprint 12 retro");
			expect(text).not.toContain("test-beta-tenant");
		},
	);

	// ───────────────────────────────────────────────────────────────────────
	// S41-009 — list_tasks positive: gamma sees its own 3 tasks.
	// (Renumbered for template clarity; in matrix this is S41-009.)
	// ───────────────────────────────────────────────────────────────────────
	itc("S41-003 list_tasks tenant filter — gamma sees own 3 tasks", async () => {
		const env = envGamma;
		if (!env) return;
		const sessionId = await initSession(env);
		const res = (await callTool(env, sessionId, "list_tasks", {
			limit: 50,
		})) as { content?: Array<{ text?: string }> };
		const text = res?.content?.[0]?.text ?? "";
		// gamma sees its own tasks
		expect(text).toContain("gamma task A1");
		// gamma does NOT see alpha/beta tasks
		expect(text).not.toContain("alpha task A1");
		expect(text).not.toContain("beta task A1");
	});

	// ───────────────────────────────────────────────────────────────────────
	// S41-022 — send_message cross-tenant REJECT.
	// alpha attempts to send a message into beta's channel. Must reject.
	// ───────────────────────────────────────────────────────────────────────
	itc(
		"S41-004 send_message cross-tenant reject — alpha→beta channel blocked",
		async () => {
			const env = envAlpha;
			if (!env) return;
			const sessionId = await initSession(env);
			// Build a payload that targets a beta-owned channel/recipient.
			const attempt = callTool(env, sessionId, "send_message", {
				channel: "test-beta-s41-attack",
				from: "sigma",
				to: "theta",
				content: "S41 leak probe — must NOT be delivered",
				tenantId: "test-beta-tenant", // overt cross-tenant attempt
			});
			// Two acceptable outcomes:
			//   (a) MCP returns an error (tool throws) — preferred.
			//   (b) MCP silently rewrites to alpha's tenant (still safe, but log).
			let leaked = false;
			try {
				const res = (await attempt) as { content?: Array<{ text?: string }> };
				const text = res?.content?.[0]?.text ?? "";
				// If we succeeded, the resulting message MUST be in alpha's tenant,
				// never beta's. Verify by checking beta cannot see it.
				if (env && envBeta) {
					resetSession();
					const betaSession = await initSession(envBeta);
					const betaInbox = (await callTool(
						envBeta,
						betaSession,
						"check_messages",
						{ channel: "test-beta-s41-attack", limit: 10 },
					)) as { content?: Array<{ text?: string }> };
					const betaText = betaInbox?.content?.[0]?.text ?? "";
					if (betaText.includes("S41 leak probe")) leaked = true;
				}
				// res existed, no throw — that's fine if no leak.
				expect(text).toBeDefined();
			} catch {
				// Throw = clean reject. Acceptable.
			}
			expect(leaked).toBe(false);
		},
	);

	// ───────────────────────────────────────────────────────────────────────
	// S41-030 — hybrid_search cross-tenant isolation.
	// alpha queries a uniquely-beta phrase. Must return zero beta hits.
	// ───────────────────────────────────────────────────────────────────────
	itc(
		"S41-005 hybrid_search cross-tenant isolation — alpha cannot match beta corpus",
		async () => {
			const env = envAlpha;
			if (!env) return;
			const sessionId = await initSession(env);
			const res = (await callTool(env, sessionId, "hybrid_search", {
				query: "beta customer BETA-001 reported login bug",
				limit: 10,
			})) as { content?: Array<{ text?: string }> };
			const text = res?.content?.[0]?.text ?? "";
			expect(text).not.toContain("BETA-001");
			expect(text).not.toContain("beta customer");
			expect(text).not.toContain("test-beta-tenant");
		},
	);
});
