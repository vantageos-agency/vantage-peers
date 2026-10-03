/**
 * send_message — the sender is bound to the verified caller at the MCP layer.
 *
 * Task k17fdch7gfak29nyvna9r3qe098fed1d. VantagePeers Cloud (multi-tenant).
 *
 * A non-master OAuth caller reaches Convex as the SERVICE ACCOUNT (master), so
 * Convex cannot tell it from the fleet: the MCP guard is the only boundary for
 * that path. (A Clerk member forwards its own JWT and is bound in Convex —
 * convex/__tests__/sendMessageSenderFromCaller.test.ts.)
 *
 * Poles: a name outside the roster is refused and NOTHING is dispatched; a name
 * on the roster is served and forwarded; a resolved agent actor may not send as
 * another roster name; master unchanged.
 *
 * MUTANT (not committed): make `checkFromAllowed` return null for non-master
 * and the REFUSED poles go RED.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content?: Array<{ text?: string }>;
}>;

function harness(oauthCtx: OAuthContext) {
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool: (name: string, _c: unknown, h: Handler) => {
			handlers.set(name, h);
		},
		tool: (name: string, ...rest: unknown[]) => {
			handlers.set(name, rest[rest.length - 1] as Handler);
		},
	} as Parameters<typeof registerTools>[0];
	const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
	const convex = {
		query: async () => null,
		action: async () => null,
		mutation: async (name: string, args: Record<string, unknown>) => {
			mutations.push({ name, args });
			return "msg-id";
		},
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, oauthCtx);
	const send = (args: Record<string, unknown>) => {
		const h = handlers.get("send_message");
		if (!h) throw new Error("send_message not registered");
		return h(args);
	};
	return { send, mutations };
}

function memberCtx(over: Partial<OAuthContext> = {}): OAuthContext {
	return {
		clientId: "oauth-client-b",
		userId: "user-b",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "team-member",
		fromAllowList: ["bob", "bea"],
		namespaceReadPrefixes: ["team/org-b"],
		namespaceWritePrefixes: ["team/org-b"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		...over,
	};
}

const masterCtx: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: true,
};

describe("send_message — sender bound to the verified caller (MCP layer)", () => {
	// The roster poles exercise the uncredentialed path, which is reachable only
	// with the switch set to "permissive" explicitly (strict is the default since
	// k175v22zc52w1cbvq1d1qps50d8fccpg; under strict the binder refuses first).
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("REFUSED: from='eta' / 'pi' outside the roster; nothing dispatched", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { send, mutations } = harness(memberCtx());
		for (const from of ["eta", "pi", "ETA"]) {
			const r = await send({ from, channel: "bob", content: "x" });
			expect(r.isError).toBe(true);
			expect(r.content?.[0]?.text).toContain("not in this client's allowlist");
		}
		expect(mutations).toHaveLength(0);
	});

	it("SERVED: from on the roster is forwarded to messages:sendMessage", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { send, mutations } = harness(memberCtx());
		const r = await send({ from: "bob", channel: "bea", content: "x" });
		expect(r.isError).toBeFalsy();
		expect(mutations).toHaveLength(1);
		expect(mutations[0]?.name).toBe("messages:sendMessage");
		expect(mutations[0]?.args.from).toBe("bob");
	});

	it("ACTOR: a resolved agent 'bob' sending as 'bea' (on the roster) is refused", async () => {
		const { send, mutations } = harness(
			memberCtx({ actor: { orgSlug: "org-b", agentName: "bob" } }),
		);
		const r = await send({ from: "bea", channel: "bob", content: "x" });
		expect(r.isError).toBe(true);
		expect(r.content?.[0]?.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(mutations).toHaveLength(0);
	});

	it("MASTER unchanged: may send as any name", async () => {
		const { send, mutations } = harness(masterCtx);
		const r = await send({ from: "eta", channel: "pi", content: "x" });
		expect(r.isError).toBeFalsy();
		expect(mutations[0]?.args.from).toBe("eta");
	});
});
