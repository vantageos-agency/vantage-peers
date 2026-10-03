/**
 * PERSON_TOKEN_WRITER_ROLE — a person who signs in through /authorize keeps the
 * org role Clerk verified, and a viewer may read but not write.
 *
 * Before this change the minted token dropped `orgRole`: a viewer acted with the
 * whole organisation roster (a granted read became an inferred write).
 *
 * The gate lives ONCE, in defineTool (src/registerTool.ts), for every tool not
 * declared `readOnlyHint: true`, and reuses Convex's existing writer-role pair
 * (`loadMemberWriterRoles` + `assertMemberMayWrite`) through
 * `memberWriterRoles:assertPersonMayWrite`.
 *
 * Harness: the real Hono app and real Convex functions (convex-test). The token
 * is minted by the real authorize flow; the tool context is built from the row
 * the bearer middleware reads (`oauth:getAccessTokenByHash`).
 */

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../../convex/schema";
import { app } from "../server-http.js";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
	sha256Base64Url,
	sha256Hex,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import {
	authorizeAsPerson,
	type Harness,
	installAuthorizeHarness,
	membership,
} from "./lib/authorizeHarness.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);

const SERVICE_ACCOUNT_ID = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const REDIRECT = "https://client.example/callback";
const CLIENT_ID = "client-claude";
const CLIENT_SECRET = "client-secret-raw";
const VERIFIER = "role-test-verifier-0123456789-0123456789-0123456789";

type T = ReturnType<typeof convexTest<typeof schema>>;

function bridge(t: T) {
	return {
		query: (name: string, args: Record<string, unknown>) =>
			t.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			t.mutation(
				makeFunctionReference<"mutation">(name) as never,
				args as never,
			),
	};
}

let t: T;
let harness: Harness;
let challenge: string;

beforeEach(async () => {
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_clients", {
			clientId: CLIENT_ID,
			clientSecretHash: await sha256Hex(CLIENT_SECRET),
			redirectUris: [REDIRECT],
			name: "Claude",
			scopeProfile: "client-generic",
			createdAt: now,
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["agent-a"],
			scopes: ["vantage:read", "vantage:write"],
			displayName: "a",
			isActive: true,
			createdAt: now,
		});
		// fleet default writer roles (the same row an operator sets)
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
	});
	for (const [user, role] of [
		["user_viewer", "org:viewer"],
		["user_editor", "org:editor"],
		["user_admin", "org:admin"],
	] as const) {
		harness.setMemberships(user, [membership("org_A", "org-a", role)]);
	}
});

afterEach(() => {
	harness.restore();
	_setInternalClientForTest(null);
	vi.unstubAllEnvs();
});

/**
 * A REAL per-agent credential for org-a's roster agent "agent-a", minted the
 * way an org admin mints it (agents:registerAgent + agentCredentials:mintAgentCredential).
 * Strict is the default (k175v22zc52w1cbvq1d1qps50d8fccpg): a person naming an
 * agent must present it.
 */
async function agentCredential(): Promise<string> {
	const admin = bridge(
		t.withIdentity({
			subject: "admin-of-org-a",
			org_slug: "org-a",
			org_role: "org:admin",
		} as never),
	);
	await admin.mutation("agents:registerAgent", {
		orgSlug: "org-a",
		name: "agent-a",
	});
	const minted = (await admin.mutation("agentCredentials:mintAgentCredential", {
		orgSlug: "org-a",
		agentName: "agent-a",
	})) as { secret: string };
	return minted.secret;
}

/** Signs the person in through the real flow and returns the raw access token. */
async function personToken(userId: string): Promise<string> {
	const r = await authorizeAsPerson(app, {
		clientId: CLIENT_ID,
		redirectUri: REDIRECT,
		challenge,
		sessionToken: await harness.session(userId),
		orgId: "org_A",
	});
	expect(r.code).toBeTruthy();
	const res = await app.request("http://localhost:3000/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: r.code as string,
			code_verifier: VERIFIER,
			redirect_uri: REDIRECT,
			client_id: CLIENT_ID,
		}).toString(),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { access_token: string }).access_token;
}

