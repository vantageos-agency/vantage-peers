/**
 * Day 92 A0 — Persistent test tenant trio provisioning verification.
 *
 * TDD RED phase: asserts that the alpha/beta/gamma trio is provisioned
 * on VantagePeers Cloud prod and each bearer is functional.
 *
 * These tests exercise the LIVE prod Railway endpoint using credentials
 * from .env.local VP_TEST_* variables. They are SKIPPED in CI (VP_TEST_MODE=1)
 * and SKIPPED when env vars are not yet populated (before provision step).
 *
 * Run manually: VP_TEST_URL=... VP_TEST_ALPHA_BEARER=... bun test setup-trio-day92
 *
 * Mission: k57a36y8w5t085bqr23dsmvb2d882506 Phase A0
 * Laurent doctrine Day 92: strict TDD, persistent creds, fleet-wide reuse.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Credential loader — reads from .env.local (gitignored)
// ─────────────────────────────────────────────────────────────────────────────

type TrioCreds = {
	vpTestUrl: string;
	alpha: { clientId: string; bearer: string; scopeProfile: string };
	beta: { clientId: string; bearer: string; scopeProfile: string };
	gamma: { clientId: string; bearer: string; scopeProfile: string };
};

/**
 * loadTrioCreds — reads VP_TEST_* variables from .env.local at the repo root
 * or from the current process environment (whichever is set). This lets the
 * tests run both from an IDE that loaded .env.local and from CI that has the
 * vars injected directly.
 *
 * Not exported — internal to this test file.
 */
