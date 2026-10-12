/**
 * Audit R3 reproduction: oauth:getRefreshTokenByHash / refresh grant rotation.
 * Provenance: static audit of VantagePeers main @16f0907, row oauth:getRefreshTokenByHash
 * in defects-R3.jsonl; harness shape from mcp-server/test/seat-token-renewal.test.ts.
 *
 * Identity: the MCP server's own service-account client (faked in memory) plus a
 * confidential client presenting its client secret. The fake mirrors the Convex
 * doors the grant calls (test/lib/refreshRotationFake.ts): the replay of a spent
 * token is refused AND its family is revoked, so the pair the first redeemer
 * was given is dead.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../server-http.js";
import { _setInternalClientForTest, sha256Hex } from "../../src/auth.js";
import {
	type RotationStore,
	fakeGetRefreshTokenForGrant,
	fakeRotateRefreshToken,
} from "../lib/refreshRotationFake.js";

const CLIENT_ID = "audit-client";
const SECRET = "audit-client-secret-raw";
const PROFILE = "audit-profile";
const REFRESH_RAW = "audit-refresh-raw-0001";

const store: RotationStore = { refresh: new Map(), access: [] };
const mutationsCalled: string[] = [];
let clientSecretHash = "";

beforeEach(async () => {
	store.refresh.clear();
	store.access.length = 0;
	mutationsCalled.length = 0;
	clientSecretHash = await sha256Hex(SECRET);
	store.refresh.set(await sha256Hex(REFRESH_RAW), {
		clientId: CLIENT_ID,
		userId: "a",
		scopeProfile: PROFILE,
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
			if (name === "oauth:getRefreshTokenForGrant") {
				return fakeGetRefreshTokenForGrant(store, args);
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			mutationsCalled.push(name);
			if (name === "oauth:rotateRefreshToken") {
				return fakeRotateRefreshToken(store, args);
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

const liveRefresh = async (raw: string) => {
	const row = store.refresh.get(await sha256Hex(raw));
	return row !== undefined && row.revokedAt === undefined;
};

describe("oauth refresh grant", () => {
	it("a refresh token presented once is refused on replay (invalid_grant)", async () => {
		const first = await refresh(REFRESH_RAW);
		expect(first.status).toBe(200); // positive control: first use is served
		const replay = await refresh(REFRESH_RAW);
		expect(replay.status, `replay status (error=${String(replay.body.error)})`).toBe(400);
		expect(replay.body.error).toBe("invalid_grant");
	});

	it("attacker redeems first, victim replays: the attacker's pair is invalid and the family is revoked", async () => {
		// The attacker redeems the stolen token first and holds the new pair.
		const attacker = await refresh(REFRESH_RAW);
		expect(attacker.status).toBe(200);
		const attackerRefresh = String(attacker.body.refresh_token);
		const attackerAccessHash = await sha256Hex(String(attacker.body.access_token));
		expect(await liveRefresh(attackerRefresh)).toBe(true);
		// The victim presents the same, now spent, token.
		const victim = await refresh(REFRESH_RAW);
		expect(victim.status).toBe(400);
		expect(victim.body.error).toBe("invalid_grant");
		// The attacker's refresh token is dead and so is his access token.
		expect(await liveRefresh(attackerRefresh)).toBe(false);
		const access = store.access.find((a) => a.tokenHash === attackerAccessHash);
		expect(access?.revokedAt).toBeDefined();
		const again = await refresh(attackerRefresh);
		expect(again.status).toBe(400);
	});

	it("the grant spends the token and mints the pair in ONE Convex mutation", async () => {
		const r = await refresh(REFRESH_RAW);
		expect(r.status).toBe(200);
		expect(mutationsCalled).toEqual(["oauth:rotateRefreshToken"]);
	});
});