/** The OAuthContext the bearer middleware attaches for `token` (real middleware). */
async function contextFor(
	token: string,
	credential?: string,
): Promise<OAuthContext> {
	const probe = new Hono();
	probe.use("*", bearerAuthMiddleware());
	probe.get("/ctx", (c) => c.json(c.get("oauthContext")));
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	if (credential !== undefined)
		headers["x-vantage-agent-credential"] = credential;
	const res = await probe.request("http://localhost:3000/ctx", { headers });
	expect(res.status).toBe(200);
	return (await res.json()) as OAuthContext;
}

type Called = { mutations: string[]; queries: string[] };

function toolsFor(ctx: OAuthContext) {
	const tools = new Map<
		string,
		(args: Record<string, unknown>) => Promise<unknown>
	>();
	const server = {
		tool() {},
		registerTool: (
			name: string,
			_config: unknown,
			handler: (args: Record<string, unknown>) => Promise<unknown>,
		) => {
			tools.set(name, handler);
		},
	} as never;
	const called: Called = { mutations: [], queries: [] };
	const convex = {
		query: async (name: string) => {
			called.queries.push(name);
			return [];
		},
		mutation: async (name: string) => {
			called.mutations.push(name);
			return "mem-id";
		},
		action: async () => null,
	} as never;
	registerTools(server, convex, ctx);
	return { tools, called };
}

const WRITE = {
	namespace: "team/org-a",
	type: "project",
	content: "a note",
	createdBy: "agent-a",
};
const READ = { namespace: "team/org-a" };

type ToolResult = { isError?: boolean; content: { text: string }[] };

async function write(ctx: OAuthContext) {
	const { tools, called } = toolsFor(ctx);
	const result = (await tools.get("store_memory")?.(WRITE)) as ToolResult;
	return { result, called };
}

describe("the role is carried from the verified membership into the token and the context", () => {
	it("the token row carries orgRole and the person marker", async () => {
		await personToken("user_viewer");
		const row = (
			await t.run(async (ctx) => ctx.db.query("oauth_access_tokens").collect())
		)[0];
		expect(row.orgRole).toBe("org:viewer");
		expect(row.principal).toBe("person");
	});

	it("the bearer middleware attaches orgRole and principal to the oauthContext", async () => {
		const ctx = await contextFor(await personToken("user_editor"));
		expect(ctx.orgRole).toBe("org:editor");
		expect(ctx.principal).toBe("person");
		expect(ctx.clerkOrgSlug).toBe("org-a");
	});
});

describe("person token: the writer-role gate", () => {
	it("a viewer's write is refused and nothing is written", async () => {
		const { result, called } = await write(
			await contextFor(await personToken("user_viewer")),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("role-not-writer");
		expect(called.mutations).toEqual([]);
	});

	it("an editor's write is accepted (presenting agent-a's credential)", async () => {
		const { result, called } = await write(
			await contextFor(
				await personToken("user_editor"),
				await agentCredential(),
			),
		);
		expect(result.isError).toBeUndefined();
		expect(called.mutations).toEqual(["memories:storeMemory"]);
	});

	it("an admin's write is accepted (presenting agent-a's credential)", async () => {
		const { result, called } = await write(
			await contextFor(
				await personToken("user_admin"),
				await agentCredential(),
			),
		);
		expect(result.isError).toBeUndefined();
		expect(called.mutations).toEqual(["memories:storeMemory"]);
	});

	it("no writer-roles row for the org and no fleet default: even an admin is refused", async () => {
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query("memberWriterRoles").collect()) {
				await ctx.db.delete(row._id);
			}
		});
		const { result, called } = await write(
			await contextFor(await personToken("user_admin")),
		);
		expect(result.isError).toBe(true);
		expect(called.mutations).toEqual([]);
	});

	it("an org row with an empty list means nobody writes (never all)", async () => {
		await t.run(async (ctx) => {
			await ctx.db.insert("memberWriterRoles", {
				orgSlug: "org-a",
				roles: [],
				updatedAt: Date.now(),
			});
		});
		const { result } = await write(
			await contextFor(await personToken("user_admin")),
		);
		expect(result.isError).toBe(true);
	});

	it("a person token with no role is refused (never inherited)", async () => {
		const ctx = await contextFor(await personToken("user_editor"));
		const { orgRole: _dropped, ...noRole } = ctx;
		const { result, called } = await write(noRole as OAuthContext);
		expect(result.isError).toBe(true);
		expect(called.mutations).toEqual([]);
	});

	it("a role check that cannot be completed refuses the write (fail closed)", async () => {
		const ctx = await contextFor(await personToken("user_editor"));
		_setInternalClientForTest({
			query: async () => {
				throw new Error("convex unreachable");
			},
			mutation: async () => null,
			// biome-ignore lint/suspicious/noExplicitAny: test fake
		} as any);
		const { result, called } = await write(ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("fail closed");
		expect(called.mutations).toEqual([]);
	});

	it("a viewer's READ is served", async () => {
		const { tools, called } = toolsFor(
			await contextFor(await personToken("user_viewer")),
		);
		const result = (await tools.get("list_memories")?.(READ)) as ToolResult;
		expect(result.isError).toBeUndefined();
		expect(called.queries.length).toBeGreaterThan(0);
	});

	it("every tool that is not read-only passes the gate: a viewer is refused on a sample of other writes", async () => {
		const { tools } = toolsFor(
			await contextFor(await personToken("user_viewer")),
		);
		for (const name of [
			"create_task",
			"update_task",
			"complete_task",
			"delete_task",
			"create_mission",
			"send_message",
			"delete_message",
			"create_briefing_note",
			"create_recurring_task",
			"write_diary",
		]) {
			const handler = tools.get(name);
			expect(handler, name).toBeDefined();
			const r = (await handler?.({})) as ToolResult;
			expect(r.isError, name).toBe(true);
			expect(r.content[0].text, name).toContain("role-not-writer");
		}
	});
});

