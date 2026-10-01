/**
 * The acting agent is resolved ONCE, at the bearer-auth boundary, from the
 * presented credential — never from a name the caller types.
 *
 * task k173ny6as0gsq996xtbtzn5rjd8fbj9m. VantagePeers Cloud (multi-tenant).
 *
 * Defect measured at 76e4c2d: `resolveAgentCredential` (convex/agentCredentials.ts)
 * had ZERO callers in mcp-server/src, and `callerOrchestrator` was checked only
 * against the org's roster (`fromAllowList`). Two agents of one org share that
 * roster, so agent A could act as agent B by typing B's name.
 *
 * Every pole below runs under an ORDINARY agent credential of a real org, over
 * the Clerk-JWT branch (ctx.clerkJwt, isMaster:false). None runs under the
 * service account or the master bearer: a proof under the maintenance identity
 * exercises the bypass, not the control.
 *
 * SURFACES (bipolar per surface, not per site):
 *   S1 boundary   — bearerAuthMiddleware resolves the actor, binds its org.
 *   S2 acting     — every tool declaring `callerOrchestrator`, plus `from` kinds.
 *   S3 read by-id — get_task.
 *   S4 read set   — list_tasks / search_tasks_by_keyword / list_tasks_by_mission.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { z } from "zod";
import {
	CONTROL_NAME,
	type Connect,
	deriveActors,
	type ProbeOp,
	type Report,
	renderReport,
	runVerification,
	type ToolClient,
} from "../scripts/verify-actor-credentials.js";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	bearerAuthMiddleware,
	checkActorBinding,
	type OAuthContext,
	sha256Hex,
	unattributedClaimCounts,
} from "../src/auth.js";
import { defineTool } from "../src/registerTool.js";
import { registerTools } from "../src/tools.js";

const CLERK_DOMAIN = "https://sharp-sponge-67.clerk.accounts.dev";
const CLERK_JWKS_URL = `${CLERK_DOMAIN}/.well-known/jwks.json`;
const KID = "test-key-actor-from-credential";
const AGENT_HEADER = "x-vantage-agent-credential";

const SECRET_ALICE_A = "secret-alice-org-a";
const SECRET_BOB_A = "secret-bob-org-a";
const SECRET_ALICE_B = "secret-alice-org-b";
const SECRET_ALICE_C = "secret-alice-org-c";
const SECRET_INACTIVE = "secret-inactive-agent";
const SECRET_LOOKUP_THROWS = "secret-lookup-throws";
// An org whose orchestrator is registered under an accented identifier, exactly
// as the server returns it (list_peers id: "hélios"): the trap the verification
// script must not fall into by matching a typed spelling.
const SECRET_HELIOS = "secret-helios-org-iris";
const SECRET_MARIE = "secret-marie-org-iris";
const SECRET_ZOE = "secret-zoe-org-iris";
const HELIOS = "h\u00e9lios";

let publicJwk: Record<string, unknown>;
let privateKey: CryptoKey;

async function mintClerkJwt(orgId: string, sub = "user_x"): Promise<string> {
	return new SignJWT({ org_id: orgId })
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(CLERK_DOMAIN)
		.setSubject(sub)
		.setAudience("convex")
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(privateKey);
}

// org-a and org-b BOTH carry an agent named "alice": a name is not a tenant.
// org-c's roster does not admit "alice" at all (roster narrows).
const MAPPINGS: Record<
	string,
	{ allowedOrchestrators: string[]; scopes: string[]; isActive: boolean }
> = {
	"org-a": {
		allowedOrchestrators: ["alice", "bob"],
		scopes: ["view-own-tasks"],
		isActive: true,
	},
	"org-b": {
		allowedOrchestrators: ["alice", "carol"],
		scopes: ["view-own-tasks"],
		isActive: true,
	},
	"org-c": {
		allowedOrchestrators: ["zed"],
		scopes: ["view-own-tasks"],
		isActive: true,
	},
	"org-iris": {
		allowedOrchestrators: [HELIOS, "marie", "zoe", "old-bot"],
		scopes: ["view-own-tasks"],
		isActive: true,
	},
};

// What agentCredentials:resolveAgentCredential returns per presented secret.
// An inactive agent / unknown secret is REFUSED by the door (raises RBAC_DENIED).
const CREDENTIALS: Record<
	string,
	{ orgSlug: string; agentName: string } | null
> = {
	[SECRET_ALICE_A]: { orgSlug: "org-a", agentName: "alice" },
	[SECRET_BOB_A]: { orgSlug: "org-a", agentName: "bob" },
	[SECRET_ALICE_B]: { orgSlug: "org-b", agentName: "alice" },
	[SECRET_ALICE_C]: { orgSlug: "org-c", agentName: "alice" },
	[SECRET_INACTIVE]: null,
	[SECRET_HELIOS]: { orgSlug: "org-iris", agentName: HELIOS },
	[SECRET_MARIE]: { orgSlug: "org-iris", agentName: "marie" },
	[SECRET_ZOE]: { orgSlug: "org-iris", agentName: "zoe" },
};

// Opaque OAuth access tokens (auth.ts branch 2), keyed by sha256 of the token.
// One is attached to org-a (its row snapshots clerkOrgSlug); one is an
// unattached profile with no org at all.
const OAUTH_TOKEN_ORG_A = "oauth-token-attached-to-org-a";
const OAUTH_TOKEN_UNATTACHED = "oauth-token-with-no-org";
const OAUTH_ROWS: Record<string, Record<string, unknown>> = {};
// Every secret the boundary asked Convex to resolve, in order.
const lookupCalls: string[] = [];

async function seedOauthRows(): Promise<void> {
	const base = {
		clientId: "client-x",
		userId: "user-x",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "team-member",
		fromAllowList: ["alice", "bob"],
		namespaceReadPrefixes: ["team/org-a"],
		namespaceWritePrefixes: ["team/org-a"],
		expiresAt: Date.now() + 3_600_000,
	};
	OAUTH_ROWS[await sha256Hex(OAUTH_TOKEN_ORG_A)] = {
		...base,
		clerkOrgSlug: "org-a",
	};
	OAUTH_ROWS[await sha256Hex(OAUTH_TOKEN_UNATTACHED)] = { ...base };
}

function installInternalClient(): void {
	const fake = {
		query: async (name: string, args: unknown) => {
			if (name === "oauth:getAccessTokenByHash") {
				const { tokenHash } = args as { tokenHash: string };
				return OAUTH_ROWS[tokenHash] ?? null;
			}
			if (name === "clientOrgMapping:getByClerkSlug") {
				const { orgSlug } = args as { orgSlug: string };
				return MAPPINGS[orgSlug] ?? null;
			}
			if (name === "agentCredentials:resolveAgentCredential") {
				const { presentedSecret } = args as { presentedSecret: string };
				lookupCalls.push(presentedSecret);
				if (presentedSecret === SECRET_LOOKUP_THROWS) {
					throw new Error("convex unavailable");
				}
				const found = CREDENTIALS[presentedSecret] ?? null;
				if (found === null) {
					// The real door RAISES a coded refusal for a wrong secret (it no
					// longer answers `null`): ConvexError carries it in `.data`.
					throw Object.assign(new Error("[Request ID: x] Server Error"), {
						data: `RBAC_DENIED: the presented agent credential does not resolve to an active agent for "agentCredentials:resolveAgentCredential" — ${JSON.stringify({ registration: "agentCredentials:resolveAgentCredential", orgSlug: null, reason: "credential-not-recognised" })}`,
					});
				}
				return found;
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

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
type Registered = { handler: ToolHandler; schemaKeys: string[] };

/** What the test app puts on the wire — every response shape it can produce. */
type Wire = {
	result?: unknown;
	oauthCtx?: {
		actor?: { orgSlug: string; agentName: string };
		isMaster?: boolean;
	} | null;
	tools?: Array<{ name: string; schemaKeys: string[] }>;
	error?: string;
};

