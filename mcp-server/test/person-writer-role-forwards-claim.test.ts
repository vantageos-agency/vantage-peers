/**
 * Batch D: the person writer-role gate (registerTool.ts enforcePersonWriterRole)
 * forwards the VERIFIED role claim to the door that decides
 * (`memberWriterRoles:assertPersonMayWrite`) and decides nothing itself.
 *
 * Three poles plus a cross-organisation deny pole.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _setInternalClientForTest, type OAuthContext } from "../src/auth.js";
import { defineTool } from "../src/registerTool.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

function callerCtx(over: Partial<OAuthContext> = {}): OAuthContext {
	return {
		clientId: "oauth-person",
		userId: "user_a",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "person",
		fromAllowList: [],
		namespaceReadPrefixes: ["team/org_A"],
		namespaceWritePrefixes: ["team/org_A"],
		expiresAt: Number.MAX_SAFE_INTEGER,
		isMaster: false,
		principal: "person",
		accessTokenHash: "h1",
		clerkOrgSlug: "org_A",
		orgRole: "org:member",
		...over,
	};
}

function personTool(ctx: OAuthContext, query: ReturnType<typeof vi.fn>): Handler {
	_setInternalClientForTest({ query } as never);
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool: (name: string, _config: unknown, handler: Handler) => {
			handlers.set(name, handler);
			return { disable: () => undefined };
		},
	} as unknown as McpServer;
	defineTool(
		server,
		{ oauthCtx: ctx },
		{ kind: "public", reason: "batch D writer-role pin" },
		"pin_write",
		"pin",
		{},
		{ readOnlyHint: false },
		async () => ({ content: [{ type: "text" as const, text: "ran" }] }),
	);
	return handlers.get("pin_write") as Handler;
}

const ROLE_REFUSED = () =>
	Object.assign(new Error("denied"), { data: "RBAC_DENIED role-not-writer" });

afterEach(() => _setInternalClientForTest(null));

describe("person writer-role gate forwards the role claim and decides nothing", () => {
	it("PRESENT: the verified role and org are forwarded; the door's allow runs the tool", async () => {
		const query = vi.fn(async () => ({ allowed: true }));
		const out = (await personTool(callerCtx(), query)({}, {})) as {
			content: { text: string }[];
		};
		expect(out.content[0].text).toBe("ran");
		expect(query).toHaveBeenCalledWith("memberWriterRoles:assertPersonMayWrite", {
			orgSlug: "org_A",
			role: "org:member",
			door: "mcp:pin_write",
		});
	});

	it("REFUSED: the door's role-not-writer refusal stops the tool", async () => {
		const query = vi.fn(async () => {
			throw ROLE_REFUSED();
		});
		const out = (await personTool(callerCtx({ orgRole: "org:viewer" }), query)(
			{},
			{},
		)) as { isError?: boolean; content: { text: string }[] };
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toContain("role-not-writer");
	});

	it("ABSENT: a person token with no verified role forwards no role, and the door refuses", async () => {
		const query = vi.fn(async () => {
			throw ROLE_REFUSED();
		});
		const { orgRole: _dropped, ...noRole } = callerCtx();
		const out = (await personTool(noRole as OAuthContext, query)({}, {})) as {
			isError?: boolean;
		};
		expect(out.isError).toBe(true);
		const sent = query.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(sent.role).toBeUndefined();
		expect(sent.orgSlug).toBe("org_A");
	});

	it("cross-org deny: a person token with no organisation is refused before any door call", async () => {
		const query = vi.fn(async () => ({ allowed: true }));
		const { clerkOrgSlug: _org, ...noOrg } = callerCtx();
		const out = (await personTool(noOrg as OAuthContext, query)({}, {})) as {
			isError?: boolean;
		};
		expect(out.isError).toBe(true);
		expect(query).not.toHaveBeenCalled();
	});

	it("a seat token (no person principal) never reaches the writer-role door", async () => {
		const query = vi.fn(async () => ({ allowed: true }));
		const { principal: _p, ...seat } = callerCtx();
		const out = (await personTool(seat as OAuthContext, query)({}, {})) as {
			content: { text: string }[];
		};
		expect(out.content[0].text).toBe("ran");
		expect(query).not.toHaveBeenCalled();
	});
});
