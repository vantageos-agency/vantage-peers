/**
 * Day 92 A3 — whoami tool E2E + unit test suite.
 *
 * TDD RED phase: written BEFORE the tool exists in tools.ts.
 * Unit tests fail because the whoami handler returns nothing (tool not yet
 * registered). E2E tests are skipped in CI and when creds are absent.
 *
 * Two test layers:
 *   1. Unit — duck-typed McpServer mock + synthetic oauthCtx (no network).
 *      Verifies the tool returns the correct shape from the bearer's scope ctx.
 *   2. E2E — live prod Railway endpoint using trio creds from .env.local.
 *      Skipped in CI (VP_TEST_MODE=1) and when creds are absent.
 *
 * Customer friction: Marie Day 92 Iris RH skill had to ASK the user for
 * orchestrator_id because there was no programmatic way to discover it from
 * the bearer. whoami closes that loop.
 *
 * Mission: k57a36y8w5t085bqr23dsmvb2d882506 Phase A3
 * Task: k175dkbyq783ttgwjrpxmk7y2x8838qa
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Credential loader — mirrors setup-trio-day92.test.ts (A0 commit 2a6a7d4)
// ─────────────────────────────────────────────────────────────────────────────

type TrioCreds = {
	vpTestUrl: string;
	masterBearer: string;
	alpha: { bearer: string; scopeProfile: string };
	beta: { bearer: string; scopeProfile: string };
	gamma: { bearer: string; scopeProfile: string };
};

function loadEnvCreds(): Partial<TrioCreds> {
	const env: Record<string, string> = { ...process.env } as Record<
		string,
		string
	>;

	const envLocalPath = path.resolve(__dirname, "../../.env.local");
	if (fs.existsSync(envLocalPath)) {
		const contents = fs.readFileSync(envLocalPath, "utf-8");
		for (const line of contents.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIdx = trimmed.indexOf("=");
			if (eqIdx < 0) continue;
			const key = trimmed.slice(0, eqIdx).trim();
			const val = trimmed.slice(eqIdx + 1).trim();
			if (key && val && !env[key]) {
				env[key] = val;
			}
		}
	}

	const vpTestUrl = env.VP_TEST_URL;
	const masterBearer =
		env.BEARER_SECRET_MASTER ?? env.VP_TEST_MASTER_BEARER ?? "";
	const alphaBearer = env.VP_TEST_ALPHA_BEARER;
	const alphaScopeProfile = env.VP_TEST_ALPHA_SCOPE_PROFILE;
	const betaBearer = env.VP_TEST_BETA_BEARER;
	const betaScopeProfile = env.VP_TEST_BETA_SCOPE_PROFILE;
	const gammaBearer = env.VP_TEST_GAMMA_BEARER;
	const gammaScopeProfile = env.VP_TEST_GAMMA_SCOPE_PROFILE;

	if (
		!vpTestUrl ||
		!alphaBearer ||
		!alphaScopeProfile ||
		!betaBearer ||
		!betaScopeProfile ||
		!gammaBearer ||
		!gammaScopeProfile
	) {
		return {};
	}

	return {
		vpTestUrl,
		masterBearer,
		alpha: { bearer: alphaBearer, scopeProfile: alphaScopeProfile },
		beta: { bearer: betaBearer, scopeProfile: betaScopeProfile },
		gamma: { bearer: gammaBearer, scopeProfile: gammaScopeProfile },
	};
}

function parseSseData(text: string): unknown {
	const dataMatch = text.match(/^data: (.+)$/m);
	if (!dataMatch) return null;
	return JSON.parse(dataMatch[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Skip guards
// ─────────────────────────────────────────────────────────────────────────────

const isCI = process.env.VP_TEST_MODE === "1";
const creds = loadEnvCreds();
const credsMissing = !creds.vpTestUrl;

// ─────────────────────────────────────────────────────────────────────────────
// Duck-typed McpServer mock — mirrors scope-aware-filter-wave-c1.test.ts
// ─────────────────────────────────────────────────────────────────────────────

type CapturedTool = {
	name: string;
	handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function captureTools(oauthCtx?: OAuthContext): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const mockServer = {
		tool: (
			name: string,
			_description: string,
			_schema: Record<string, unknown>,
			_annotations: Record<string, unknown>,
			handler: (args: Record<string, unknown>) => Promise<unknown>,
		) => {
			tools.set(name, { name, handler });
		},
	} as Parameters<typeof registerTools>[0];

	// whoami never calls Convex — stub is sufficient
	const mockConvex = {
		query: async () => null,
		mutation: async () => null,
		action: async () => null,
	} as Parameters<typeof registerTools>[1];

	registerTools(mockServer, mockConvex, oauthCtx);
	return tools;
}

type WhoamiResult = {
	scope_profile_name: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
	suggested_orchestrator_id: string | null;
};

async function callWhoami(
	oauthCtx?: OAuthContext,
): Promise<WhoamiResult | null> {
	const tools = captureTools(oauthCtx);
	const tool = tools.get("whoami");
	if (!tool) return null; // RED phase: tool not yet registered
	const res = (await tool.handler({})) as {
		content?: Array<{ text?: string }>;
	} | null;
	const text = res?.content?.[0]?.text;
	if (!text) return null;
	return JSON.parse(text) as WhoamiResult;
}

function buildOauthCtx(overrides: Partial<OAuthContext>): OAuthContext {
	return {
		clientId: "test-client",
		userId: "test-user",
		scopes: ["vantage:read"],
		scopeProfile: "test-profile",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		...overrides,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — synthetic oauthCtx, no network required
// ─────────────────────────────────────────────────────────────────────────────

describe("whoami — unit (no network)", () => {
	it("alpha-like scope — returns scope_profile_name and suggested_orchestrator_id from fromAllowList[0]", async () => {
		const oauthCtx = buildOauthCtx({
			scopeProfile: "alpha-test-trio",
			fromAllowList: ["Alpha", "alpha", "Beta", "beta", "Gamma", "gamma"],
			namespaceReadPrefixes: ["orchestrator/Alpha", "orchestrator/Beta"],
			namespaceWritePrefixes: ["orchestrator/Alpha"],
			userId: "alpha-user-id",
		});

		const result = await callWhoami(oauthCtx);
		expect(result).not.toBeNull();
		expect(result?.scope_profile_name).toBe("alpha-test-trio");
		expect(result?.suggested_orchestrator_id).toBe("Alpha");
		expect(result?.fromAllowList).toEqual(
			expect.arrayContaining(["Alpha", "alpha", "Beta", "beta", "Gamma", "gamma"]),
		);
		expect(result?.namespaceReadPrefixes).toContain("orchestrator/Alpha");
		expect(result?.namespaceWritePrefixes).toContain("orchestrator/Alpha");
	});

	it("beta-like scope — suggested_orchestrator_id='Beta'", async () => {
		const oauthCtx = buildOauthCtx({
			scopeProfile: "beta-test-trio",
			fromAllowList: ["Beta", "beta", "Alpha", "alpha"],
			namespaceReadPrefixes: ["orchestrator/Beta"],
			namespaceWritePrefixes: ["orchestrator/Beta"],
		});

		const result = await callWhoami(oauthCtx);
		expect(result).not.toBeNull();
		expect(result?.suggested_orchestrator_id).toBe("Beta");
	});

	it("gamma-like scope — suggested_orchestrator_id='Gamma'", async () => {
		const oauthCtx = buildOauthCtx({
			scopeProfile: "gamma-test-trio",
			fromAllowList: ["Gamma", "gamma"],
			namespaceReadPrefixes: ["orchestrator/Gamma"],
			namespaceWritePrefixes: ["orchestrator/Gamma"],
		});

		const result = await callWhoami(oauthCtx);
		expect(result).not.toBeNull();
		expect(result?.suggested_orchestrator_id).toBe("Gamma");
	});

	it("master scope — scope_profile_name='master', suggested_orchestrator_id='master'", async () => {
		const oauthCtx = buildOauthCtx({
			scopeProfile: "master",
			fromAllowList: ["*"],
			namespaceReadPrefixes: ["*"],
			namespaceWritePrefixes: ["*"],
			isMaster: true,
		});

		const result = await callWhoami(oauthCtx);
		expect(result).not.toBeNull();
		expect(result?.scope_profile_name).toBe("master");
		expect(result?.suggested_orchestrator_id).toBe("master");
		// Master exposes empty arrays — callers should not see wildcard internals
		expect(result?.fromAllowList).toEqual([]);
		expect(result?.namespaceReadPrefixes).toEqual([]);
		expect(result?.namespaceWritePrefixes).toEqual([]);
	});

	it("no oauthCtx (legacy bearer) — scope_profile_name='legacy', suggested_orchestrator_id=null", async () => {
		const result = await callWhoami(undefined);
		expect(result).not.toBeNull();
		expect(result?.scope_profile_name).toBe("legacy");
		expect(result?.suggested_orchestrator_id).toBeNull();
		expect(result?.fromAllowList).toEqual([]);
	});

	it("case preserved — suggested_orchestrator_id is NOT lowercased", async () => {
		const oauthCtx = buildOauthCtx({
			scopeProfile: "helios-profile",
			fromAllowList: ["Helios", "helios"],
		});

		const result = await callWhoami(oauthCtx);
		// Must be "Helios" not "helios"
		expect(result?.suggested_orchestrator_id).toBe("Helios");
	});

	it("empty fromAllowList on non-master — suggested_orchestrator_id=null", async () => {
		const oauthCtx = buildOauthCtx({
			scopeProfile: "client-generic",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
		});

		const result = await callWhoami(oauthCtx);
		expect(result).not.toBeNull();
		expect(result?.suggested_orchestrator_id).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E tests — live prod endpoint, skipped in CI + when creds absent
// ─────────────────────────────────────────────────────────────────────────────

describe("whoami — E2E (live prod)", () => {
	let resolvedCreds: TrioCreds;

	beforeAll(() => {
		if (isCI || credsMissing) return;
		resolvedCreds = creds as TrioCreds;
	});

	async function callWhoamiProd(bearer: string): Promise<{
		status: number;
		parsed: WhoamiResult | null;
	}> {
		const res = await fetch(resolvedCreds.vpTestUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${bearer}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "tools/call",
				id: 42,
				params: { name: "whoami", arguments: {} },
			}),
		});
		const rawText = await res.text();
		const body = parseSseData(rawText) as {
			result?: { content?: Array<{ text?: string }> };
		} | null;

		let parsed: WhoamiResult | null = null;
		try {
			const text = body?.result?.content?.[0]?.text;
			if (text) parsed = JSON.parse(text) as WhoamiResult;
		} catch {
			// leave null
		}

		return { status: res.status, parsed };
	}

	it.skipIf(isCI || credsMissing)(
		"alpha bearer — scope_profile_name='alpha-test-trio', suggested_orchestrator_id='Alpha'",
		async () => {
			const { status, parsed } = await callWhoamiProd(resolvedCreds.alpha.bearer);
			expect(status).toBe(200);
			expect(parsed).not.toBeNull();
			expect(parsed?.scope_profile_name).toBe("alpha-test-trio");
			expect(parsed?.suggested_orchestrator_id).toBe("Alpha");
			expect(parsed?.fromAllowList).toEqual(
				expect.arrayContaining(["Alpha", "alpha"]),
			);
			expect(parsed?.namespaceReadPrefixes).toEqual(
				expect.arrayContaining(["orchestrator/Alpha"]),
			);
		},
	);

	it.skipIf(isCI || credsMissing)(
		"beta bearer — suggested_orchestrator_id='Beta'",
		async () => {
			const { status, parsed } = await callWhoamiProd(resolvedCreds.beta.bearer);
			expect(status).toBe(200);
			expect(parsed?.suggested_orchestrator_id).toBe("Beta");
		},
	);

	it.skipIf(isCI || credsMissing)(
		"gamma bearer — suggested_orchestrator_id='Gamma'",
		async () => {
			const { status, parsed } = await callWhoamiProd(resolvedCreds.gamma.bearer);
			expect(status).toBe(200);
			expect(parsed?.suggested_orchestrator_id).toBe("Gamma");
		},
	);

	it.skipIf(isCI || credsMissing || !creds.masterBearer)(
		"master bearer — scope_profile_name='master', suggested_orchestrator_id='master'",
		async () => {
			const { status, parsed } = await callWhoamiProd(resolvedCreds.masterBearer);
			expect(status).toBe(200);
			expect(parsed?.scope_profile_name).toBe("master");
			expect(["master", null]).toContain(parsed?.suggested_orchestrator_id);
		},
	);

	it.skipIf(isCI || credsMissing)(
		"missing bearer — returns 401",
		async () => {
			const res = await fetch(resolvedCreds.vpTestUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "tools/call",
					id: 99,
					params: { name: "whoami", arguments: {} },
				}),
			});
			expect(res.status).toBe(401);
		},
	);

	it.skipIf(isCI || credsMissing)(
		"invalid bearer — returns 401",
		async () => {
			const res = await fetch(resolvedCreds.vpTestUrl, {
				method: "POST",
				headers: {
					Authorization: "Bearer invalid-token-xxxxxxxxxxxxxxxx",
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "tools/call",
					id: 99,
					params: { name: "whoami", arguments: {} },
				}),
			});
			expect(res.status).toBe(401);
		},
	);
});
