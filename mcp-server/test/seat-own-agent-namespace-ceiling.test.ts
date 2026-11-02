/**
 * Task k171ysvpwb4wzjkkjr2kqpwsx98hedaw. A seat token's namespace prefixes are a
 * SNAPSHOT taken at mint time. A seat minted before its profile gained
 * `orchestrator/<agentId>` carries `orchestrator/<name>` only, so the MCP refused
 * the one agent namespace Convex admits (convex/lib/seatNamespace.ts). The ceiling
 * now admits `orchestrator/<the token's own verified agent ID>` in both
 * directions, segment-bounded, derived only from the verified seat stamp on the
 * token row (believed only for the token's own org), never from a name or an
 * argument, exactly like the `team/<orgClerkId>` carve-out.
 *
 * Every pole runs through bearerAuthMiddleware (the context as a real token
 * yields it), not a hand-built context.
 *
 * Poles: own ID allowed (read + write) with a stale snapshot; refused: another
 * agent's ID, `orchestrator/<id>x`, a bare `orchestrator`, `orchestrator/<name>`
 * for a seat whose snapshot names another agent, a seat with no verified agent, a
 * stamp for another org; master unchanged.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	checkNamespaceRead,
	checkNamespaceWrite,
	type OAuthContext,
	sha256Hex,
} from "../src/auth.js";

const OWN = "r57b8p6jp2na6p6pdz7z0g0sk58fczj9";
const OTHER = "r57zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

const ROWS: Record<string, Record<string, unknown>> = {};

const row = (extra: Record<string, unknown>) => ({
	userId: "u",
	scopes: ["vantage:read", "vantage:write"],
	expiresAt: Date.now() + 3_600_000,
	clientId: "seat-victor",
	scopeProfile: "victor-iris-rh",
	fromAllowList: ["victor"],
	// the stale mint-time snapshot: the NAME, not the ID
	namespaceReadPrefixes: ["orchestrator/victor", "project/iris-rh"],
	namespaceWritePrefixes: ["orchestrator/victor", "project/iris-rh"],
	clerkOrgSlug: "iris-rh",
	...extra,
});

const TOKENS = {
	own: "t-own",
	nameOnlyOtherAgent: "t-other-agent",
	noAgent: "t-no-agent",
	foreignStamp: "t-foreign-stamp",
	oldConvex: "t-old-convex",
} as const;

beforeEach(async () => {
	process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
	vi.spyOn(console, "error").mockImplementation(() => {});
	ROWS[await sha256Hex(TOKENS.own)] = row({
		seatAgent: { agentId: OWN, orgId: "iris-rh", agentName: "victor" },
	});
	ROWS[await sha256Hex(TOKENS.nameOnlyOtherAgent)] = row({
		seatAgent: { agentId: OTHER, orgId: "iris-rh", agentName: "marie" },
	});
	ROWS[await sha256Hex(TOKENS.noAgent)] = row({ seatAgent: null });
	ROWS[await sha256Hex(TOKENS.foreignStamp)] = row({
		seatAgent: { agentId: OWN, orgId: "other-co", agentName: "victor" },
	});
	ROWS[await sha256Hex(TOKENS.oldConvex)] = row({});
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	_setInternalClientForTest({
		query: async (name: string, args: unknown) => {
			if (name === "oauth:getAccessTokenByHash") {
				return ROWS[(args as { tokenHash: string }).tokenHash] ?? null;
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string) => {
			throw new Error(`unmocked mutation: ${name}`);
		},
	} as any);
});

async function ctxOf(token: string): Promise<OAuthContext> {
	const app = new Hono();
	app.use("*", bearerAuthMiddleware());
	app.get("/ctx", (c) => c.json(c.get("oauthContext") as OAuthContext));
	const res = await app.request("http://localhost/ctx", {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(res.status).toBe(200);
	return (await res.json()) as OAuthContext;
}

const FORBIDDEN = /^Forbidden: namespace=/;

describe("a stale-snapshot seat reaches its own orchestrator/<agent ID>", () => {
	it("ALLOW: write and read orchestrator/<own ID> and a sub-namespace", async () => {
		const ctx = await ctxOf(TOKENS.own);
		expect(ctx.namespaceWritePrefixes).not.toContain(`orchestrator/${OWN}`);
		for (const ns of [`orchestrator/${OWN}`, `orchestrator/${OWN}/notes`]) {
			expect(checkNamespaceWrite(ctx, ns), ns).toBeNull();
			expect(checkNamespaceRead(ctx, ns), ns).toBeNull();
		}
	});

	it("REFUSED: another agent's ID, a no-boundary prefix, a bare root", async () => {
		const ctx = await ctxOf(TOKENS.own);
		for (const ns of [
			`orchestrator/${OTHER}`,
			`orchestrator/${OWN}x`,
			`orchestrator/${OWN.slice(0, -1)}`,
			"orchestrator",
			"orchestrator/",
			"orchestrator/*",
		]) {
			expect(checkNamespaceWrite(ctx, ns), ns).toMatch(FORBIDDEN);
			expect(checkNamespaceRead(ctx, ns), ns).toMatch(FORBIDDEN);
		}
	});

	it("REFUSED: a name-only snapshot of another agent never opens this seat's ID or a different name", async () => {
		const ctx = await ctxOf(TOKENS.nameOnlyOtherAgent);
		expect(checkNamespaceWrite(ctx, `orchestrator/${OWN}`)).toMatch(FORBIDDEN);
		expect(checkNamespaceWrite(ctx, "orchestrator/marie")).toMatch(FORBIDDEN);
		expect(checkNamespaceWrite(ctx, `orchestrator/${OTHER}`)).toBeNull();
	});

	it("REFUSED: no verified agent (org-level seat, stamp for another org, provider predating the stamp)", async () => {
		for (const token of [TOKENS.noAgent, TOKENS.foreignStamp, TOKENS.oldConvex]) {
			const ctx = await ctxOf(token);
			expect(checkNamespaceWrite(ctx, `orchestrator/${OWN}`), token).toMatch(FORBIDDEN);
			expect(checkNamespaceRead(ctx, `orchestrator/${OWN}`), token).toMatch(FORBIDDEN);
		}
	});

	it("REFUSED: the rest of the snapshot is unchanged (project/<other slug>, audit/friction)", async () => {
		const ctx = await ctxOf(TOKENS.own);
		expect(checkNamespaceWrite(ctx, "project/marie")).toMatch(FORBIDDEN);
		expect(checkNamespaceWrite(ctx, "audit/friction")).toMatch(FORBIDDEN);
		expect(checkNamespaceWrite(ctx, "project/iris-rh")).toBeNull();
		expect(checkNamespaceWrite(ctx, "orchestrator/victor")).toBeNull();
	});

	it("MASTER unchanged", () => {
		const master = {
			...row({}),
			isMaster: true,
			scopeProfile: "master",
		} as unknown as OAuthContext;
		expect(checkNamespaceWrite(master, `orchestrator/${OTHER}`)).toBeNull();
		expect(checkNamespaceRead(master, "audit/friction")).toBeNull();
	});
});