describe("own-state tools: mark_as_read is the receipt owner's, not a role exception", () => {
	/** Tool set wired to the REAL Convex functions (the receipt-owner check lives there). */
	function realTools(ctx: OAuthContext) {
		const tools = new Map<
			string,
			(args: Record<string, unknown>) => Promise<unknown>
		>();
		const server = {
			tool() {},
			registerTool: (
				name: string,
				_config: unknown,
				handler: (args: Record<string, unknown>) => Promise<unknown>,
			) => {
				tools.set(name, handler);
			},
		} as never;
		registerTools(
			server,
			// biome-ignore lint/suspicious/noExplicitAny: test bridge
			bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
			ctx,
		);
		return tools;
	}

	async function seedReceipts() {
		return await t.run(async (ctx) => {
			const now = Date.now();
			const messageId = await ctx.db.insert("messages", {
				from: "agent-a",
				tenantId: "org-a",
				channel: "direct",
				content: "hello",
				createdAt: now,
			});
			const own = await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: "agent-a",
				tenantId: "org-a",
			});
			const other = await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: "agent-b",
				tenantId: "org-a",
			});
			return { own: own as string, other: other as string };
		});
	}

	const readAt = (id: string) =>
		t.run(async (ctx) => (await ctx.db.get(id as never))?.readAt);

	it("a viewer marks its OWN receipt read (presenting agent-a's credential)", async () => {
		const ids = await seedReceipts();
		const tools = realTools(
			await contextFor(
				await personToken("user_viewer"),
				await agentCredential(),
			),
		);
		const r = (await tools.get("mark_as_read")?.({
			receiptIds: [ids.own],
			callerOrchestrator: "agent-a",
		})) as ToolResult;
		expect(r.isError).toBeUndefined();
		expect(await readAt(ids.own)).toBeTypeOf("number");
	});

	it("a viewer cannot mark another member's receipt: the owner check refuses", async () => {
		const ids = await seedReceipts();
		const tools = realTools(
			await contextFor(
				await personToken("user_viewer"),
				await agentCredential(),
			),
		);
		const r = (await tools.get("mark_as_read")?.({
			receiptIds: [ids.other],
			callerOrchestrator: "agent-a",
		})) as ToolResult;
		expect(r.isError).toBe(true);
		expect(await readAt(ids.other)).not.toBeTypeOf("number");
	});

	it("a viewer cannot name an agent outside the organisation's roster", async () => {
		const ids = await seedReceipts();
		const tools = realTools(await contextFor(await personToken("user_viewer")));
		const r = (await tools.get("mark_as_read")?.({
			receiptIds: [ids.other],
			callerOrchestrator: "agent-b-not-in-roster",
		})) as ToolResult;
		expect(r.isError).toBe(true);
		expect(await readAt(ids.other)).not.toBeTypeOf("number");
	});

	it("generate_upload_url stays refused for a viewer", async () => {
		const { tools } = toolsFor(
			await contextFor(await personToken("user_viewer")),
		);
		const r = (await tools.get("generate_upload_url")?.({})) as ToolResult;
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("role-not-writer");
	});

	it("the exemption is the declaration: without ownStateOnly the same viewer call is refused by the role gate", async () => {
		// delete_message is also bounded by an owner check, but declares no
		// ownStateOnly, so a viewer is refused before that check is reached.
		const { tools } = toolsFor(
			await contextFor(await personToken("user_viewer")),
		);
		const r = (await tools.get("delete_message")?.({})) as ToolResult;
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("role-not-writer");
	});
});

