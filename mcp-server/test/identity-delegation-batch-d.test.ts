/**
 * Batch D (identity by ID, MCP server): the places in the MCP server that used
 * to decide identity locally now hand the decision to @vantageos/cloud-identity.
 *
 * Every pole here is behavioural: a mock of the package records that the
 * package was asked, and the observable answer is pinned for the REFUSED, the
 * ABSENT and the PRESENT caller, plus a cross-organisation deny pole.
 *
 *   1. master standing is read through the package's `bearerStanding`
 *      (auth.ts isMasterScope), so the kb-ingest gate and every scope guard
 *      share one reading of "the fleet service account / local trust / a caller";
 *   2. the Clerk session JWT boundary (auth.ts tryVerifyClerkJwt) keeps its
 *      poles. Verification itself stays on `jose` in this delivery: the package's
 *      `verifyClerkSessionToken` would close two CR-2 sites but R-34's detector
 *      does not read its `audience` config key, so the swap would add one R-34
 *      site (see the delivery notes);
 *   3. the name allow-list helper `isInAllowList` is gone: a name list selects
 *      nobody (normalizeOrchestratorId survives for display and typed-label
 *      comparison only);
 *   4. the person writer-role gate forwards the verified role claim to the door
 *      that decides (`memberWriterRoles:assertPersonMayWrite`) and decides nothing.
 */

import type { McpServer } from "@modelcontextprotocol/server";
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

const spies = vi.hoisted(() => ({
	bearerStanding: vi.fn(),
}));

vi.mock("@vantageos/cloud-identity", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@vantageos/cloud-identity")>();
	spies.bearerStanding.mockImplementation(actual.bearerStanding);
	return {
		...actual,
		bearerStanding: spies.bearerStanding,
	};
});

import { Hono } from "hono";
import {
	_resetClerkJwksCacheForTest,
	_setInternalClientForTest,
	bearerAuthMiddleware,
	isMasterScope,
	LOCAL_STDIO_TRUST_CTX,
	type OAuthContext,
} from "../src/auth.js";
import * as normalize from "../src/normalizeOrchestratorId.js";
import { registerKbIngestTools } from "../src/tools/kbIngest.js";

function callerCtx(over: Partial<OAuthContext> = {}): OAuthContext {
	return {
		clientId: "dcr-clerk-org_A",
		userId: "user_a",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: ["team/org_A"],
		namespaceWritePrefixes: ["team/org_A"],
		expiresAt: Number.MAX_SAFE_INTEGER,
		isMaster: false,
		...over,
	};
}

const MASTER_BEARER_CTX: OAuthContext = {
	...LOCAL_STDIO_TRUST_CTX,
	clientId: "master",
	userId: "master",
	scopeProfile: "master",
	viaMasterBearer: true,
};

