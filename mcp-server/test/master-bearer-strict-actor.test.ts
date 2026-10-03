/**
 * MCP strict for FLEET (master-bearer) callers only.
 *
 * task k17573xwj0g0kf1fsfntrn3h2d8d30y8 item (1). VantagePeers Cloud.
 *
 * A request on the master bearer (the fleet service account) that names an
 * acting agent (callerOrchestrator / from / createdBy ...) MUST present the
 * per-agent credential header: the master bearer authenticates the fleet, not
 * an agent, so a typed name is only a claim. This holds regardless of
 * VANTAGE_ACTOR_CREDENTIAL_MODE. Customer OAuth clients (non-master) follow the
 * switch: strict by default, served without a header only when it is set to
 * "permissive" explicitly.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	bearerAuthMiddleware,
	LOCAL_STDIO_TRUST_CTX,
	type OAuthContext,
	sha256Hex,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const MASTER = "test-master-token";
const HEADER = "x-vantage-agent-credential";
const SECRET_ALICE = "secret-alice-fleet";
const OAUTH_TOKEN = "customer-oauth-token";
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
					return { orgSlug: "fleet", agentName: "alice" };
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
	app: Hono,
	tool: string,
	opts: { bearer: string; credential?: string; body?: unknown },
): Promise<{ status: number; json: Record<string, unknown> }> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${opts.bearer}`,
		"Content-Type": "application/json",
	};
	if (opts.credential !== undefined) headers[HEADER] = opts.credential;
	const res = await app.request(`http://localhost/tool/${tool}`, {
		method: "POST",
		headers,
		body: JSON.stringify(opts.body ?? {}),
	});
	return { status: res.status, json: (await res.json()) as never };
}

const textOf = (json: Record<string, unknown>): string =>
	(json.result as { content?: Array<{ text?: string }> } | undefined)
		?.content?.[0]?.text ?? "";
const refused = (json: Record<string, unknown>): boolean =>
	(json.result as { isError?: boolean } | undefined)?.isError === true;

beforeEach(async () => {
	process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
	OAUTH_ROWS[await sha256Hex(OAUTH_TOKEN)] = {
		clientId: "customer-client",
		userId: "user-x",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "team-member",
		fromAllowList: ["alice"],
		namespaceReadPrefixes: ["team/fleet"],
		namespaceWritePrefixes: ["team/fleet"],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: "fleet",
	};
	installInternalClient();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	_resetUnattributedClaimsForTest();
	_setInternalClientForTest(null);
});

describe("master bearer is strict for acting names, whatever the env mode", () => {
	for (const mode of [undefined, "permissive", "strict"]) {
		it(`REFUSED: master bearer + acting name + NO header (mode=${mode ?? "unset"}), coded, names the header, nothing dispatched`, async () => {
			if (mode !== undefined) vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", mode);
			const { convex, mutations } = buildConvex();
			const { status, json } = await post(buildApp(convex), "complete_task", {
				bearer: MASTER,
				body: { ...COMPLETE, callerOrchestrator: "alice" },
			});
			expect(status).toBe(200);
			expect(refused(json)).toBe(true);
			expect(textOf(json)).toContain("AGENT_CREDENTIAL_REQUIRED");
			expect(textOf(json)).toContain(HEADER);
			expect(mutations).toHaveLength(0);
		});
	}

	it("REFUSED: a `from`-kind key (store_memory createdBy) on master + no header", async () => {
		const { convex, mutations } = buildConvex();
		const { json } = await post(buildApp(convex), "store_memory", {
			bearer: MASTER,
			body: {
				content: "x",
				type: "user",
				namespace: "team/fleet",
				createdBy: "alice",
			},
		});
		expect(refused(json)).toBe(true);
		expect(textOf(json)).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(mutations).toHaveLength(0);
	});

	it("SERVED: master bearer + valid header + the SAME name -> served, bound", async () => {
		const { convex, mutations } = buildConvex();
		const { status, json } = await post(buildApp(convex), "complete_task", {
			bearer: MASTER,
			credential: SECRET_ALICE,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(status).toBe(200);
		expect(refused(json)).toBe(false);
		expect(mutations).toHaveLength(1);
	});

	it("REFUSED: master bearer + valid header + ANOTHER agent's name -> AGENT_IDENTITY_MISMATCH (binding kept)", async () => {
		const { convex, mutations } = buildConvex();
		const { json } = await post(buildApp(convex), "complete_task", {
			bearer: MASTER,
			credential: SECRET_ALICE,
			body: { ...COMPLETE, callerOrchestrator: "bob" },
		});
		expect(refused(json)).toBe(true);
		expect(textOf(json)).toContain("AGENT_IDENTITY_MISMATCH");
		expect(mutations).toHaveLength(0);
	});

	it("401: master bearer + FORGED header -> refused at the boundary", async () => {
		const { convex } = buildConvex();
		const { status } = await post(buildApp(convex), "complete_task", {
			bearer: MASTER,
			credential: "forged",
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(status).toBe(401);
	});

	it("SERVED: master bearer + no header + NO acting name (no claim made) -> unchanged", async () => {
		const { convex, mutations } = buildConvex();
		const { json } = await post(buildApp(convex), "complete_task", {
			bearer: MASTER,
			body: COMPLETE,
		});
		expect(refused(json)).toBe(false);
		expect(mutations).toHaveLength(1);
	});

	it("SERVED (unchanged): local stdio trust context is NOT a bearer and keeps declaring names", async () => {
		const { convex, mutations } = buildConvex();
		const { server, tools } = fakeServer();
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		registerTools(server, convex as any, LOCAL_STDIO_TRUST_CTX);
		const res = (await (tools.get("complete_task") as Handler)({
			...COMPLETE,
			callerOrchestrator: "alice",
		})) as { isError?: boolean };
		expect(res.isError).not.toBe(true);
		expect(mutations).toHaveLength(1);
	});
});

describe("customer OAuth client (non-master) is unchanged", () => {
	it("SERVED: OAuth client + no header + acting name, switch explicitly permissive -> served", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { convex, mutations } = buildConvex();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { json } = await post(buildApp(convex), "complete_task", {
			bearer: OAUTH_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(refused(json)).toBe(false);
		expect(mutations).toHaveLength(1);
	});

	it("env mode still governs non-master: strict -> OAuth client + no header naming ANOTHER agent REFUSED", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "strict");
		const { convex, mutations } = buildConvex();
		const { json } = await post(buildApp(convex), "complete_task", {
			bearer: OAUTH_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "bob" },
		});
		expect(refused(json)).toBe(true);
		expect(textOf(json)).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(mutations).toHaveLength(0);
	});

	it("strict: this client's row is a single-name seat (['alice']) naming ITSELF -> SERVED by the seat exemption", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "strict");
		const { convex, mutations } = buildConvex();
		const { json } = await post(buildApp(convex), "complete_task", {
			bearer: OAUTH_TOKEN,
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(refused(json)).toBe(false);
		expect(mutations).toHaveLength(1);
	});
});

describe("whoami reports the verified actor", () => {
	async function who(bearer: string, credential?: string) {
		const { convex } = buildConvex();
		const { json } = await post(buildApp(convex), "whoami", {
			bearer,
			credential,
		});
		return JSON.parse(textOf(json)) as { actor?: unknown };
	}

	it("master + valid header -> actor { agentName, orgSlug }; secret never printed", async () => {
		const out = await who(MASTER, SECRET_ALICE);
		expect(out.actor).toEqual({ agentName: "alice", orgSlug: "fleet" });
		expect(JSON.stringify(out)).not.toContain(SECRET_ALICE);
	});

	it("master + no header -> actor: null", async () => {
		const out = await who(MASTER);
		expect(out.actor).toBeNull();
	});

	it("customer OAuth + no header -> actor: null", async () => {
		const out = await who(OAUTH_TOKEN);
		expect(out.actor).toBeNull();
	});
});