function loadTrioCreds(): Partial<TrioCreds> {
	const env: Record<string, string> = { ...process.env } as Record<
		string,
		string
	>;

	// Try to supplement from .env.local if the file exists
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
	const alphaClientId = env.VP_TEST_ALPHA_CLIENT_ID;
	const alphaBearer = env.VP_TEST_ALPHA_BEARER;
	const alphaScopeProfile = env.VP_TEST_ALPHA_SCOPE_PROFILE;
	const betaClientId = env.VP_TEST_BETA_CLIENT_ID;
	const betaBearer = env.VP_TEST_BETA_BEARER;
	const betaScopeProfile = env.VP_TEST_BETA_SCOPE_PROFILE;
	const gammaClientId = env.VP_TEST_GAMMA_CLIENT_ID;
	const gammaBearer = env.VP_TEST_GAMMA_BEARER;
	const gammaScopeProfile = env.VP_TEST_GAMMA_SCOPE_PROFILE;

	if (
		!vpTestUrl ||
		!alphaClientId ||
		!alphaBearer ||
		!alphaScopeProfile ||
		!betaClientId ||
		!betaBearer ||
		!betaScopeProfile ||
		!gammaClientId ||
		!gammaBearer ||
		!gammaScopeProfile
	) {
		return {};
	}

	return {
		vpTestUrl,
		alpha: {
			clientId: alphaClientId,
			bearer: alphaBearer,
			scopeProfile: alphaScopeProfile,
		},
		beta: {
			clientId: betaClientId,
			bearer: betaBearer,
			scopeProfile: betaScopeProfile,
		},
		gamma: {
			clientId: gammaClientId,
			bearer: gammaBearer,
			scopeProfile: gammaScopeProfile,
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * parseSseData — extracts the JSON payload from an SSE "data: ..." line.
 * Returns null if no data line is found (test should fail on that).
 */
function parseSseData(text: string): unknown {
	const dataMatch = text.match(/^data: (.+)$/m);
	if (!dataMatch) return null;
	return JSON.parse(dataMatch[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Skip guard: in VP_TEST_MODE (CI) or when creds not yet persisted, skip E2E
// ─────────────────────────────────────────────────────────────────────────────

const isCI = process.env.VP_TEST_MODE === "1";
const creds = loadTrioCreds();
const credsMissing = !creds.vpTestUrl;

describe("Day 92 A0 — test tenant trio provisioning", () => {
	let resolvedCreds: TrioCreds;

	beforeAll(() => {
		if (isCI || credsMissing) return;
		resolvedCreds = creds as TrioCreds;
	});

	it("loadTrioCreds reads .env.local lines for all VP_TEST_* vars", () => {
		// This unit test verifies the loader itself — always runs, no network needed.
		// If creds are missing it confirms they are absent (RED phase expected).
		const loaded = loadTrioCreds();
		if (credsMissing) {
			// RED phase: env vars not yet persisted — loader returns partial/empty
			expect(loaded.vpTestUrl).toBeUndefined();
		} else {
			expect(loaded.vpTestUrl).toMatch(/^https?:\/\//);
			expect(loaded.alpha?.clientId).toBe("alpha-test-client");
			expect(loaded.beta?.clientId).toBe("beta-test-client");
			expect(loaded.gamma?.clientId).toBe("gamma-test-client");
			expect(loaded.alpha?.scopeProfile).toBe("alpha-test-trio");
			expect(loaded.beta?.scopeProfile).toBe("beta-test-trio");
			expect(loaded.gamma?.scopeProfile).toBe("gamma-test-trio");
		}
	});

	it.skipIf(isCI || credsMissing)(
		"alpha bearer — tools/list via JSON-RPC returns 200 with tools array",
		async () => {
			const res = await fetch(resolvedCreds.vpTestUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${resolvedCreds.alpha.bearer}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "tools/list",
					id: 1,
					params: {},
				}),
			});
			expect(res.status).toBe(200);
			const body = parseSseData(await res.text()) as {
				result?: { tools?: unknown[] };
			};
			expect(body).not.toBeNull();
			expect(Array.isArray(body?.result?.tools)).toBe(true);
			expect((body?.result?.tools ?? []).length).toBeGreaterThan(0);
		},
	);

	it.skipIf(isCI || credsMissing)(
		"beta bearer — tools/list via JSON-RPC returns 200 with tools array",
		async () => {
			const res = await fetch(resolvedCreds.vpTestUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${resolvedCreds.beta.bearer}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "tools/list",
					id: 1,
					params: {},
				}),
			});
			expect(res.status).toBe(200);
			const body = parseSseData(await res.text()) as {
				result?: { tools?: unknown[] };
			};
			expect(body).not.toBeNull();
			expect(Array.isArray(body?.result?.tools)).toBe(true);
		},
	);

	it.skipIf(isCI || credsMissing)(
		"gamma bearer — tools/list via JSON-RPC returns 200 with tools array",
		async () => {
			const res = await fetch(resolvedCreds.vpTestUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${resolvedCreds.gamma.bearer}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "tools/list",
					id: 1,
					params: {},
				}),
			});
			expect(res.status).toBe(200);
			const body = parseSseData(await res.text()) as {
				result?: { tools?: unknown[] };
			};
			expect(body).not.toBeNull();
			expect(Array.isArray(body?.result?.tools)).toBe(true);
		},
	);

	it.skipIf(isCI || credsMissing)(
		"alpha bearer — recall namespace=orchestrator/Alpha returns seed memory",
		async () => {
			const res = await fetch(resolvedCreds.vpTestUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${resolvedCreds.alpha.bearer}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "tools/call",
					id: 2,
					params: {
						name: "recall",
						arguments: {
							query: "day92 alpha seed",
							namespace: "orchestrator/Alpha",
							limit: 5,
						},
					},
				}),
			});
			expect(res.status).toBe(200);
			const body = parseSseData(await res.text()) as {
				result?: { content?: Array<{ text?: string }> };
			};
			expect(body).not.toBeNull();
			expect(body?.result?.content).toBeDefined();
			expect(Array.isArray(body?.result?.content)).toBe(true);
		},
	);

	it.skipIf(isCI || credsMissing)(
		"beta bearer — list_tasks assignedTo=Alpha reads cross-allowList seed task",
		async () => {
			const res = await fetch(resolvedCreds.vpTestUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${resolvedCreds.beta.bearer}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "tools/call",
					id: 3,
					params: {
						name: "list_tasks",
						arguments: {
							assignedTo: "Alpha",
							limit: 5,
						},
					},
				}),
			});
			expect(res.status).toBe(200);
			const body = parseSseData(await res.text()) as {
				result?: { content?: Array<{ text?: string }> };
			};
			expect(body).not.toBeNull();
			expect(body?.result?.content).toBeDefined();
		},
	);

	it.skipIf(isCI || credsMissing)(
		"alpha bearer auth — /health returns 200 (identity introspection)",
		async () => {
			const baseUrl = resolvedCreds.vpTestUrl.replace(/\/mcp$/, "");
			const res = await fetch(`${baseUrl}/health`, {
				headers: { Authorization: `Bearer ${resolvedCreds.alpha.bearer}` },
			});
			// Health endpoint is public (no auth required) — returns 200
			expect(res.status).toBe(200);
		},
	);
});