describe("a seat token (not a person) is unchanged", () => {
	const seat: OAuthContext = {
		clientId: "seat-client",
		userId: "seat-user",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "seat-profile",
		fromAllowList: ["agent-a"],
		namespaceReadPrefixes: ["team/org-a"],
		namespaceWritePrefixes: ["team/org-a"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		clerkOrgSlug: "org-a",
		// A seat reaches the tools through its OAuth token row (auth path 2),
		// which is what the strict-mode seat exemption reads.
		accessTokenHash: "seat-token-hash",
	};

	it("writes with no writer-roles table consulted, even with no row at all", async () => {
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query("memberWriterRoles").collect()) {
				await ctx.db.delete(row._id);
			}
		});
		const { result, called } = await write(seat);
		expect(result.isError).toBeUndefined();
		expect(called.mutations).toEqual(["memories:storeMemory"]);
	});
});

describe("strict default composes with the writer-role gate (person token)", () => {
	// Env unset = strict. Gate order in defineTool: writer-role gate, then the
	// acting-name binder (checkActorBinding), then the tool's scope check.
	const UNSET = undefined as unknown as string;
	const textOf = (r: ToolResult) => r.content[0].text;

	it("POLE 4 — a REAL person token (principal 'person', single-name roster ['agent-a']) naming agent-a with NO credential: editor passes the role gate and is refused AGENT_CREDENTIAL_REQUIRED, nothing written", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", UNSET);
		const ctx = await contextFor(await personToken("user_editor"));
		expect(ctx.principal).toBe("person");
		expect(ctx.fromAllowList).toEqual(["agent-a"]);
		expect(ctx.accessTokenHash).toBeDefined();
		const { result, called } = await write(ctx);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/^AGENT_CREDENTIAL_REQUIRED/);
		expect(called.mutations).toEqual([]);
	});

	it("a viewer naming agent-a with no credential is refused by the ROLE gate first (role-not-writer)", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", UNSET);
		const { result, called } = await write(
			await contextFor(await personToken("user_viewer")),
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("role-not-writer");
		expect(called.mutations).toEqual([]);
	});

	it("a person naming NO agent: reads are served (viewer and editor)", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", UNSET);
		for (const user of ["user_viewer", "user_editor"]) {
			const { tools, called } = toolsFor(
				await contextFor(await personToken(user)),
			);
			const r = (await tools.get("list_memories")?.(READ)) as ToolResult;
			expect(r.isError, user).toBeUndefined();
			expect(called.queries.length, user).toBeGreaterThan(0);
		}
	});

	it("a person editor naming NO agent on a from-kind write is refused by the roster check (no acting name to verify), nothing written", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", UNSET);
		const { tools, called } = toolsFor(
			await contextFor(await personToken("user_editor")),
		);
		const { createdBy: _omitted, ...noName } = WRITE;
		const r = (await tools.get("store_memory")?.(noName)) as ToolResult;
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain(
			"from='undefined' is not in this client's allowlist",
		);
		expect(called.mutations).toEqual([]);
	});

	it("explicit permissive keeps today's behaviour: the editor naming agent-a without a credential is served", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { result, called } = await write(
			await contextFor(await personToken("user_editor")),
		);
		expect(result.isError).toBeUndefined();
		expect(called.mutations).toEqual(["memories:storeMemory"]);
	});
});

describe("the Convex door admits the service account only", () => {
	it("an ordinary caller cannot ask the role question", async () => {
		const other = bridge(t.withIdentity({ subject: "somebody-else" }));
		await expect(
			other.query("memberWriterRoles:assertPersonMayWrite", {
				orgSlug: "org-a",
				role: "org:admin",
				door: "x",
			}),
		).rejects.toThrow();
	});
});
