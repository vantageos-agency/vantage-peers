/**
 * Audit R3 reproduction: oauth:getRefreshTokenByHash / refresh grant rotation.
 * Provenance: static audit of VantagePeers main @16f0907, row oauth:getRefreshTokenByHash
 * in defects-R3.jsonl; harness shape from mcp-server/test/seat-token-renewal.test.ts.
 *
 * Identity: the MCP server's own service-account client (faked in memory) plus a
 * confidential client presenting its client secret. The fake mirrors the Convex
 * contract (revoked/expired -> null) and ACCEPTS any refresh-token consume/revoke
 * mutation a fix might add, so a correct fix can turn this green.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../server-http.js";
import { _setInternalClientForTest, sha256Hex } from "../../src/auth.js";

const CLIENT_ID = "audit-client";
const SECRET = "audit-client-secret-raw";
const PROFILE = "audit-profile";
const REFRESH_RAW = "audit-refresh-raw-0001";

const refreshByHash = new Map<string, { revokedAt?: number; expiresAt: number }>();
let clientSecretHash = "";

beforeEach(async () => {
	refreshByHash.clear();
	clientSecretHash = await sha256Hex(SECRET);
	refreshByHash.set(await sha256Hex(REFRESH_RAW), {
		expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
	});
	_setInternalClientForTest({
		query: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:getClientByClientId") {
				return {
					clientId: CLIENT_ID,
					clientSecretHash,
					redirectUris: ["https://localhost/x"],
					name: PROFILE,
					scopeProfile: PROFILE,
					tokenEndpointAuthMethod: "client_secret_basic",
				};
			}
			if (name === "oauth:getScopeProfile") {
				return {
					profileId: PROFILE,
					description: "d",
					fromAllowList: ["a"],
					namespaceReadPrefixes: ["ns/"],
					namespaceWritePrefixes: ["ns/"],
				};
			}
			if (name === "oauth:getRefreshTokenByHash") {
				const row = refreshByHash.get(args.tokenHash as string);
				if (!row || row.revokedAt !== undefined || row.expiresAt < Date.now()) return null;
				return { clientId: CLIENT_ID, userId: "a", scopeProfile: PROFILE, expiresAt: row.expiresAt };
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:createRefreshToken") {
				refreshByHash.set(args.tokenHash as string, { expiresAt: args.expiresAt as number });
				return "id";
			}
			if (name === "oauth:createAccessToken") return "id";
			// any rotation door a fix adds: consume / revoke of a refresh token
			if (/efresh/.test(name) && /(consume|revoke|use)/i.test(name)) {
				const h = (args.tokenHash ?? args.hash) as string | undefined;
				const row = h ? refreshByHash.get(h) : undefined;
				if (row) row.revokedAt = Date.now();
				return row ? { clientId: CLIENT_ID, userId: "a", scopeProfile: PROFILE, expiresAt: row.expiresAt } : null;
			}
			throw new Error(`unmocked mutation: ${name}`);
		},
		// biome-ignore lint/suspicious/noExplicitAny: test fake
	} as any);
});

async function refresh(raw: string) {
	const res = await app.request("http://localhost/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: `Basic ${btoa(`${CLIENT_ID}:${SECRET}`)}`,
		},
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: raw }).toString(),
	});
	return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("oauth:getRefreshTokenByHash / refresh grant", () => {
	it("oauth:getRefreshTokenByHash — a refresh token presented once is refused on replay (invalid_grant)", async () => {
		const first = await refresh(REFRESH_RAW);
		expect(first.status).toBe(200); // positive control: first use is served
		const replay = await refresh(REFRESH_RAW);
		expect(replay.status, `replay status (error=${String(replay.body.error)})`).toBe(400);
		expect(replay.body.error).toBe("invalid_grant");
	});
});
