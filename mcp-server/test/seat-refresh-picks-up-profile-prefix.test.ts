/**
 * MEASUREMENT (task k1701vj2gxbacdjqr1avpxx7en8hdw2q, Pi ruling (c) on #1652, consequence 1):
 * does an EXISTING seat pick up a new scope-profile prefix at refresh, or must it be re-minted?
 *
 * server-http.ts's refresh_token grant loads the LIVE profile
 * (`loadScopeProfile(record.scopeProfile)` -> `oauth:getScopeProfile`) and hands ITS prefix lists to
 * `oauth:rotateRefreshToken`, which stores them on the new access token. So the answer is read
 * from what the grant passes to the rotation, with the profile changed between mint and refresh.
 *
 * Same harness as seat-token-renewal.test.ts: the real Hono app in memory + a fake Convex client
 * that records the arguments of the rotation.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../server-http.js";
import { _setInternalClientForTest, sha256Hex } from "../src/auth.js";

type Profile = {
	profileId: string;
	description: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
	clerkOrgSlug: string;
};

const SECRET = "seat-refresh-secret-001";
const CLIENT = "seat-client-refresh";
const PROFILE = "neo-refresh-org";
const REFRESH = "seat-refresh-raw-token-001";
const AGENT_ID = "agentsrowidneo000000000000000001";

let profile: Profile;
let rotations: Array<Record<string, unknown>>;

function fakeConvex() {
	const spent = new Set<string>();
	return {
		query: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:getClientByClientId") {
				return {
					clientId: CLIENT,
					clientSecretHash: await sha256Hex(SECRET),
					redirectUris: ["https://localhost/dev-null"],
					name: PROFILE,
					scopeProfile: PROFILE,
					tokenEndpointAuthMethod: "client_secret_basic",
				};
			}
			if (name === "oauth:getScopeProfile") {
				return args.profileId === PROFILE ? profile : null;
			}
			if (name === "oauth:getRefreshTokenForGrant") {
				if (args.presentedHash !== (await sha256Hex(REFRESH))) return null;
				return {
					clientId: CLIENT,
					userId: "neo",
					scopeProfile: PROFILE,
					expiresAt: Date.now() + 3_600_000,
					spent: spent.has(String(args.presentedHash)),
				};
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:rotateRefreshToken") {
				rotations.push(args);
				spent.add(String(args.presentedHash));
				return {
					status: "ok",
					issued: { refresh: randomBytes(32).toString("hex"), access: randomBytes(32).toString("hex") },
				};
			}
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
}

async function refresh(): Promise<number> {
	const res = await app.request("http://localhost/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: `Basic ${btoa(`${CLIENT}:${SECRET}`)}`,
		},
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH }).toString(),
	});
	return res.status;
}

beforeEach(() => {
	rotations = [];
	// biome-ignore lint/suspicious/noExplicitAny: test fake
	_setInternalClientForTest(fakeConvex() as any);
	profile = {
		profileId: PROFILE,
		description: "seat neo",
		fromAllowList: ["neo"],
		namespaceReadPrefixes: ["orchestrator/neo", "project/refresh-org"],
		namespaceWritePrefixes: ["orchestrator/neo", "project/refresh-org"],
		clerkOrgSlug: "refresh-org",
	};
});

describe("a refresh mints the token from the LIVE profile", () => {
	it("a prefix added to the profile after the seat was minted is on the refreshed token", async () => {
		// the operator runs scripts/seat-profile-agent-namespace.mjs --apply
		profile = {
			...profile,
			namespaceReadPrefixes: [...profile.namespaceReadPrefixes, `orchestrator/${AGENT_ID}`],
			namespaceWritePrefixes: [...profile.namespaceWritePrefixes, `orchestrator/${AGENT_ID}`],
		};
		expect(await refresh()).toBe(200);
		expect(rotations).toHaveLength(1);
		expect(rotations[0].namespaceReadPrefixes).toContain(`orchestrator/${AGENT_ID}`);
		expect(rotations[0].namespaceWritePrefixes).toContain(`orchestrator/${AGENT_ID}`);
		expect(rotations[0].scopeProfile).toBe(PROFILE);
	});

	it("the converse: a refresh DROPS a prefix the token had but the profile does not list", async () => {
		// a token minted by provision-client-org-agents.mjs carried orchestrator/<agentId> directly;
		// if the profile was never updated, its next refresh loses it. Update the profile first.
		expect(await refresh()).toBe(200);
		expect(rotations[0].namespaceWritePrefixes).not.toContain(`orchestrator/${AGENT_ID}`);
	});
});