function buildFakeServer(): {
	server: McpServer;
	tools: Map<string, Registered>;
} {
	const tools = new Map<string, Registered>();
	const keysOf = (schema: unknown): string[] => {
		const shape = (schema as { shape?: Record<string, unknown> } | undefined)
			?.shape;
		return shape ? Object.keys(shape) : [];
	};
	const server = {
		tool(...args: unknown[]): unknown {
			tools.set(args[0] as string, {
				handler: args[args.length - 1] as ToolHandler,
				schemaKeys: [],
			});
			return {};
		},
		registerTool(...args: unknown[]): unknown {
			const config = args[1] as { inputSchema?: unknown };
			tools.set(args[0] as string, {
				handler: args[args.length - 1] as ToolHandler,
				schemaKeys: keysOf(config?.inputSchema),
			});
			return {};
		},
	} as unknown as McpServer;
	return { server, tools };
}

type ConvexCalls = { mutations: Array<{ name: string; args: unknown }> };

function buildToolConvex(rows: { getById?: unknown; list?: unknown[] }): {
	convex: unknown;
	calls: ConvexCalls;
} {
	const calls: ConvexCalls = { mutations: [] };
	const convex = {
		query: vi.fn(async (name: string, args?: { fields?: string }) => {
			if (name === "tasks:getById") return rows.getById ?? null;
			// Faithful to convex/tasks.ts: the "lite" projection is
			// {_id,_creationTime,title,status,priority,assignedTo,missionId} — it
			// STRIPS orgId and createdBy. A caller that needs the tenant stamp must
			// ask for "full".
			if (args?.fields === "lite") {
				return (rows.list ?? []).map((r) => {
					const {
						orgId: _o,
						createdBy: _c,
						...lite
					} = r as Record<string, unknown>;
					return lite;
				});
			}
			return rows.list ?? [];
		}),
		mutation: vi.fn(async (name: string, args: unknown) => {
			calls.mutations.push({ name, args });
			return { ok: true };
		}),
		action: vi.fn(async () => null),
	};
	return { convex, calls };
}

/**
 * The real pipeline: bearerAuthMiddleware -> the oauthContext it attaches ->
 * registerTools(server, convex, thatContext) -> the tool handler. This is the
 * shape server-http.ts's /mcp handler wires; only the transport framing is cut.
 */
function buildApp(convexFor: () => unknown): Hono {
	const app = new Hono();
	app.use("*", bearerAuthMiddleware());
	app.post("/tool/:name", async (c) => {
		const ctx = c.get("oauthContext") as OAuthContext;
		const { server, tools } = buildFakeServer();
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		registerTools(server, convexFor() as any, ctx);
		const tool = tools.get(c.req.param("name"));
		if (!tool) return c.json({ missing: true }, 404);
		const args = (await c.req.json()) as Record<string, unknown>;
		return c.json({ result: await tool.handler(args) });
	});
	app.get("/tools", (c) => {
		const ctx = c.get("oauthContext") as OAuthContext;
		const { server, tools } = buildFakeServer();
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		registerTools(server, buildToolConvex({}).convex as any, ctx);
		return c.json({
			tools: [...tools.entries()].map(([name, t]) => ({
				name,
				schemaKeys: t.schemaKeys,
			})),
		});
	});
	app.get("/echo", (c) => c.json({ oauthCtx: c.get("oauthContext") ?? null }));
	return app;
}

async function send(
	app: Hono,
	path: string,
	opts: {
		orgId: string;
		/** Present an opaque OAuth access token instead of a Clerk JWT. */
		oauthToken?: string;
		credential?: string;
		method?: "GET" | "POST";
		body?: unknown;
	},
): Promise<{ status: number; json: Wire }> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${opts.oauthToken ?? (await mintClerkJwt(opts.orgId))}`,
		"Content-Type": "application/json",
	};
	if (opts.credential !== undefined) headers[AGENT_HEADER] = opts.credential;
	const res = await app.request(`http://localhost${path}`, {
		method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
	});
	let json: unknown = null;
	try {
		json = await res.json();
	} catch {
		json = null;
	}
	return { status: res.status, json };
}

function resultText(json: { result?: unknown }): string {
	const r = json.result as { content?: Array<{ text?: string }> } | undefined;
	return r?.content?.[0]?.text ?? "";
}

function isRefused(json: { result?: unknown }): boolean {
	return (json.result as { isError?: boolean } | undefined)?.isError === true;
}

beforeAll(async () => {
	const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
	privateKey = priv;
	publicJwk = {
		...(await exportJWK(publicKey)),
		kid: KID,
		alg: "RS256",
		use: "sig",
	};
	await seedOauthRows();
});