beforeEach(() => {
	spies.bearerStanding.mockClear();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. master standing is the package's reading
// ─────────────────────────────────────────────────────────────────────────────

describe("isMasterScope reads the bearer standing through the package", () => {
	it("REFUSED: no context is never master, and the package is not asked about nothing", () => {
		expect(isMasterScope(undefined)).toBe(false);
		expect(spies.bearerStanding).not.toHaveBeenCalled();
	});

	it("ABSENT: a caller context that is not master stays a caller", () => {
		expect(isMasterScope(callerCtx())).toBe(false);
		expect(spies.bearerStanding).toHaveBeenCalledTimes(1);
	});

	it("PRESENT: the master bearer and the local trust context are master", () => {
		expect(isMasterScope(MASTER_BEARER_CTX)).toBe(true);
		expect(isMasterScope(LOCAL_STDIO_TRUST_CTX)).toBe(true);
		expect(spies.bearerStanding).toHaveBeenCalledTimes(2);
	});

	it("cross-org deny: a team member of org A is not master whatever org it names", () => {
		expect(
			isMasterScope(
				callerCtx({
					clerkOrgSlug: "org_B",
					namespaceWritePrefixes: ["team/org_B"],
				}),
			),
		).toBe(false);
	});

	it("a master-bearer flag on a non-master context is a contradiction, never master", () => {
		expect(isMasterScope(callerCtx({ viaMasterBearer: true }))).toBe(false);
	});

	it("an OAuth token of the wildcard master profile stays master (its roster holds the wildcard)", () => {
		expect(
			isMasterScope(
				callerCtx({ scopeProfile: "master", fromAllowList: ["*"] }),
			),
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// kb ingest: the master/no-org gate is the package's standing
// ─────────────────────────────────────────────────────────────────────────────

type Handler = (
	args: Record<string, unknown>,
	extra: unknown,
) => Promise<unknown>;

function registerKb(oauthCtx: OAuthContext | undefined): {
	handlers: Map<string, Handler>;
	action: ReturnType<typeof vi.fn>;
} {
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool: (name: string, _config: unknown, handler: Handler) => {
			handlers.set(name, handler);
			return { disable: () => undefined };
		},
	} as unknown as McpServer;
	const action = vi.fn(async () => ({
		docId: "d1",
		chunkCount: 1,
		storageId: "s1",
	}));
	const convex = { action } as never;
	registerKbIngestTools(server, convex, oauthCtx);
	return { handlers, action };
}

const STORE_ARGS = {
	storageId: "kg2storage",
	mimeType: "text/plain",
	filename: "a.txt",
};

describe("kb ingest asks the package whether the caller is a caller", () => {
	it("REFUSED: no context, the master bearer and the local trust context are refused before any action", async () => {
		for (const ctx of [undefined, MASTER_BEARER_CTX, LOCAL_STDIO_TRUST_CTX]) {
			const { handlers, action } = registerKb(ctx);
			await expect(
				handlers.get("store_document_chunked")?.(STORE_ARGS, {}),
			).rejects.toThrow(/AUTH_NO_ORG_ID/);
			expect(action).not.toHaveBeenCalled();
		}
		expect(spies.bearerStanding).toHaveBeenCalled();
	});

	it("ABSENT: a caller with no team namespace prefix is refused, nothing is invented", async () => {
		const { handlers, action } = registerKb(
			callerCtx({ namespaceWritePrefixes: [] }),
		);
		await expect(
			handlers.get("store_document_chunked")?.(STORE_ARGS, {}),
		).rejects.toThrow(/AUTH_NO_ORG_ID/);
		expect(action).not.toHaveBeenCalled();
	});

	it("PRESENT + cross-org: the organisation sent is the caller's own prefix, never another", async () => {
		const a = registerKb(callerCtx());
		await a.handlers.get("store_document_chunked")?.(STORE_ARGS, {});
		expect(a.action).toHaveBeenCalledWith(
			"kb:storeDocumentChunked",
			expect.objectContaining({ orgId: "org_A", namespace: "team/org_A" }),
		);
		const b = registerKb(callerCtx({ namespaceWritePrefixes: ["team/org_B"] }));
		await b.handlers.get("soft_delete_document")?.({ docId: "d1" }, {});
		expect(b.action).toHaveBeenCalledWith("kb:softDeleteDocument", {
			docId: "d1",
			orgId: "org_B",
			namespace: "team/org_B",
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. the name allow-list helper is gone
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeOrchestratorId is a display helper, not an admission list", () => {
	it("no export admits a name against a list of names", () => {
		expect(
			(normalize as Record<string, unknown>).isInAllowList,
		).toBeUndefined();
	});

	it("it still folds case and composition form for a label", () => {
		expect(normalize.normalizeOrchestratorId("  ÉLAN ")).toBe("élan");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Clerk session JWT boundary: verified principal, mapping row, or refusal
// ─────────────────────────────────────────────────────────────────────────────

const CLERK_DOMAIN = "https://sharp-sponge-67.clerk.accounts.dev";
const CLERK_JWKS_URL = `${CLERK_DOMAIN}/.well-known/jwks.json`;
const KID = "batch-d-key";

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

async function mint(opts: {
	aud?: string;
	orgId?: string | null;
}): Promise<string> {
	let b = new SignJWT(
		opts.orgId === null ? {} : { org_id: opts.orgId ?? "org_A" },
	)
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(CLERK_DOMAIN)
		.setSubject("user_a")
		.setIssuedAt()
		.setExpirationTime("1h");
	if (opts.aud !== undefined) b = b.setAudience(opts.aud);
	return b.sign(privateKey);
}

function appWithAuth(): Hono {
	const app = new Hono();
	app.use("/mcp", bearerAuthMiddleware());
	app.post("/mcp", (c) => c.json({ ok: true }));
	return app;
}

async function post(token: string): Promise<{ status: number; body: unknown }> {
	const res = await appWithAuth().request("http://localhost/mcp", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: "{}",
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

describe("the Clerk session JWT boundary (three poles + cross-org deny)", () => {
	beforeAll(async () => {
		const pair = await generateKeyPair("RS256", { extractable: true });
		privateKey = pair.privateKey;
		publicJwk = {
			...(await exportJWK(pair.publicKey)),
			kid: KID,
			alg: "RS256",
			use: "sig",
		};
	});

	beforeEach(() => {
		_resetClerkJwksCacheForTest();
		_setInternalClientForTest({
			query: async (name: string) => {
				if (name === "oauth:getAccessTokenByHash") return null;
				if (name === "clientOrgMapping:getByClerkSlug") {
					return {
						allowedOrchestrators: [],
						scopes: ["vantage:read"],
						isActive: true,
					};
				}
				throw new Error(`unmocked query: ${name}`);
			},
			mutation: async () => {
				throw new Error("unmocked mutation");
			},
		} as never);
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
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		_setInternalClientForTest(null);
	});

	it("PRESENT: a session token for audience convex and an org is accepted", async () => {
		const r = await post(await mint({ aud: "convex" }));
		expect(r.status).toBe(200);
	});

	it("REFUSED: another audience is a 401, never a team member", async () => {
		const r = await post(await mint({ aud: "someone-else" }));
		expect(r.status).toBe(401);
	});

	it("ABSENT: a verified session with no organisation is the typed 403, not the generic 401", async () => {
		const r = await post(await mint({ aud: "convex", orgId: null }));
		expect(r.status).toBe(403);
		expect(JSON.stringify(r.body)).toContain("NO_ORGANIZATION");
	});

	it("cross-org deny: an org with no active mapping row is refused even with a valid signature", async () => {
		_setInternalClientForTest({
			query: async (name: string) => {
				if (name === "oauth:getAccessTokenByHash") return null;
				if (name === "clientOrgMapping:getByClerkSlug") return null;
				throw new Error(`unmocked query: ${name}`);
			},
			mutation: async () => undefined,
		} as never);
		const r = await post(await mint({ aud: "convex", orgId: "org_B" }));
		expect(r.status).toBe(403);
		expect(JSON.stringify(r.body)).toContain("RBAC_DENIED");
	});

	it("a JWKS endpoint that cannot be reached is a refusal, never an accept", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		const token = await mint({ aud: "convex" });
		const r = await post(token);
		expect(r.status).toBe(401);
	});
});
