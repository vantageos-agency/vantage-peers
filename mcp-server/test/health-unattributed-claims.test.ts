/**
 * /health publishes the unattributed-claim aggregate; the per-client breakdown
 * lives behind the master-only /admin/actor-claims. Publication only: neither
 * the mode default nor checkActorBinding changes (controls 4 and 5).
 *
 * Counts are driven through the REAL recordUnattributedClaim and asserted
 * against the number this file recorded, never against a literal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../server-http.js";
import {
	_resetUnattributedClaimsForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	checkActorBinding,
	isUnattributedClaim,
	type OAuthContext,
	recordUnattributedClaim,
	unattributedClaimSummary,
} from "../src/auth.js";

const MASTER = "Bearer test-master-token"; // vitest.config.ts test.env

function orgCtx(clientId: string): OAuthContext {
	return {
		clientId,
		userId: `user-${clientId}`,
		scopes: ["vantage:read"],
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 60_000,
		isMaster: false,
	};
}

/** Drives the real recorder and returns how many calls it recorded. */
function drive(clientId: string, claimed: string, times: number): number {
	const ctx = orgCtx(clientId);
	for (let i = 0; i < times; i++) {
		expect(isUnattributedClaim(ctx, claimed)).toBe(true);
		recordUnattributedClaim(ctx, "some_tool", "orchestratorId", claimed);
	}
	return times;
}

// biome-ignore lint/suspicious/noExplicitAny: test reads an untyped JSON body
async function health(): Promise<Record<string, any>> {
	const res = await app.request("/health");
	expect(res.status).toBe(200);
	return JSON.parse(await res.text());
}

let saved: string | undefined;
beforeEach(() => {
	saved = process.env[ACTOR_CREDENTIAL_MODE_ENV];
	_resetUnattributedClaimsForTest();
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	if (saved === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	else process.env[ACTOR_CREDENTIAL_MODE_ENV] = saved;
	vi.restoreAllMocks();
});

describe("/health unattributed_claims", () => {
	it("1 nothing recorded: a published ZERO with its window, not an absent field", async () => {
		const body = await health();
		expect(body).toHaveProperty("unattributed_claims");
		const u = body.unattributed_claims;
		expect(u.strict_would_refuse).toBe(0);
		expect(typeof u.strict_would_refuse).toBe("number");
		expect(Number.isNaN(Date.parse(u.since))).toBe(false);
		expect(u.window_seconds).toBeGreaterThanOrEqual(0);
	});

	it("1b same zero over a short and a long window renders as different bytes", () => {
		const a = unattributedClaimSummary(new Date(Date.now() + 240_000));
		const b = unattributedClaimSummary(
			new Date(Date.now() + 4 * 7 * 86_400_000),
		);
		expect(a.strict_would_refuse).toBe(b.strict_would_refuse);
		expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
	});

	it("2 total equals the number driven through the real recorder", async () => {
		const n = drive("client-a", "alice", 3);
		expect((await health()).unattributed_claims.strict_would_refuse).toBe(n);
	});

	it("3 two names from two clients aggregate into one total", async () => {
		const n = drive("client-a", "alice", 2) + drive("client-b", "bob", 5);
		expect((await health()).unattributed_claims.strict_would_refuse).toBe(n);
	});

	it("3b /health never carries a clientId or claimed name", async () => {
		drive("client-secret-shaped", "agent-zeta", 1);
		const raw = JSON.stringify(await health());
		expect(raw).not.toContain("client-secret-shaped");
		expect(raw).not.toContain("agent-zeta");
	});

	it("4 (control) the existing keys are unchanged", async () => {
		delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
		const body = await health();
		expect(body.status).toBe("ok");
		expect(body.service).toBe("vantage-peers-mcp-http");
		expect(body).toHaveProperty("version");
		expect(body).toHaveProperty("commit");
		expect(body.transport).toBe("streamable-http");
		expect(body.oauth).toBe("supported");
		expect(body.scopes).toEqual(["mcp:full"]);
		expect(body.actor_credential).toEqual({
			mode: "strict",
			source: "unset",
		});
	});
});

describe("5 (control) checkActorBinding unchanged in both modes", () => {
	const ctx = orgCtx("client-a");
	it("default (unset) is strict: typed name refused AGENT_CREDENTIAL_REQUIRED", () => {
		delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
		expect(checkActorBinding(ctx, "alice")).toMatch(
			/^AGENT_CREDENTIAL_REQUIRED/,
		);
	});
	it("explicit permissive: typed name accepted", () => {
		process.env[ACTOR_CREDENTIAL_MODE_ENV] = "permissive";
		expect(checkActorBinding(ctx, "alice")).toBeNull();
	});
	it("strict: typed name refused AGENT_CREDENTIAL_REQUIRED", () => {
		process.env[ACTOR_CREDENTIAL_MODE_ENV] = "strict";
		expect(checkActorBinding(ctx, "alice")).toMatch(
			/^AGENT_CREDENTIAL_REQUIRED/,
		);
	});
	it("strict: master scope still passes", () => {
		process.env[ACTOR_CREDENTIAL_MODE_ENV] = "strict";
		const master: OAuthContext = {
			...ctx,
			isMaster: true,
			scopeProfile: "master",
			fromAllowList: ["*"],
			namespaceReadPrefixes: ["*"],
			namespaceWritePrefixes: ["*"],
		};
		expect(checkActorBinding(master, "alice")).toBeNull();
	});
	it("checkActorBinding itself records nothing", async () => {
		delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
		checkActorBinding(ctx, "alice");
		expect((await health()).unattributed_claims.strict_would_refuse).toBe(0);
	});
});

describe("6 /admin/actor-claims breakdown is master-only", () => {
	it("unauthenticated read is refused and leaks nothing", async () => {
		drive("client-a", "alice", 1);
		const res = await app.request("/admin/actor-claims");
		expect(res.status).toBe(401);
		const text = await res.text();
		expect(text).not.toContain("alice");
		expect(text).not.toContain("client-a");
	});
	it("wrong bearer is refused", async () => {
		const res = await app.request("/admin/actor-claims", {
			headers: { Authorization: "Bearer not-the-master" },
		});
		expect(res.status).toBe(403);
	});
	it("master read returns the breakdown whose sum equals the total", async () => {
		const n = drive("client-a", "alice", 2) + drive("client-b", "bob", 4);
		const res = await app.request("/admin/actor-claims", {
			headers: { Authorization: MASTER },
		});
		expect(res.status).toBe(200);
		const b = await res.json();
		expect(b.strict_would_refuse).toBe(n);
		expect(b.breakdown).toHaveLength(2);
		expect(
			b.breakdown.reduce((s: number, r: { count: number }) => s + r.count, 0),
		).toBe(n);
		expect(b.breakdown).toContainEqual({
			clientId: "client-a",
			claimed: "alice",
			count: 2,
		});
	});
});
