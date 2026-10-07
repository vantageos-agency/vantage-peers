/**
 * Every agent carries its unique ID end to end (Pi ruling (c)/(e),
 * k174d95s5qqy8t2r5rdrz3pr3d8fqv82). VantagePeers Cloud (multi-tenant).
 *
 * The MCP forwards IDs only. Which agent a call acts as is decided on the
 * agents-row ID the bearer resolved to (a credential's agentId, or the stamp on
 * a one-agent seat token), never on the name a caller typed. The typed name is
 * only checked to EQUAL the resolved agent's name, or omitted.
 *
 * Poles, each through bearerAuthMiddleware + a real tool, both directions:
 *   SEAT BY ID      a seat for clio-iris-rh acts as clio; the call carries
 *                   verifiedActor { agentId, orgSlug } to the Convex door.
 *   OTHER ORG       the same name from another org's seat (no agent of that name
 *                   in its own org -> no stamp) is refused.
 *   ORG-LEVEL SEAT  a seat that resolved no agent, naming an agent: refused.
 *   MISMATCH        a stamped seat typing another name: refused, in EVERY mode.
 *   CREDENTIAL      a credential's agentId flows to the door.
 *   OLD CONVEX      a provider that predates the stamp keeps working (reader-first).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	bearerAuthMiddleware,
	checkActorBinding,
	isSeatActingAsItself,
	type OAuthContext,
	sha256Hex,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import {
	VERIFIED_ACTOR_DOORS,
	withVerifiedActor,
} from "../src/verifiedActor.js";

const HEADER = "x-vantage-agent-credential";
const COMPLETE = { taskId: "k1", completionNote: "done" };

const CLIO_ID = "agentclio0000000000000000000001";
const ALICE_ID = "agentalice000000000000000000001";

const TOKENS = {
	clioSeat: "seat-clio-iris-rh",
	otherOrgSeat: "seat-clio-other-org",
	orgLevelSeat: "seat-orglevel",
	spoofedStamp: "seat-spoofed-stamp",
	oldConvexSeat: "seat-old-convex",
	team: "team-token",
} as const;

const ROWS: Record<string, Record<string, unknown>> = {};
let credentialAnswer: Record<string, unknown> | null = null;

function installInternalClient(): void {
	const fake = {
		query: async (name: string, args: unknown) => {
			if (name === "oauth:getAccessTokenByHash") {
				return ROWS[(args as { tokenHash: string }).tokenHash] ?? null;
			}
			if (name === "agentCredentials:resolveAgentCredential") {
				if (credentialAnswer !== null) return credentialAnswer;
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
	const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
	const convex = {
		query: vi.fn(async () => null),
		mutation: vi.fn(async (name: string, args: Record<string, unknown>) => {
			mutations.push({ name, args });
			return { ok: true };
		}),
		action: vi.fn(async () => null),
	};
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
	credentialAnswer = null;
	_resetUnattributedClaimsForTest();
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
	const base = {
		userId: "user-x",
		scopes: ["vantage:read", "vantage:write"],
		expiresAt: Date.now() + 3_600_000,
	};
	const seat = (name: string, org: string) => ({
		...base,
		clientId: `client-${name}-${org}`,
		scopeProfile: `${name}-${org}`,
		fromAllowList: [name],
		namespaceReadPrefixes: [`orchestrator/${name}`],
		namespaceWritePrefixes: [`orchestrator/${name}`],
		clerkOrgSlug: org,
	});
	ROWS[await sha256Hex(TOKENS.clioSeat)] = {
		...seat("clio", "iris-rh"),
		seatAgent: { agentId: CLIO_ID, orgId: "iris-rh", agentName: "clio" },
	};
	// The Convex stamp said NONE for this profile: it resolved no agent of its own org.
	ROWS[await sha256Hex(TOKENS.otherOrgSeat)] = {
		...seat("clio", "other-org"),
		seatAgent: null,
	};
	ROWS[await sha256Hex(TOKENS.orgLevelSeat)] = {
		...seat("clio", "iris-rh"),
		seatAgent: null,
	};
	// A stamp whose org is not the token's own org: never believed.
	ROWS[await sha256Hex(TOKENS.spoofedStamp)] = {
		...seat("clio", "other-org"),
		seatAgent: { agentId: CLIO_ID, orgId: "iris-rh", agentName: "clio" },
	};
	// A provider that predates the stamp: the key is absent altogether.
	ROWS[await sha256Hex(TOKENS.oldConvexSeat)] = seat("clio", "iris-rh");
	ROWS[await sha256Hex(TOKENS.team)] = {
		...base,
		clientId: "team-client",
		scopeProfile: "team-member",
		fromAllowList: ["alice", "clio"],
		namespaceReadPrefixes: ["team/iris-rh"],
		namespaceWritePrefixes: ["team/iris-rh"],
		clerkOrgSlug: "iris-rh",
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

describe("a seat acts as its agent BY ID", () => {
	it("a seat for clio-iris-rh naming clio is served and the door receives clio's ID and org", async () => {
		const r = await post("complete_task", {
			bearer: TOKENS.clioSeat,
			body: { ...COMPLETE, callerOrchestrator: "clio" },
		});
		expect(r.refused).toBe(false);
		expect(r.mutations).toHaveLength(1);
		expect(r.mutations[0].name).toBe("tasks:complete");
		expect(r.mutations[0].args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: "iris-rh",
		});
	});

	it("the same seat omitting the name acts as clio: the name is derived from the resolved agent", async () => {
		const r = await post("complete_task", {
			bearer: TOKENS.clioSeat,
			body: COMPLETE,
		});
		expect(r.refused).toBe(false);
		expect(r.mutations[0].args.callerOrchestrator).toBe("clio");
		expect(r.mutations[0].args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: "iris-rh",
		});
	});

	it("a stamped seat typing ANOTHER name is refused, nothing dispatched", async () => {
		const r = await post("complete_task", {
			bearer: TOKENS.clioSeat,
			body: { ...COMPLETE, callerOrchestrator: "victor" },
		});
		expect(r.refused).toBe(true);
		expect(r.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(r.mutations).toHaveLength(0);
	});

	it("...and in permissive mode too: a resolved agent is never overridden by a typed name", async () => {
		process.env[ACTOR_CREDENTIAL_MODE_ENV] = "permissive";
		const r = await post("complete_task", {
			bearer: TOKENS.clioSeat,
			body: { ...COMPLETE, callerOrchestrator: "victor" },
		});
		expect(r.refused).toBe(true);
		expect(r.text).toContain("AGENT_IDENTITY_MISMATCH");
	});

	it("a rename is followed: the typed OLD label is refused, the new label (current name) is served", async () => {
		ROWS[await sha256Hex(TOKENS.clioSeat)] = {
			...ROWS[await sha256Hex(TOKENS.clioSeat)],
			seatAgent: { agentId: CLIO_ID, orgId: "iris-rh", agentName: "clio-2" },
		};
		const old = await post("complete_task", {
			bearer: TOKENS.clioSeat,
			body: { ...COMPLETE, callerOrchestrator: "clio" },
		});
		expect(old.refused).toBe(true);
	});
});

describe("a seat that resolved no agent cannot act as one", () => {
	it("the same name from ANOTHER org's seat is refused", async () => {
		const r = await post("complete_task", {
			bearer: TOKENS.otherOrgSeat,
			body: { ...COMPLETE, callerOrchestrator: "clio" },
		});
		expect(r.refused).toBe(true);
		expect(r.text).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(r.mutations).toHaveLength(0);
	});

	it("an org-level seat naming an agent is refused", async () => {
		const r = await post("complete_task", {
			bearer: TOKENS.orgLevelSeat,
			body: { ...COMPLETE, callerOrchestrator: "clio" },
		});
		expect(r.refused).toBe(true);
		expect(r.text).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(r.mutations).toHaveLength(0);
	});

	it("a stamp naming an org other than the token's own org is not believed", async () => {
		const r = await post("complete_task", {
			bearer: TOKENS.spoofedStamp,
			body: { ...COMPLETE, callerOrchestrator: "clio" },
		});
		expect(r.refused).toBe(true);
		expect(r.mutations).toHaveLength(0);
	});

	it("isSeatActingAsItself decides on the stamp, not on the allowlist or the name", () => {
		const row: OAuthContext = {
			clientId: "c",
			userId: "u",
			scopes: [],
			scopeProfile: "clio-iris-rh",
			fromAllowList: ["clio"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: 0,
			isMaster: false,
			accessTokenHash: "h",
			clerkOrgSlug: "iris-rh",
			seatAgent: { agentId: CLIO_ID, orgId: "iris-rh", agentName: "clio" },
		};
		expect(isSeatActingAsItself(row, "clio")).toBe(true);
		expect(isSeatActingAsItself(row, "victor")).toBe(false);
		expect(isSeatActingAsItself({ ...row, seatAgent: null }, "clio")).toBe(
			false,
		);
		expect(
			isSeatActingAsItself(
				{ ...row, seatAgent: { ...row.seatAgent!, orgId: "other-org" } },
				"clio",
			),
		).toBe(false);
		expect(checkActorBinding({ ...row, seatAgent: null }, "clio")).toContain(
			"AGENT_CREDENTIAL_REQUIRED",
		);
	});
});

describe("a credential's agentId flows to the door", () => {
	it("team bearer + agent credential: tasks:complete receives { agentId, orgSlug }", async () => {
		credentialAnswer = {
			orgSlug: "iris-rh",
			agentName: "alice",
			agentId: ALICE_ID,
		};
		const r = await post("complete_task", {
			bearer: TOKENS.team,
			credential: "secret-alice",
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(r.refused).toBe(false);
		expect(r.mutations[0].args.verifiedActor).toEqual({
			agentId: ALICE_ID,
			orgSlug: "iris-rh",
		});
	});
});

describe("reader-first: an older Convex keeps working", () => {
	it("a provider that returns no stamp serves the seat as before and forwards no actor", async () => {
		const r = await post("complete_task", {
			bearer: TOKENS.oldConvexSeat,
			body: { ...COMPLETE, callerOrchestrator: "clio" },
		});
		expect(r.refused).toBe(false);
		expect(r.mutations[0].args).not.toHaveProperty("verifiedActor");
	});

	it("a credential answer without agentId forwards no actor", async () => {
		credentialAnswer = { orgSlug: "iris-rh", agentName: "alice" };
		const r = await post("complete_task", {
			bearer: TOKENS.team,
			credential: "secret-alice",
			body: { ...COMPLETE, callerOrchestrator: "alice" },
		});
		expect(r.refused).toBe(false);
		expect(r.mutations[0].args).not.toHaveProperty("verifiedActor");
	});
});

describe("withVerifiedActor", () => {
	const ctx: OAuthContext = {
		clientId: "c",
		userId: "u",
		scopes: [],
		scopeProfile: "p",
		fromAllowList: ["clio"],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: 0,
		isMaster: false,
		accessTokenHash: "h",
		clerkOrgSlug: "iris-rh",
		seatAgent: { agentId: CLIO_ID, orgId: "iris-rh", agentName: "clio" },
	};
	const fakeClient = () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		return {
			calls,
			client: {
				mutation: async (name: string, args: Record<string, unknown>) => {
					calls.push({ name, args });
					return null;
				},
				query: async () => null,
			},
		};
	};

	it("returns the very same client when no agent is resolved", () => {
		const { client } = fakeClient();
		expect(withVerifiedActor(client, { ...ctx, seatAgent: null })).toBe(client);
		expect(withVerifiedActor(client, undefined)).toBe(client);
	});

	it("never forwards on a Clerk-JWT session (the caller's own client is not the service account)", () => {
		const { client } = fakeClient();
		expect(withVerifiedActor(client, { ...ctx, clerkJwt: "jwt" })).toBe(client);
	});

	it("only touches doors that take a verifiedActor; others pass through untouched", async () => {
		const { client, calls } = fakeClient();
		const wrapped = withVerifiedActor(client, ctx);
		await wrapped.mutation("memories:store", { a: 1 });
		await wrapped.mutation("tasks:complete", { taskId: "k1" });
		expect(calls[0].args).toEqual({ a: 1 });
		expect(calls[1].args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: "iris-rh",
		});
	});

	it("messages:sendMessage without a sender is not given an agent proof (that is the person path)", async () => {
		const { client, calls } = fakeClient();
		const wrapped = withVerifiedActor(client, ctx);
		await wrapped.mutation("messages:sendMessage", { channel: "pi" });
		await wrapped.mutation("messages:sendMessage", { channel: "pi", from: "clio" });
		expect(calls[0].args).not.toHaveProperty("verifiedActor");
		expect(calls[1].args).toHaveProperty("verifiedActor");
	});

	it("does not overwrite a proof the call already carries", async () => {
		const { client, calls } = fakeClient();
		const wrapped = withVerifiedActor(client, ctx);
		await wrapped.mutation("tasks:complete", {
			taskId: "k1",
			verifiedPerson: { accessTokenHash: "x" },
		});
		expect(calls[0].args).not.toHaveProperty("verifiedActor");
	});

	it("the door set is exactly the Convex doors that declare verifiedActor", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const declared = new Set<string>();
		for (const file of ["tasks", "messages"]) {
			const src = readFileSync(
				resolve(__dirname, `../../convex/${file}.ts`),
				"utf8",
			);
			let current = "";
			for (const line of src.split("\n")) {
				const m = line.match(/^export const (\w+) = (?:mutation|query)\(/);
				if (m) current = m[1];
				// tasks:create shares its args through a named validator object.
				if (/^const createTaskArgsValidatorWithCredential\b/.test(line)) {
					current = "create";
				}
				if (/verifiedActor: v\.optional\(verifiedActorValidator\)/.test(line)) {
					declared.add(`${file}:${current}`);
				}
			}
		}
		for (const door of VERIFIED_ACTOR_DOORS) {
			expect(declared.has(door), `${door} declares verifiedActor`).toBe(true);
		}
	});
});
