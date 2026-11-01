/**
 * Task k1783fk8r6p795x9fxrzyt9evd8hcxm7 (slug-takeover class, PR 2c, ledger row
 * A-6). `send_message` forwards the seat's verified org label as `seatOrgSlug`;
 * the label is reusable, so it now also forwards `seatOrgClerkId`, the
 * permanent ID of the same org. The ID is read from the verified oauthContext
 * (`orgClerkId`, set from the token row's live mapping join by
 * `oauth:getAccessTokenByHash`), never from a tool argument.
 *
 * MUTANT (not committed): read the ID from `args.seatOrgClerkId` and the SPOOF
 * pole goes RED; drop the ID from the dispatched args and the forwarding pole
 * goes RED.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OAuthContext, resolveSeatOrg } from "../src/auth.js";
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
		namespaceReadPrefixes: ["team/stale-label"],
		namespaceWritePrefixes: ["team/stale-label"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		...over,
	};
}

describe("send_message — seatOrgClerkId comes from the verified principal", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("forwards the token row's live org ID beside the label", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { send, mutations } = harness(
			seatCtx({ clerkOrgSlug: "stale-label", orgClerkId: "org_VerifiedA" }),
		);
		const r = await send({ from: "neo", channel: "hal", content: "x" });
		expect(r.isError).toBeFalsy();
		expect(mutations[0]?.args.seatOrgSlug).toBe("stale-label");
		expect(mutations[0]?.args.seatOrgClerkId).toBe("org_VerifiedA");
	});

	it("SPOOF: a tool argument never becomes the seat org ID", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { send, mutations } = harness(
			seatCtx({ clerkOrgSlug: "stale-label", orgClerkId: "org_VerifiedA" }),
		);
		await send({
			from: "neo",
			channel: "hal",
			content: "x",
			seatOrgClerkId: "org_Evil",
			orgClerkId: "org_Evil",
			tenantId: "other-client",
		});
		expect(mutations[0]?.args.seatOrgClerkId).toBe("org_VerifiedA");
	});

	it("no verified ID on the context (old Convex): forwards the label alone, never an argument's ID", async () => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		const { send, mutations } = harness(
			seatCtx({ clerkOrgSlug: "stale-label" }),
		);
		await send({
			from: "neo",
			channel: "hal",
			content: "x",
			seatOrgClerkId: "org_Evil",
		});
		expect(mutations[0]?.args.seatOrgSlug).toBe("stale-label");
		expect("seatOrgClerkId" in (mutations[0]?.args ?? {})).toBe(false);
	});
});

describe("resolveSeatOrg — the ID rides with the token's org only", () => {
	it("org + ID", () => {
		expect(
			resolveSeatOrg(seatCtx({ clerkOrgSlug: "a", orgClerkId: "org_A" })),
		).toEqual({ kind: "org", orgSlug: "a", orgClerkId: "org_A" });
	});
	it("an empty ID is not forwarded", () => {
		expect(
			resolveSeatOrg(seatCtx({ clerkOrgSlug: "a", orgClerkId: "" })),
		).toEqual({ kind: "org", orgSlug: "a" });
	});
	it("a credential-only seat (no token org) forwards the label alone", () => {
		expect(
			resolveSeatOrg(
				seatCtx({
					actor: { orgSlug: "a", agentName: "neo" },
					orgClerkId: "org_A",
				}),
			),
		).toEqual({ kind: "org", orgSlug: "a" });
	});
	it("master and Clerk-JWT callers forward nothing", () => {
		expect(
			resolveSeatOrg(seatCtx({ isMaster: true, orgClerkId: "org_A" })),
		).toEqual({ kind: "none" });
		expect(
			resolveSeatOrg(seatCtx({ clerkJwt: "jwt", orgClerkId: "org_A" })),
		).toEqual({ kind: "none" });
	});
});
