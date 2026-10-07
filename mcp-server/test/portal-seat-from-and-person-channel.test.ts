/**
 * Client portal reply path (task k1792yz3em7hyw84d765hq71j98ft5h4), MCP layer.
 *
 * VantagePeers Cloud. The portal's bearer is a seat whose allow-list is the one
 * label it sends as. Measured here, below the Convex door:
 *   - that bearer cannot send as an agent of its org ("hal", "neo") or as a person;
 *   - a reply to a person channel is forwarded VERBATIM (a Clerk subject is
 *     case-sensitive; lower-casing it would address nobody).
 */
import { describe, expect, it } from "vitest";
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

const portalSeat = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "portal",
	userId: "cgt-alsachimie",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "team-member",
	fromAllowList: ["cgt-alsachimie"],
	namespaceReadPrefixes: ["team/cgt-alsachimie"],
	namespaceWritePrefixes: ["team/cgt-alsachimie"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	accessTokenHash: "h".repeat(64),
	clerkOrgSlug: "cgt-alsachimie",
	...over,
});

describe("portal seat: the sender it may claim", () => {
	it("REFUSED: the portal bearer cannot send as an agent of its org or as a person", async () => {
		const { send, mutations } = harness(portalSeat());
		for (const from of ["hal", "neo", "mimir", "bob", "user:user_victim"]) {
			const r = await send({ from, channel: "hal", content: "x" });
			expect(r.isError, `from=${from}`).toBe(true);
			expect(mutations).toHaveLength(0);
		}
	});

	it("SERVED: the same bearer sends as its own label", async () => {
		const { send, mutations } = harness(portalSeat());
		const r = await send({ from: "cgt-alsachimie", channel: "hal", content: "x" });
		expect(r.isError).toBeFalsy();
		expect(mutations[0]?.args.from).toBe("cgt-alsachimie");
	});
});

describe("person channel: forwarded verbatim", () => {
	it("a mixed-case Clerk subject is not lower-cased; a role channel still is", async () => {
		const { send, mutations } = harness(
			portalSeat({
				fromAllowList: ["hal"],
				userId: "hal",
			}),
		);
		await send({ from: "hal", channel: "user:user_2NxYzAbC", content: "x" });
		await send({ from: "hal", channel: "NEO", content: "x" });
		expect(mutations[0]?.args.channel).toBe("user:user_2NxYzAbC");
		expect(mutations[1]?.args.channel).toBe("neo");
	});
});
