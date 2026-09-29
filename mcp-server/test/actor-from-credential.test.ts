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
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
} from "../src/auth.js";
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
};

// What agentCredentials:resolveAgentCredential returns per presented secret.
// An inactive agent resolves to null (the Convex core refuses it).
const CREDENTIALS: Record<
	string,
	{ orgSlug: string; agentName: string } | null
> = {
	[SECRET_ALICE_A]: { orgSlug: "org-a", agentName: "alice" },
	[SECRET_BOB_A]: { orgSlug: "org-a", agentName: "bob" },
	[SECRET_ALICE_B]: { orgSlug: "org-b", agentName: "alice" },
	[SECRET_ALICE_C]: { orgSlug: "org-c", agentName: "alice" },
	[SECRET_INACTIVE]: null,
};

function installInternalClient(): void {
	const fake = {
		query: async (name: string, args: unknown) => {
			if (name === "oauth:getAccessTokenByHash") return null;
			if (name === "clientOrgMapping:getByClerkSlug") {
				const { orgSlug } = args as { orgSlug: string };
				return MAPPINGS[orgSlug] ?? null;
			}
			if (name === "agentCredentials:resolveAgentCredential") {
				const { presentedSecret } = args as { presentedSecret: string };
				if (presentedSecret === SECRET_LOOKUP_THROWS) {
					throw new Error("convex unavailable");
				}
				return CREDENTIALS[presentedSecret] ?? null;
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
		credential?: string;
		method?: "GET" | "POST";
		body?: unknown;
	},
): Promise<{ status: number; json: Wire }> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${await mintClerkJwt(opts.orgId)}`,
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

	it("DENY: a lookup that THROWS is a refusal, never a fall-through to an org-only grant", async () => {
		const app = buildApp(() => buildToolConvex({}).convex);
		const { status } = await send(app, "/echo", {
			orgId: "org-a",
			credential: SECRET_LOOKUP_THROWS,
		});
		expect(status).toBe(401);
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

	it("DENY: an org-only token (no agent credential) naming an agent is REFUSED — a name typed is not an identity", async () => {
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
		});
	}
});