beforeEach(() => {
	process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === CLERK_JWKS_URL) {
				return new Response(JSON.stringify({ keys: [publicJwk] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unmocked fetch: ${url}`);
		}),
	);
	installInternalClient();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	_resetUnattributedClaimsForTest();
	_setInternalClientForTest(null);
});

describe("S1 boundary — the actor is resolved once, from the presented credential", () => {
	it("ALLOW: a valid agent credential of the caller's own org attaches the resolved actor", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		const { status, json } = await send(app, "/echo", {
			orgId: "org-a",
			credential: SECRET_ALICE_A,
		});
		expect(status).toBe(200);
		expect(json.oauthCtx?.actor).toEqual({
			orgSlug: "org-a",
			agentName: "alice",
		});
		expect(json.oauthCtx?.isMaster).toBe(false);
	});

	it("no agent credential presented: the org-only caller carries NO actor (never a defaulted one)", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		const { status, json } = await send(app, "/echo", { orgId: "org-a" });
		expect(status).toBe(200);
		expect(json.oauthCtx?.actor).toBeUndefined();
	});

	it("DENY: a credential that resolves to nothing (unknown / rotated-out / inactive agent) is refused at the boundary", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		for (const credential of ["not-a-real-secret", SECRET_INACTIVE]) {
			const { status } = await send(app, "/echo", {
				orgId: "org-a",
				credential,
			});
			expect(status, `credential ${credential}`).toBe(401);
		}
	});

	it("DENY: an EMPTY credential header is a malformed credential, refused without ever asking Convex to resolve it", async () => {
		lookupCalls.length = 0;
		const app = buildApp(() => buildToolConvex({}).convex);
		const { status } = await send(app, "/echo", {
			orgId: "org-a",
			credential: "   ",
		});
		expect(status).toBe(401);
		expect(lookupCalls).toEqual([]);
	});

	it("DENY: a lookup that THROWS is a refusal, never a fall-through to an org-only grant", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		const { status } = await send(app, "/echo", {
			orgId: "org-a",
			credential: SECRET_LOOKUP_THROWS,
		});
		expect(status).toBe(401);
	});

	it("DENY, TOLD APART: a coded RBAC_DENIED refusal answers AGENT_CREDENTIAL_INVALID; a lookup that throws answers AGENT_CREDENTIAL_LOOKUP_FAILED — same 401, different code", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		const refused = await send(app, "/echo", {
			orgId: "org-a",
			credential: "not-a-real-secret",
		});
		const failed = await send(app, "/echo", {
			orgId: "org-a",
			credential: SECRET_LOOKUP_THROWS,
		});
		expect(refused.status).toBe(401);
		expect(failed.status).toBe(401);
		expect(refused.json.error).toMatch(/^AGENT_CREDENTIAL_INVALID:/);
		expect(failed.json.error).toMatch(/^AGENT_CREDENTIAL_LOOKUP_FAILED:/);
	});

	it("DENY: an agent of org B presented with org A's session is refused (ORG_MISMATCH) — same name, different tenant", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		const { status, json } = await send(app, "/echo", {
			orgId: "org-a",
			credential: SECRET_ALICE_B,
		});
		expect(status).toBe(403);
		expect(JSON.stringify(json)).toContain("ORG_MISMATCH");
	});
});

describe("S1 boundary, OAuth access-token branch — the same binding, keyed on the token row's org", () => {
	it("ALLOW: an agent credential of the token's own org attaches the resolved actor", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		const { status, json } = await send(app, "/echo", {
			orgId: "org-a",
			oauthToken: OAUTH_TOKEN_ORG_A,
			credential: SECRET_ALICE_A,
		});
		expect(status).toBe(200);
		expect(json.oauthCtx?.actor).toEqual({
			orgSlug: "org-a",
			agentName: "alice",
		});
		expect(json.oauthCtx?.isMaster).toBe(false);
	});

	it("DENY: a same-named agent of ANOTHER org presented with org-a's token is ORG_MISMATCH", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		const { status, json } = await send(app, "/echo", {
			orgId: "org-a",
			oauthToken: OAUTH_TOKEN_ORG_A,
			credential: SECRET_ALICE_B,
		});
		expect(status).toBe(403);
		expect(JSON.stringify(json)).toContain("ORG_MISMATCH");
	});

	it("DENY: a token with NO org cannot be bound, so an agent credential presented with it is refused, not trusted", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		const { status } = await send(app, "/echo", {
			orgId: "org-a",
			oauthToken: OAUTH_TOKEN_UNATTACHED,
			credential: SECRET_ALICE_A,
		});
		expect(status).toBe(403);
	});
});

describe("S2 acting — callerOrchestrator is a claim the credential verifies, never an authority", () => {
	it("KEY RED: agent A's credential declaring agent B's name is REFUSED and nothing is dispatched", async () => {
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-a",
			credential: SECRET_ALICE_A,
			body: { taskId: "k1", completionNote: "done", callerOrchestrator: "bob" },
		});
		expect(isRefused(json)).toBe(true);
		expect(resultText(json)).toContain("AGENT_IDENTITY_MISMATCH");
		expect(calls.mutations).toHaveLength(0);
	});

	it("ALLOW: the credential holder under its OWN name proceeds, and Convex receives the resolved name", async () => {
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-a",
			credential: SECRET_ALICE_A,
			body: {
				taskId: "k1",
				completionNote: "done",
				callerOrchestrator: "alice",
			},
		});
		expect(isRefused(json)).toBe(false);
		expect(calls.mutations).toHaveLength(1);
		expect(calls.mutations[0].args).toMatchObject({
			callerOrchestrator: "alice",
		});
	});

	it("DERIVED: an omitted callerOrchestrator is filled from the resolved actor, not left to Convex or a default", async () => {
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-a",
			credential: SECRET_BOB_A,
			body: { taskId: "k1", completionNote: "done" },
		});
		expect(isRefused(json)).toBe(false);
		expect(calls.mutations[0].args).toMatchObject({
			callerOrchestrator: "bob",
		});
	});

	it("DENY (strict switch): an org-only token (no agent credential) naming an agent is REFUSED — a name typed is not an identity", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "strict");
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-a",
			body: {
				taskId: "k1",
				completionNote: "done",
				callerOrchestrator: "alice",
			},
		});
		expect(isRefused(json)).toBe(true);
		expect(resultText(json)).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(calls.mutations).toHaveLength(0);
	});

	it("INTERSECT: a valid credential of an agent the org's roster does not admit is still REFUSED (a roster narrows, the argument never widens)", async () => {
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-c",
			credential: SECRET_ALICE_C,
			body: {
				taskId: "k1",
				completionNote: "done",
				callerOrchestrator: "alice",
			},
		});
		expect(isRefused(json)).toBe(true);
		expect(calls.mutations).toHaveLength(0);
	});

	it("`from`-kind tools on other arguments (store_memory createdBy) are bound to the actor as well", async () => {
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/store_memory", {
			orgId: "org-a",
			credential: SECRET_ALICE_A,
			body: {
				content: "x",
				type: "user",
				namespace: "team/org-a",
				createdBy: "bob",
			},
		});
		expect(isRefused(json)).toBe(true);
		expect(resultText(json)).toContain("AGENT_IDENTITY_MISMATCH");
		expect(calls.mutations).toHaveLength(0);
	});

	it("SWEEP: EVERY registered tool that declares callerOrchestrator refuses a mismatched name and dispatches nothing", async () => {
		const listed = await send(
			buildApp(() => buildToolConvex({}).convex),
			"/tools",
			{ orgId: "org-a", credential: SECRET_ALICE_A },
		);
		const acting: string[] = (listed.json.tools ?? [])
			.filter((t) => t.schemaKeys.includes("callerOrchestrator"))
			.map((t) => t.name);
		// The count is read from the registrations themselves, not asserted from
		// a list a reviewer must trust.
		expect(acting.length).toBeGreaterThanOrEqual(21);

		const escaped: string[] = [];
		for (const name of acting) {
			const { convex, calls } = buildToolConvex({});
			const app = buildApp(() => convex);
			const { json } = await send(app, `/tool/${name}`, {
				orgId: "org-a",
				credential: SECRET_ALICE_A,
				body: { callerOrchestrator: "bob" },
			});
			const refused =
				isRefused(json) &&
				resultText(json).includes("AGENT_IDENTITY_MISMATCH") &&
				calls.mutations.length === 0;
			if (!refused) escaped.push(name);
		}
		expect(
			escaped,
			`tools that let alice act as bob: ${escaped.join(", ")}`,
		).toEqual([]);
	});
});

const ROW_A = {
	_id: "t-a",
	orgId: "org-a",
	createdBy: "alice",
	assignedTo: "alice",
	title: "a",
};
const ROW_B = {
	_id: "t-b",
	orgId: "org-b",
	createdBy: "alice",
	assignedTo: "alice",
	title: "b",
};
const ROW_NONE = {
	_id: "t-n",
	createdBy: "alice",
	assignedTo: "alice",
	title: "n",
};

describe("S3 read by-id — an agent of org A never reaches org B's row", () => {
	it("DENY: get_task on a row stamped org-b, same agent NAME, is not served", async () => {
		const { convex } = buildToolConvex({ getById: ROW_B });
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/get_task", {
			orgId: "org-a",
			credential: SECRET_ALICE_A,
			body: { taskId: "t-b" },
		});
		expect(resultText(json)).not.toContain('"t-b"');
		expect(isRefused(json)).toBe(true);
	});

	it("DENY: get_task on an UNSTAMPED row is not served (absence of a tenant grants nothing)", async () => {
		const { convex } = buildToolConvex({ getById: ROW_NONE });
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/get_task", {
			orgId: "org-a",
			credential: SECRET_ALICE_A,
			body: { taskId: "t-n" },
		});
		expect(isRefused(json)).toBe(true);
	});

	it("ALLOW: get_task on the row of the actor's OWN org is served", async () => {
		const { convex } = buildToolConvex({ getById: ROW_A });
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/get_task", {
			orgId: "org-a",
			credential: SECRET_ALICE_A,
			body: { taskId: "t-a" },
		});
		expect(isRefused(json)).toBe(false);
		expect(resultText(json)).toContain('"t-a"');
	});
});

describe("S4 read set — the collection surface applies the SAME tenant boundary", () => {
	const collectionTools: Array<[string, Record<string, unknown>]> = [
		["list_tasks", {}],
		["search_tasks_by_keyword", { query: "x" }],
		["list_tasks_by_mission", { missionId: "m1" }],
	];

	for (const [tool, body] of collectionTools) {
		it(`${tool}: rows of org-b and unstamped rows are dropped, own-org rows are kept`, async () => {
			const { convex } = buildToolConvex({ list: [ROW_A, ROW_B, ROW_NONE] });
			const app = buildApp(() => convex);
			const { json } = await send(app, `/tool/${tool}`, {
				orgId: "org-a",
				credential: SECRET_ALICE_A,
				body,
			});
			const text = resultText(json);
			expect(text).toContain("t-a");
			expect(text).not.toContain("t-b");
			expect(text).not.toContain("t-n");
			// The public contract is unchanged: a default (lite) call is served the
			// lite shape, so the internal tenant stamp never leaks to the caller.
			expect(text).not.toContain("orgId");
		});
	}
});

describe("S2 acting — the wrapper itself derives a `from`-kind argument the caller omitted", () => {
	// A synthetic tool whose acting-name argument is NOT called callerOrchestrator
	// and is optional: the only thing that can fill it is the wrapper's own
	// derivation for the `from` kind's fromArg.
	const actorCtx: OAuthContext = {
		clientId: "client-x",
		userId: "user-x",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "team-member",
		fromAllowList: ["alice", "bob"],
		namespaceReadPrefixes: ["team/org-a"],
		namespaceWritePrefixes: ["team/org-a"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		actor: { orgSlug: "org-a", agentName: "alice" },
	};

	function registerProbe(): {
		call: (args: Record<string, unknown>) => Promise<unknown>;
		seen: Array<Record<string, unknown>>;
	} {
		const seen: Array<Record<string, unknown>> = [];
		let handler: ToolHandler | undefined;
		const server = {
			registerTool(...a: unknown[]) {
				handler = a[a.length - 1] as ToolHandler;
				return {};
			},
		} as unknown as McpServer;
		defineTool(
			server,
			{ oauthCtx: actorCtx },
			{ kind: "from", fromArg: "createdBy" },
			"probe",
			"probe",
			{ createdBy: z.string().optional() },
			async (args: Record<string, unknown>) => {
				seen.push(args);
				return { content: [{ type: "text", text: "ok" }] };
			},
		);
		return {
			call: async (args) => (handler as ToolHandler)(args),
			seen,
		};
	}

	it("DERIVED: an omitted createdBy reaches the handler as the resolved actor's name", async () => {
		const probe = registerProbe();
		await probe.call({});
		expect(probe.seen).toHaveLength(1);
		expect(probe.seen[0]?.createdBy).toBe("alice");
	});

	it("DENY: a different agent's name never reaches the handler", async () => {
		const probe = registerProbe();
		const result = (await probe.call({ createdBy: "bob" })) as {
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(probe.seen).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// DEPLOYMENT A — the boundary accepts BOTH a presented credential and a typed
// name; the refusal path is behind ONE switch (VANTAGE_ACTOR_CREDENTIAL_MODE),
// default permissive. Deployment B flips it to strict.
//
// Every pole runs over the Clerk-JWT branch as an ORDINARY org member
// (isMaster:false, asserted per pole through /echo). None runs under the
// master bearer or the service account: that identity may declare a name by
// design and would exercise the bypass, not the switch.
// ─────────────────────────────────────────────────────────────────────────────

describe("cutover compatibility — four poles under an ordinary (non-master) caller", () => {
	const COMPLETE = { taskId: "k1", completionNote: "done" };

	async function assertOrdinary(
		app: Hono,
		orgId: string,
		credential?: string,
	): Promise<void> {
		const echo = await send(app, "/echo", { orgId, credential });
		expect(echo.json.oauthCtx?.isMaster).toBe(false);
	}

	function stderrLines(spy: { mock: { calls: unknown[][] } }): string[] {
		return spy.mock.calls.map((c) => String(c[0]));
	}

	it("POLE 1 — credential presented AND agreeing: served, actor is the resolved one, NOT recorded unattributed", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		await assertOrdinary(app, "org-a", SECRET_ALICE_A);
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-a",
			credential: SECRET_ALICE_A,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(isRefused(json)).toBe(false);
		expect(calls.mutations).toHaveLength(1);
		expect(calls.mutations[0].args).toMatchObject({
			callerOrchestrator: "alice",
		});
		expect(unattributedClaimCounts()).toEqual([]);
		expect(
			stderrLines(spy).filter((l) => l.includes("actor.unattributed")),
		).toEqual([]);
	});

	it("POLE 2 — credential presented, typed name DISAGREES: AGENT_IDENTITY_MISMATCH in permissive AND in strict, nothing dispatched", async () => {
		for (const mode of ["permissive", "strict"]) {
			vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", mode);
			const { convex, calls } = buildToolConvex({});
			const app = buildApp(() => convex);
			await assertOrdinary(app, "org-a", SECRET_ALICE_A);
			const { json } = await send(app, "/tool/complete_task", {
				orgId: "org-a",
				credential: SECRET_ALICE_A,
				body: { ...COMPLETE, callerOrchestrator: "bob" },
			});
			expect(isRefused(json), `mode=${mode}`).toBe(true);
			expect(resultText(json), `mode=${mode}`).toContain(
				"AGENT_IDENTITY_MISMATCH",
			);
			expect(calls.mutations, `mode=${mode}`).toHaveLength(0);
		}
	});

	it("POLE 3 — NO credential, typed name, default switch: served exactly as before AND recorded unattributed (no secret in the record)", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		await assertOrdinary(app, "org-a");
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-a",
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(isRefused(json)).toBe(false);
		expect(calls.mutations).toHaveLength(1);
		expect(calls.mutations[0].args).toMatchObject({
			callerOrchestrator: "alice",
		});

		const counts = unattributedClaimCounts();
		expect(counts).toHaveLength(1);
		expect(counts[0]).toMatchObject({ claimed: "alice", count: 1 });
		const records = stderrLines(spy).filter((l) =>
			l.includes("actor.unattributed"),
		);
		expect(records).toHaveLength(1);
		expect(JSON.parse(records[0])).toMatchObject({
			event: "actor.unattributed",
			tool: "complete_task",
			arg: "callerOrchestrator",
			claimed: "alice",
		});
		// Identifiers only: not a bearer, not a credential, not a JWT.
		expect(records[0]).not.toContain(SECRET_ALICE_A);
		expect(records[0]).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
	});

	it("POLE 4 — switch flipped STRICT: the same call is REFUSED (AGENT_CREDENTIAL_REQUIRED), nothing dispatched, nothing recorded", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "strict");
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		await assertOrdinary(app, "org-a");
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-a",
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(isRefused(json)).toBe(true);
		expect(resultText(json)).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(calls.mutations).toHaveLength(0);
		expect(unattributedClaimCounts()).toEqual([]);
		expect(
			stderrLines(spy).filter((l) => l.includes("actor.unattributed")),
		).toEqual([]);
	});

	it("the switch is read at CALL time: one process, flipped between two identical calls, yields served then refused", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const call = () =>
			send(app, "/tool/complete_task", {
				orgId: "org-a",
				body: { ...COMPLETE, callerOrchestrator: "bob" },
			});
		expect(isRefused((await call()).json)).toBe(false);
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "strict");
		expect(isRefused((await call()).json)).toBe(true);
		expect(calls.mutations).toHaveLength(1);
	});

	it("an UNRECOGNISED switch value fails CLOSED to strict (a typo can tighten, never silently loosen)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permisive");
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-a",
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(isRefused(json)).toBe(true);
		expect(resultText(json)).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(calls.mutations).toHaveLength(0);
	});

	it("NO credential and NO typed name: nothing was claimed, so nothing is recorded (the measure counts claims, not silence)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { convex } = buildToolConvex({});
		const app = buildApp(() => convex);
		await send(app, "/tool/complete_task", {
			orgId: "org-a",
			body: COMPLETE,
		});
		// (Whether an org-only caller that omits the name is served is the
		// pre-existing roster path — `String(undefined)` against fromAllowList, the
		// same on main — and is not this switch's concern. The pin is that no
		// CLAIM means no record.)
		expect(unattributedClaimCounts()).toEqual([]);
	});

	it("the org roster still narrows on the compatibility path: a typed name the roster does not admit is refused although the switch is permissive", async () => {
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/complete_task", {
			orgId: "org-c",
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(isRefused(json)).toBe(true);
		expect(resultText(json)).toContain("allowlist");
		expect(calls.mutations).toHaveLength(0);
		expect(unattributedClaimCounts()).toEqual([]);
	});

	it("PIN (not a pole — master is the maintenance identity, named in the header): a master bearer declaring a name is NOT counted as an unattributed agent", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const res = await app.request("http://localhost/tool/complete_task", {
			method: "POST",
			headers: {
				Authorization: "Bearer test-master-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ...COMPLETE, callerOrchestrator: "alice" }),
		});
		expect(res.status).toBe(200);
		expect(calls.mutations).toHaveLength(1);
		expect(unattributedClaimCounts()).toEqual([]);
		expect(
			stderrLines(spy).filter((l) => l.includes("actor.unattributed")),
		).toEqual([]);
	});

	it("a `from`-kind key (store_memory createdBy) is recorded under ITS argument name when served on a typed name", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { json } = await send(app, "/tool/store_memory", {
			orgId: "org-a",
			body: {
				content: "x",
				type: "user",
				namespace: "team/org-a",
				createdBy: "alice",
			},
		});
		expect(isRefused(json)).toBe(false);
		expect(calls.mutations).toHaveLength(1);
		const rec = stderrLines(spy).find((l) => l.includes("actor.unattributed"));
		expect(rec).toBeDefined();
		expect(JSON.parse(rec as string)).toMatchObject({
			tool: "store_memory",
			arg: "createdBy",
			claimed: "alice",
		});
	});

	it("a presented credential that does not resolve is refused at the boundary in permissive mode too (a bad credential never falls back to a typed name)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { convex, calls } = buildToolConvex({});
		const app = buildApp(() => convex);
		const { status } = await send(app, "/tool/complete_task", {
			orgId: "org-a",
			credential: SECRET_INACTIVE,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(status).toBe(401);
		expect(calls.mutations).toHaveLength(0);
	});

	it("the switch is read in exactly ONE place: a single call of actorCredentialMode() outside its definition and comments", () => {
		const walk = (dir: string, out: string[] = []): string[] => {
			for (const e of readdirSync(dir)) {
				const p = join(dir, e);
				if (statSync(p).isDirectory()) {
					if (e !== "__tests__") walk(p, out);
				} else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
			}
			return out;
		};
		const lines = walk(join(__dirname, "..", "src")).flatMap((f) =>
			readFileSync(f, "utf8").split("\n"),
		);
		const callSites = lines.filter(
			(l) =>
				l.includes("actorCredentialMode()") &&
				!l.includes("function actorCredentialMode") &&
				!/^\s*(\/\/|\*)/.test(l),
		);
		expect(callSites).toHaveLength(1);
		const envReads = lines.filter((l) =>
			l.includes("ACTOR_CREDENTIAL_MODE_ENV]"),
		);
		expect(envReads).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// scripts/verify-actor-credentials.ts — the per-actor cutover verification,
// driven through the REAL boundary (bearerAuthMiddleware -> oauthContext ->
// registerTools -> handler) as an ORDINARY org member. Three states, and the
// third (could-not-judge) is asserted as hard as the other two.
// ─────────────────────────────────────────────────────────────────────────────

describe("verify-actor-credentials — two proofs per actor, derived from the server, three states", () => {
	const DAY = 86_400_000;
	type Peer = { id: string; lastSeen: number };

	const NOW = Date.now();
	const IRIS_PEERS: Peer[] = [
		{ id: HELIOS, lastSeen: NOW - 10 * DAY }, // silent ten days: still an agent
		{ id: "marie", lastSeen: NOW - 1 * DAY },
		{ id: "zoe", lastSeen: NOW - 2 * DAY },
	];
	const ALL_SECRETS = [
		SECRET_HELIOS,
		SECRET_MARIE,
		SECRET_ZOE,
		SECRET_INACTIVE,
	];

	function buildIrisConvex(opts: {
		peers: Peer[] | "error";
		failMutation?: (name: string, args: Record<string, unknown>) => boolean;
	}): unknown {
		return {
			query: vi.fn(async (name: string) => {
				if (name === "profiles:listProfiles") {
					if (opts.peers === "error") throw new Error("profiles unavailable");
					return opts.peers.map((p) => ({
						_id: `profile_${p.id}`,
						_creationTime: 1,
						orchestratorId: p.id,
						name: p.id,
						static: { role: "agent", workspace: "iris" },
						dynamic: {
							currentTask: "idle",
							lastSeen: p.lastSeen,
							sessionCount: 1,
						},
					}));
				}
				if (name === "messages:checkNewMessagesEnvelope")
					return { messages: [] };
				throw new Error(`unmocked query: ${name}`);
			}),
			mutation: vi.fn(async (name: string, args: Record<string, unknown>) => {
				if (opts.failMutation?.(name, args))
					throw new Error("operation failed");
				if (name === "tasks:bulkComplete") return { count: 0, sampleIds: [] };
				return { ok: true };
			}),
			action: vi.fn(async () => null),
		};
	}

	/** A Connect whose every session goes through the real HTTP boundary. */
	function pipelineConnect(
		app: Hono,
		orgId: string,
		bearerOverride?: string,
	): Connect {
		return async (credential) => {
			const bearer = bearerOverride ?? (await mintClerkJwt(orgId));
			const headers: Record<string, string> = {
				Authorization: `Bearer ${bearer}`,
				"Content-Type": "application/json",
			};
			if (credential !== undefined) headers[AGENT_HEADER] = credential;
			const probe = await app.request("http://localhost/echo", { headers });
			if (probe.status !== 200) {
				throw new Error(
					`HTTP ${probe.status}: ${JSON.stringify(await probe.json().catch(() => null))}`,
				);
			}
			const client: ToolClient = {
				async callTool(name, args) {
					const res = await app.request(`http://localhost/tool/${name}`, {
						method: "POST",
						headers,
						body: JSON.stringify(args),
					});
					const j = (await res.json()) as {
						result?: { isError?: boolean; content?: { text?: string }[] };
					};
					if (res.status !== 200) {
						return { isError: true, text: `HTTP ${res.status}` };
					}
					return {
						isError: j.result?.isError === true,
						text: j.result?.content?.[0]?.text ?? "",
					};
				},
				close: async () => {},
			};
			return client;
		};
	}

	async function run(
		convex: unknown,
		credentials: Record<string, string>,
		extra: Partial<{
			windowDays: number | "all";
			bearer: string;
			opsFor: (id: string) => ProbeOp[];
		}> = {},
	): Promise<Report> {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const app = buildApp(() => convex);
		return runVerification({
			connect: pipelineConnect(app, "org-iris", extra.bearer),
			credentials,
			secrets: ["test-master-token", ...ALL_SECRETS],
			windowDays: extra.windowDays ?? 45,
			now: NOW,
			opsFor: extra.opsFor,
		});
	}

	const GOOD_CREDS = {
		[HELIOS]: SECRET_HELIOS,
		marie: SECRET_MARIE,
		zoe: SECRET_ZOE,
	};

	it("CLEAN (exit 0): the actor list is what the server returned, byte for byte, including the accented identifier and the agent silent for ten days", async () => {
		const r = await run(buildIrisConvex({ peers: IRIS_PEERS }), GOOD_CREDS);
		expect(r.state).toBe("clean");
		expect(r.exit).toBe(0);
		expect(r.actors.map((a) => a.id).sort()).toEqual([HELIOS, "marie", "zoe"]);
		expect(r.actors.some((a) => a.id === HELIOS)).toBe(true);
		// the identifier is the accented one, NOT the typed ASCII spelling
		expect(r.actors.some((a) => a.id === "helios")).toBe(false);
		for (const a of r.actors) {
			expect(a.proof1Resolves, a.id).toBe(true);
			expect(a.proof2Operates, a.id).toBe(true);
			expect(a.ops.length).toBeGreaterThanOrEqual(2);
		}
		expect(r.orphanCredentialKeys).toEqual([]);
	});

	it("CLEAN holds under the strict switch too: the verification is exactly what must pass before Deployment B", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "strict");
		const r = await run(buildIrisConvex({ peers: IRIS_PEERS }), GOOD_CREDS);
		expect(r.state).toBe("clean");
		expect(r.exit).toBe(0);
	});

	it("ACCUSED (exit 1): a credentials file keyed on the TYPED spelling provisions nothing — the accented actor is accused, with the near-miss named", async () => {
		const r = await run(buildIrisConvex({ peers: IRIS_PEERS }), {
			helios: SECRET_HELIOS,
			marie: SECRET_MARIE,
			zoe: SECRET_ZOE,
		});
		expect(r.exit).toBe(1);
		const helios = r.actors.find((a) => a.id === HELIOS);
		expect(helios?.state).toBe("accused");
		expect(helios?.findings.join(" ")).toContain(
			"differs from it only by accents/case",
		);
		expect(r.orphanCredentialKeys).toEqual(["helios"]);
		// the other two are still judged on their own merits
		expect(
			r.actors
				.filter((a) => a.state === "clean")
				.map((a) => a.id)
				.sort(),
		).toEqual(["marie", "zoe"]);
	});

	it("ACCUSED: proof 1 — a credential filed under the wrong actor resolves to ANOTHER identifier and is named as such", async () => {
		const r = await run(buildIrisConvex({ peers: IRIS_PEERS }), {
			...GOOD_CREDS,
			zoe: SECRET_MARIE, // marie's credential filed for zoe
		});
		expect(r.exit).toBe(1);
		const zoe = r.actors.find((a) => a.id === "zoe");
		expect(zoe?.proof1Resolves).toBe(false);
		expect(zoe?.findings.join(" ")).toContain('"marie"');
	});

	it("ACCUSED: proof 1 — a credential the boundary refuses (unknown / rotated-out / inactive) is an accusation, not a silence", async () => {
		const r = await run(buildIrisConvex({ peers: IRIS_PEERS }), {
			...GOOD_CREDS,
			zoe: SECRET_INACTIVE,
		});
		expect(r.exit).toBe(1);
		const zoe = r.actors.find((a) => a.id === "zoe");
		expect(zoe?.state).toBe("accused");
		expect(zoe?.proof1Resolves).toBe(false);
	});

	it("ACCUSED: proof 2 — the credential RESOLVES (proof 1 true) but the actor's real operation FAILS under it: identity proven, work not", async () => {
		const ops = (id: string): ProbeOp[] =>
			id === "zoe"
				? [
						{
							name: "zoe's real write (complete_task)",
							tool: "complete_task",
							args: {
								taskId: "k1",
								completionNote: "verification",
								callerOrchestrator: "$ACTOR",
							},
						},
					]
				: [];
		const convex = buildIrisConvex({
			peers: IRIS_PEERS,
			failMutation: (name) => name !== "tasks:bulkComplete",
		});
		const r = await run(convex, GOOD_CREDS, { opsFor: ops });
		expect(r.exit).toBe(1);
		const zoe = r.actors.find((a) => a.id === "zoe");
		expect(zoe?.proof1Resolves).toBe(true);
		expect(zoe?.proof2Operates).toBe(false);
		expect(zoe?.ops.find((o) => !o.ok)?.name).toContain("complete_task");
		expect(r.actors.find((a) => a.id === "marie")?.state).toBe("clean");
	});

	it("COULD-NOT-JUDGE (exit 2): the server lists no actors — an empty list is a failure to read, never a clean zero", async () => {
		const r = await run(buildIrisConvex({ peers: [] }), GOOD_CREDS);
		expect(r.state).toBe("could-not-judge");
		expect(r.exit).toBe(2);
		expect(r.actors).toEqual([]);
		expect(r.refusal).toBeDefined();
	});

	it("COULD-NOT-JUDGE: list_peers itself errors", async () => {
		const r = await run(buildIrisConvex({ peers: "error" }), GOOD_CREDS);
		expect(r.state).toBe("could-not-judge");
		expect(r.exit).toBe(2);
	});

	it("COULD-NOT-JUDGE: every actor is outside the window — the instrument does not let a short window define the population", async () => {
		const stale = IRIS_PEERS.map((p) => ({ ...p, lastSeen: NOW - 400 * DAY }));
		const r = await run(buildIrisConvex({ peers: stale }), GOOD_CREDS, {
			windowDays: 45,
		});
		expect(r.exit).toBe(2);
		const all = await run(buildIrisConvex({ peers: stale }), GOOD_CREDS, {
			windowDays: "all",
		});
		expect(all.exit).toBe(0);
		expect(all.actors).toHaveLength(3);
	});

	it("WINDOW: an agent silent for ten days is inside the default window; one silent for 400 days is listed as EXCLUDED, not hidden", async () => {
		const peers: Peer[] = [
			...IRIS_PEERS,
			{ id: "old-bot", lastSeen: NOW - 400 * DAY },
		];
		const r = await run(buildIrisConvex({ peers }), GOOD_CREDS);
		expect(r.exit).toBe(0);
		expect(r.actors.map((a) => a.id)).toContain(HELIOS);
		expect(r.excluded.map((e) => e.id)).toEqual(["old-bot"]);
		expect(renderReport(r)).toContain("old-bot");
	});

	it("COULD-NOT-JUDGE: the presented bearer is MASTER — a proof under the maintenance identity exercises the bypass, so nothing is certified", async () => {
		const r = await run(buildIrisConvex({ peers: IRIS_PEERS }), GOOD_CREDS, {
			bearer: "test-master-token",
		});
		expect(r.exit).toBe(2);
		expect(r.actors.every((a) => a.state === "could-not-judge")).toBe(true);
		expect(r.actors[0]?.findings.join(" ")).toContain("MASTER");
	});

	it("COULD-NOT-JUDGE: the server does not bind the credential (control not refused) — a served call proves nothing", async () => {
		const stub: Connect = async (credential) => ({
			async callTool(name, args) {
				if (name === "list_peers") {
					return {
						isError: false,
						text: JSON.stringify([
							{ id: "marie", lastSeen: new Date(NOW).toISOString() },
						]),
					};
				}
				if (name === "whoami")
					return {
						isError: false,
						text: JSON.stringify({ scope_profile_name: "team-member" }),
					};
				// an old server: serves ANY typed name, control included
				void credential;
				void args;
				return { isError: false, text: JSON.stringify({ count: 0 }) };
			},
			close: async () => {},
		});
		const r = await runVerification({
			connect: stub,
			credentials: { marie: SECRET_MARIE },
			secrets: [SECRET_MARIE],
			windowDays: 45,
			now: NOW,
		});
		expect(r.exit).toBe(2);
		expect(r.actors[0]?.state).toBe("could-not-judge");
		expect(r.actors[0]?.findings.join(" ")).toContain(
			"NOT refused AGENT_IDENTITY_MISMATCH",
		);
		expect(CONTROL_NAME).not.toBe("marie");
	});

	it("NEVER prints a secret: neither the report nor its findings contain any credential or the bearer", async () => {
		const r = await run(buildIrisConvex({ peers: IRIS_PEERS }), {
			helios: SECRET_HELIOS,
			marie: SECRET_MARIE,
			zoe: SECRET_INACTIVE,
		});
		const text = renderReport(r) + JSON.stringify(r);
		for (const secret of [...ALL_SECRETS, "test-master-token"]) {
			expect(text).not.toContain(secret);
		}
	});

	it("deriveActors pages through EVERY page and dedupes by exact identifier (a second instance of one orchestrator is one actor)", async () => {
		const pages: Record<string, unknown> = {
			"": {
				items: [
					{ id: HELIOS, lastSeen: new Date(NOW).toISOString() },
					{ id: "marie", lastSeen: new Date(NOW).toISOString() },
				],
				nextCursor: "c1",
			},
			c1: {
				items: [
					{ id: "marie", lastSeen: new Date(NOW).toISOString() },
					{ id: "zoe", lastSeen: new Date(NOW).toISOString() },
				],
			},
		};
		const seen: unknown[] = [];
		const client: ToolClient = {
			async callTool(_n, args) {
				seen.push(args.cursor ?? "");
				return {
					isError: false,
					text: JSON.stringify(pages[(args.cursor as string) ?? ""]),
				};
			},
			close: async () => {},
		};
		const d = await deriveActors(client, { windowDays: "all", now: NOW });
		expect(seen).toEqual(["", "c1"]);
		expect(d.actors.map((a) => a.id)).toEqual([HELIOS, "marie", "zoe"]);
	});

	it("deriveActors REFUSES an unparseable (truncated) list rather than reading it as empty", async () => {
		const client: ToolClient = {
			callTool: async () => ({
				isError: false,
				text: '[{"id":"marie","lastSe… [truncated]',
			}),
			close: async () => {},
		};
		await expect(
			deriveActors(client, { windowDays: "all", now: NOW }),
		).rejects.toThrow(/did not return JSON/);
	});
});

