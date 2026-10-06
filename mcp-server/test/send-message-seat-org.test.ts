/**
 * send_message forwards the seat's VERIFIED org to Convex.
 *
 * Task k174f54w3fv3amnk16v68tb3jh8frxxt. VantagePeers Cloud (multi-tenant).
 *
 * A non-master OAuth seat reaches Convex as the SERVICE ACCOUNT, which Convex
 * resolves as the fleet master with no org, so the #1470 recipient scope never
 * applied to it (a client seat's message to `sigma` was delivered). The MCP now
 * forwards `seatOrgSlug`, read from the verified principal the bearer
 * middleware resolved (token row `clerkOrgSlug`, or the credential-bound
 * `actor.orgSlug`) and NEVER from a tool argument; Convex believes it from the
 * service account only (convex/messages.seatScope.test.ts).
 *
 * Poles: bearer-only seat forwards its org; agent-credential seat forwards its
 * org; a tool argument cannot supply or override it; unresolvable org is
 * refused with nothing dispatched; master and Clerk-JWT callers forward
 * nothing (Convex scopes them itself).
 *
 * MUTANT (not committed): drop `seatOrgSlug` from the dispatched args and the
 * forwarding poles go RED; read it from `args.tenantId` and the spoof pole goes
 * RED.
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

function seatCtx(over: Partial<OAuthContext> = {}): OAuthContext {
	return {
		clientId: "oauth-client-seat",
		userId: "seat-user",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "team-member",
		fromAllowList: ["neo", "hal"],
		namespaceReadPrefixes: ["team/cgt-alsachimie"],
		namespaceWritePrefixes: ["team/cgt-alsachimie"],
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

describe("send_message — the seat's verified org is forwarded to Convex", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("bearer-only seat: forwards the token row's org", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { send, mutations } = harness(
			seatCtx({ clerkOrgSlug: "cgt-alsachimie" }),
		);
		const r = await send({ from: "neo", channel: "sigma", content: "x" });
		expect(r.isError).toBeFalsy();
		expect(mutations).toHaveLength(1);
		expect(mutations[0]?.name).toBe("messages:sendMessage");
		expect(mutations[0]?.args.seatOrgSlug).toBe("cgt-alsachimie");
	});

	it("agent-credential seat: forwards the credential-bound actor's org", async () => {
		const { send, mutations } = harness(
			seatCtx({ actor: { orgSlug: "cgt-alsachimie", agentName: "neo" } }),
		);
		const r = await send({ from: "neo", channel: "sigma", content: "x" });
		expect(r.isError).toBeFalsy();
		expect(mutations[0]?.args.seatOrgSlug).toBe("cgt-alsachimie");
	});

	it("SPOOF: a tenantId tool argument never becomes the seat org", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { send, mutations } = harness(
			seatCtx({ clerkOrgSlug: "cgt-alsachimie" }),
		);
		await send({
			from: "neo",
			channel: "hal",
			content: "x",
			tenantId: "other-client",
		});
		expect(mutations[0]?.args.seatOrgSlug).toBe("cgt-alsachimie");
	});

	it("REFUSED: actor org and token org disagree; nothing dispatched", async () => {
		const { send, mutations } = harness(
			seatCtx({
				clerkOrgSlug: "cgt-alsachimie",
				actor: { orgSlug: "other-client", agentName: "neo" },
			}),
		);
		const r = await send({ from: "neo", channel: "hal", content: "x" });
		expect(r.isError).toBe(true);
		expect(r.content?.[0]?.text).toContain("SEAT_ORG_CONFLICT");
		expect(mutations).toHaveLength(0);
	});

	it("REFUSED: a seat with no resolvable org is never given fleet reach", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { send, mutations } = harness(seatCtx());
		const r = await send({ from: "neo", channel: "sigma", content: "x" });
		expect(r.isError).toBe(true);
		expect(r.content?.[0]?.text).toContain("SEAT_ORG_UNRESOLVED");
		expect(mutations).toHaveLength(0);
	});

	it("MASTER unchanged: the fleet master forwards no seat org", async () => {
		const { send, mutations } = harness(masterCtx);
		const r = await send({ from: "pi", channel: "sigma", content: "x" });
		expect(r.isError).toBeFalsy();
		expect("seatOrgSlug" in (mutations[0]?.args ?? {})).toBe(false);
	});

	it("CLERK JWT unchanged: Convex resolves the caller's own org, nothing forwarded", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { send, mutations } = harness(
			seatCtx({ clerkJwt: "jwt", clerkOrgSlug: "cgt-alsachimie" }),
		);
		const r = await send({ from: "neo", channel: "hal", content: "x" });
		expect(r.isError).toBeFalsy();
		expect("seatOrgSlug" in (mutations[0]?.args ?? {})).toBe(false);
	});
});
