/**
 * STRICT BY DEFAULT — VantagePeers Cloud MCP. Task k175v22zc52w1cbvq1d1qps50d8fccpg.
 *
 * VANTAGE_ACTOR_CREDENTIAL_MODE absent (or empty) now resolves to STRICT. An
 * operator keeps permissive only by writing "permissive" explicitly. Every test
 * here runs with the variable UNSET unless it says otherwise.
 *
 * Strict requires the agent credential EXCEPT for a seat acting as itself:
 * the TOKEN ROW's fromAllowList is exactly one name, not "*", no `principal`
 * on the row, and the claimed name equals that one name (Pi ruling (1)).
 *
 * Five poles, scoped NON-MASTER identity, env unset (Eta's contract):
 *   1 multi-name bearer, no credential            -> REFUSED
 *   2 single-name seat naming itself              -> SERVED
 *   3 single-name seat naming another             -> REFUSED
 *   4 person token (principal on the row)         -> REFUSED
 *     (end to end on a REAL #1444 person token: person-token-writer-role.test.ts,
 *      "strict default composes with the writer-role gate"; unit pin below)
 *   5 ["*"] allowlist is never single-name        -> REFUSED
 * Plus: a valid agent credential naming its own agent -> SERVED.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app as healthApp } from "../server-http.js";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	actorCredentialMode,
	bearerAuthMiddleware,
	isMasterScope,
	isSeatActingAsItself,
	type OAuthContext,
	resolveActorCredentialMode,
	sha256Hex,
	unattributedClaimCounts,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const HEADER = "x-vantage-agent-credential";
const SECRET_ALICE = "secret-alice-acme";
const TEAM_TOKEN = "team-member-token";
const SEAT_TOKEN = "seat-alice-token";
const STAR_TOKEN = "star-allowlist-token";
const COMPLETE = { taskId: "k1", completionNote: "done" };

const OAUTH_ROWS: Record<string, Record<string, unknown>> = {};

function installInternalClient(): void {
	const fake = {
		query: async (name: string, args: unknown) => {
			if (name === "oauth:getAccessTokenByHash") {
				return OAUTH_ROWS[(args as { tokenHash: string }).tokenHash] ?? null;
			}
			if (name === "agentCredentials:resolveAgentCredential") {
				const { presentedSecret } = args as { presentedSecret: string };
				if (presentedSecret === SECRET_ALICE) {
					return { orgSlug: "acme", agentName: "alice" };
				}
				throw Object.assign(new Error("[Request ID: x] Server Error"), {
					data: `RBAC_DENIED: not recognised for "agentCredentials:resolveAgentCredential"`,
				});
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string) => {
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	_setInternalClientForTest(fake as any);
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function fakeServer(): { server: McpServer; tools: Map<string, Handler> } {
	const tools = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		tools.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	return {
		server: { tool: reg, registerTool: reg } as unknown as McpServer,
		tools,
	};
}

function buildConvex() {
	const mutations: Array<{ name: string; args: unknown }> = [];
	const convex = {
		query: vi.fn(async () => null),
		mutation: vi.fn(async (name: string, args: unknown) => {
			mutations.push({ name, args });
			return { ok: true };
		}),
		action: vi.fn(async () => null),
	};
	return { convex, mutations };
}

function buildApp(convex: unknown): Hono {
	const app = new Hono();
	app.use("*", bearerAuthMiddleware());
	app.post("/tool/:name", async (c) => {
		const ctx = c.get("oauthContext") as OAuthContext;
		const { server, tools } = fakeServer();
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		registerTools(server, convex as any, ctx);
		const tool = tools.get(c.req.param("name"));
		if (!tool) return c.json({ missing: true }, 404);
		return c.json({ result: await tool((await c.req.json()) as never) });
	});
	return app;
}

async function post(
	tool: string,
	opts: { bearer: string; credential?: string; body?: unknown },
) {
	const { convex, mutations } = buildConvex();
	const headers: Record<string, string> = {
		Authorization: `Bearer ${opts.bearer}`,
		"Content-Type": "application/json",
	};
	if (opts.credential !== undefined) headers[HEADER] = opts.credential;
	const res = await buildApp(convex).request(`http://localhost/tool/${tool}`, {
		method: "POST",
		headers,
		body: JSON.stringify(opts.body ?? {}),
	});
	const json = (await res.json()) as Record<string, unknown>;
	const result = json.result as
		| { isError?: boolean; content?: Array<{ text?: string }> }
		| undefined;
	return {
		status: res.status,
		refused: result?.isError === true,
		text: result?.content?.[0]?.text ?? "",
		mutations,
	};
}

let saved: string | undefined;
beforeEach(async () => {
	saved = process.env[ACTOR_CREDENTIAL_MODE_ENV];
	delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	_resetUnattributedClaimsForTest();
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
	const base = {
		userId: "user-x",
		scopes: ["vantage:read", "vantage:write"],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: "acme",
	};
	OAUTH_ROWS[await sha256Hex(TEAM_TOKEN)] = {
		...base,
		clientId: "team-client",
		scopeProfile: "team-member",
		fromAllowList: ["alice", "bob"],
		namespaceReadPrefixes: ["team/acme"],
		namespaceWritePrefixes: ["team/acme"],
	};
	// A seat token as provisionOrganization mints it: allowlist = its own name.
	OAUTH_ROWS[await sha256Hex(SEAT_TOKEN)] = {
		...base,
		clientId: "seat-client-alice",
		scopeProfile: "alice-acme",
		fromAllowList: ["alice"],
		namespaceReadPrefixes: ["orchestrator/alice", "project/acme"],
		namespaceWritePrefixes: ["orchestrator/alice", "project/acme"],
	};
	// A one-element allowlist that is the wildcard, on a non-master profile.
	OAUTH_ROWS[await sha256Hex(STAR_TOKEN)] = {
		...base,
		clientId: "star-client",
		scopeProfile: "team-member",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["team/acme"],
		namespaceWritePrefixes: ["team/acme"],
	};
	installInternalClient();
});

afterEach(() => {
	if (saved === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	else process.env[ACTOR_CREDENTIAL_MODE_ENV] = saved;
	vi.restoreAllMocks();
	_resetUnattributedClaimsForTest();
	_setInternalClientForTest(null);
});

function setEnv(v: string | undefined) {
	if (v === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	else process.env[ACTOR_CREDENTIAL_MODE_ENV] = v;
}

describe("resolver: absence is strict", () => {
	it("RED-on-f70bbf2: variable undefined -> strict / unset", () => {
		expect(resolveActorCredentialMode()).toEqual({
			mode: "strict",
			source: "unset",
		});
	});

	const table: [string | undefined, string, string][] = [
		[undefined, "strict", "unset"],
		["", "strict", "empty"],
		["permissive", "permissive", "configured"],
		["strict", "strict", "configured"],
		["banana", "strict", "coerced"],
	];
	for (const [env, mode, source] of table) {
		it(`${JSON.stringify(env ?? "<undefined>")} -> ${mode}/${source}`, () => {
			setEnv(env);
			const r = resolveActorCredentialMode();
			expect({ mode: r.mode, source: r.source }).toEqual({ mode, source });
			expect(actorCredentialMode()).toBe(mode);
		});
	}

	it("/health publishes mode strict, source unset when the env is absent", async () => {
		const res = await healthApp.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.actor_credential).toEqual({ mode: "strict", source: "unset" });
	});
});

/** The oauthContext the middleware attaches for a bearer (read via whoami-free echo). */
async function ctxOf(bearer: string): Promise<OAuthContext> {
	const app = new Hono();
	app.use("*", bearerAuthMiddleware());
	app.get("/echo", (c) => c.json(c.get("oauthContext")));
	const res = await app.request("http://localhost/echo", {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	return (await res.json()) as OAuthContext;
}

describe("the five poles — scoped non-master identity, env unset", () => {
	it("every bearer here resolves to a NON-master context", async () => {
		for (const t of [TEAM_TOKEN, SEAT_TOKEN]) {
			const ctx = await ctxOf(t);
			expect(ctx.isMaster).toBe(false);
			expect(isMasterScope(ctx)).toBe(false);
		}
	});

	it("POLE 1 — multi-name bearer naming an allowlisted agent, no credential -> AGENT_CREDENTIAL_REQUIRED", async () => {
		const r = await post("complete_task", {
			bearer: TEAM_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(r.refused).toBe(true);
		expect(r.text).toMatch(/^AGENT_CREDENTIAL_REQUIRED/);
		expect(r.mutations).toHaveLength(0);
	});

	it("POLE 2 — single-name seat naming ITSELF, no credential -> SERVED (complete_task and from-kind store_memory)", async () => {
		const a = await post("complete_task", {
			bearer: SEAT_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(a.refused).toBe(false);
		expect(a.mutations).toHaveLength(1);
		const b = await post("store_memory", {
			bearer: SEAT_TOKEN,
			body: {
				content: "x",
				type: "fact",
				namespace: "orchestrator/alice",
				createdBy: "alice",
			},
		});
		expect(b.text).not.toMatch(/AGENT_CREDENTIAL_REQUIRED/);
		expect(b.refused).toBe(false);
	});

	it("POLE 3 — single-name seat naming ANOTHER agent, no credential -> AGENT_CREDENTIAL_REQUIRED", async () => {
		const r = await post("complete_task", {
			bearer: SEAT_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "bob" },
		});
		expect(r.refused).toBe(true);
		expect(r.text).toMatch(/^AGENT_CREDENTIAL_REQUIRED/);
		expect(r.mutations).toHaveLength(0);
	});

	it("POLE 5 — a ['*'] allowlist never counts as single-name: the exemption refuses it, whatever is named", async () => {
		const star = await ctxOf(STAR_TOKEN);
		expect(star.fromAllowList).toEqual(["*"]);
		expect(star.accessTokenHash).toBeDefined();
		for (const name of ["*", "alice"]) {
			expect(isSeatActingAsItself(star, name)).toBe(false);
		}
		// Contrast with the real seat row: the predicate is what tells them apart.
		expect(isSeatActingAsItself(await ctxOf(SEAT_TOKEN), "alice")).toBe(true);
	});

	it("PIN (pre-existing, not the exemption): a ['*'] row is MASTER scope (@vantageos/cloud-identity isMasterScope), so checkActorBinding serves it on the master branch", async () => {
		const star = await ctxOf(STAR_TOKEN);
		expect(isMasterScope(star)).toBe(true);
		const r = await post("complete_task", {
			bearer: STAR_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(r.refused).toBe(false);
	});

	it("exemption is read from the token row, never from an argument or a non-row context", () => {
		const row: OAuthContext = {
			clientId: "seat-client-alice",
			userId: "u",
			scopes: [],
			scopeProfile: "alice-acme",
			fromAllowList: ["alice"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: 0,
			isMaster: false,
			accessTokenHash: "h",
		};
		expect(isSeatActingAsItself(row, "alice")).toBe(true);
		// Same claim, multi-name row: not exempt.
		expect(
			isSeatActingAsItself(
				{ ...row, fromAllowList: ["alice", "bob"] },
				"alice",
			),
		).toBe(false);
		// Same row shape but not from a token row (e.g. a Clerk-JWT session): not exempt.
		expect(
			isSeatActingAsItself({ ...row, accessTokenHash: undefined }, "alice"),
		).toBe(false);
		// Any principal on the row withholds it, including a kind added later.
		expect(isSeatActingAsItself({ ...row, principal: "person" }, "alice")).toBe(
			false,
		);
		// A principal kind that does not exist yet: the type admits only
		// "person" today, so the future value is forced through a cast on purpose.
		for (const future of ["service", "agent"]) {
			const ctx = { ...row, principal: future } as unknown as OAuthContext;
			expect(isSeatActingAsItself(ctx, "alice")).toBe(false);
		}
		expect(isSeatActingAsItself({ ...row, fromAllowList: [""] }, "")).toBe(
			false,
		);
	});

	it("SERVED — valid agent credential naming its own agent (multi-name bearer)", async () => {
		const r = await post("complete_task", {
			bearer: TEAM_TOKEN,
			credential: SECRET_ALICE,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(r.status).toBe(200);
		expect(r.refused).toBe(false);
		expect(r.mutations).toHaveLength(1);
	});

	it("explicit permissive keeps today's behaviour: the pole-1 call is served", async () => {
		setEnv("permissive");
		const r = await post("complete_task", {
			bearer: TEAM_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "bob" },
		});
		expect(r.refused).toBe(false);
		expect(r.mutations).toHaveLength(1);
	});

	it("seat OMITTING the name on a from-kind tool is still refused by the roster check (pre-existing, mode-independent)", async () => {
		const r = await post("complete_task", {
			bearer: SEAT_TOKEN,
			body: COMPLETE,
		});
		expect(r.refused).toBe(true);
		expect(r.text).toContain(
			"from='undefined' is not in this client's allowlist",
		);
		expect(r.mutations).toHaveLength(0);
	});
});

describe("strict_would_refuse counts only what strict refuses under the seat rule", () => {
	it("permissive: seat-self is served and NOT counted; a multi-name claim is counted", async () => {
		setEnv("permissive");
		await post("complete_task", {
			bearer: SEAT_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(unattributedClaimCounts()).toEqual([]);
		await post("complete_task", {
			bearer: TEAM_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "bob" },
		});
		const total = unattributedClaimCounts().reduce((n, r) => n + r.count, 0);
		expect(total).toBe(1);
		const res = await healthApp.request("/health");
		const body = (await res.json()) as {
			unattributed_claims: { strict_would_refuse: number };
		};
		expect(body.unattributed_claims.strict_would_refuse).toBe(1);
	});
});