describe("S2 identity binding — the credential binding compares through normalizeOrchestratorId, as every sibling gate does", () => {
	const actorCtx = (agentName: string): OAuthContext => ({
		clientId: "client-iris",
		userId: "user-iris",
		scopes: ["vantage:read"],
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 60_000,
		isMaster: false,
		actor: { orgSlug: "iris", agentName },
	});
	const NFD_HELIOS_CAPITAL = "H\u0065\u0301lios"; // "H" + e + combining acute
	const ctx = actorCtx(HELIOS);

	it("credential hélios ACCEPTS Hélios (composed)", () => {
		expect(checkActorBinding(ctx, "H\u00e9lios")).toBeNull();
	});
	it("credential hélios ACCEPTS the NFD-decomposed Hélios", () => {
		expect(NFD_HELIOS_CAPITAL.normalize("NFC")).not.toBe(NFD_HELIOS_CAPITAL);
		expect(checkActorBinding(ctx, NFD_HELIOS_CAPITAL)).toBeNull();
	});
	it("credential hélios still REFUSES clio", () => {
		expect(checkActorBinding(ctx, "clio")).toMatch(/^AGENT_IDENTITY_MISMATCH/);
	});
	it("credential hélios still REFUSES victor", () => {
		expect(checkActorBinding(ctx, "victor")).toMatch(
			/^AGENT_IDENTITY_MISMATCH/,
		);
	});
	it('"*" as the claimed name is REFUSED, not matched', () => {
		expect(checkActorBinding(ctx, "*")).toMatch(/^AGENT_IDENTITY_MISMATCH/);
	});
	it("the refusal names the spelling the caller PRESENTED, not the normalised form", () => {
		const msg = checkActorBinding(ctx, "CLIO") ?? "";
		expect(msg).toContain('names "CLIO"');
		expect(msg).not.toContain('names "clio"');
	});
});
