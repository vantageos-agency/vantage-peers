/**
 * Which OAuth tokens a ChatGPT / Claude.ai connector may act as an agent with.
 *
 * Task k17fvgydv2pv054dtwk15z9x198fvtc0. VantagePeers Cloud (multi-tenant).
 * Measured at 386dd4b: the refusal a connector sees,
 * `AGENT_CREDENTIAL_REQUIRED: this call names "clio" but the request carried no
 * per-agent credential`, is raised HERE (checkActorBinding, strict by default
 * since #1445), never by Convex (the service account is exempt from the Convex
 * lock, see convex/lib/auth.test.ts "connector agent credential").
 *
 * The one exemption is a SEAT token naming itself (isSeatActingAsItself): an
 * OAuth token row, no `principal`, `fromAllowList` of exactly one name, and the
 * typed name equals it. Everything else that types an agent name is refused:
 * an org-wide token, an empty allowlist, and a PERSON token (the token the
 * authorization_code grant mints for every new connection since #1444, with the
 * whole org roster as its allowlist and no agent bound).
 *
 * Accent: normalizeOrchestratorId folds case and NFC form, never accents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setInternalClientForTest, type OAuthContext } from "../src/auth.js";
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
	} as unknown as Parameters<typeof registerTools>[0];
	const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
	const convex = {
		query: async () => null,
		action: async () => null,
		mutation: async (name: string, args: Record<string, unknown>) => {
			mutations.push({ name, args });
			return "id";
		},
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, oauthCtx);
	const call = (tool: string, args: Record<string, unknown>) => {
		const h = handlers.get(tool);
		if (!h) throw new Error(`${tool} not registered`);
		return h(args);
	};
	return {
		note: (createdBy: string) =>
			call("create_briefing_note", {
				title: "t",
				topic: "t",
				participants: [createdBy],
				content: "c",
				createdBy,
			}),
		send: (from: string, channel = "marie") =>
			call("send_message", { from, channel, content: "c" }),
		mutations,
	};
}

function token(over: Partial<OAuthContext>): OAuthContext {
	return {
		clientId: "oauth-client",
		userId: "u",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "clio-iris-rh",
		fromAllowList: ["clio"],
		namespaceReadPrefixes: ["team/iris-rh"],
		namespaceWritePrefixes: ["team/iris-rh"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		accessTokenHash: "hash",
		clerkOrgSlug: "iris-rh",
		...over,
	};
}

const REQUIRED = /AGENT_CREDENTIAL_REQUIRED/;

describe("connector agent credential", () => {
	beforeEach(() => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "");
		_setInternalClientForTest({ query: async () => null } as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		_setInternalClientForTest(null);
	});

	it("GREEN: clio's agent-bound token creates a briefing note and messages helios", async () => {
		const h = harness(token({}));
		const n = await h.note("clio");
		const m = await h.send("clio", "helios");
		expect(n.isError).toBeFalsy();
		expect(m.isError).toBeFalsy();
		expect(h.mutations.map((x) => x.name)).toEqual([
			"briefingNotes:create",
			"messages:sendMessage",
		]);
		expect(h.mutations[1]?.args.seatOrgSlug).toBe("iris-rh");
		expect("agentCredentialSecret" in (h.mutations[1]?.args ?? {})).toBe(false);
	});

	it("GREEN: the accented agent under its own exact spelling", async () => {
		const h = harness(
			token({ scopeProfile: "hélios-iris-rh", fromAllowList: ["hélios"] }),
		);
		expect((await h.note("hélios")).isError).toBeFalsy();
		expect((await h.send("hélios", "clio")).isError).toBeFalsy();
	});

	it("REFUSED (roster gate, case-exact today): a different case of the same agent", async () => {
		const h = harness(
			token({ scopeProfile: "hélios-iris-rh", fromAllowList: ["hélios"] }),
		);
		const r = await h.note("Hélios");
		expect(r.isError).toBe(true);
		expect(r.content?.[0]?.text).toContain("is not in this client's allowlist");
		expect(h.mutations).toHaveLength(0);
	});

	it("REFUSED: the accent is not folded, in either direction", async () => {
		const bound = harness(token({ fromAllowList: ["hélios"] }));
		expect((await bound.note("helios")).content?.[0]?.text).toMatch(REQUIRED);
		const plain = harness(token({ fromAllowList: ["helios"] }));
		expect((await plain.send("hélios", "clio")).content?.[0]?.text).toMatch(REQUIRED);
		expect(bound.mutations).toHaveLength(0);
		expect(plain.mutations).toHaveLength(0);
	});

	it("REFUSED: clio's token asserting from=hélios (names another agent)", async () => {
		const h = harness(token({}));
		const n = await h.note("hélios");
		const m = await h.send("hélios", "clio");
		expect(n.isError).toBe(true);
		expect(m.isError).toBe(true);
		expect(n.content?.[0]?.text).toMatch(REQUIRED);
		expect(m.content?.[0]?.text).toMatch(REQUIRED);
		expect(h.mutations).toHaveLength(0);
	});

	it("REFUSED: an org-wide token (several names) naming one of them", async () => {
		const h = harness(token({ fromAllowList: ["clio", "hélios", "marie"] }));
		expect((await h.note("clio")).content?.[0]?.text).toMatch(REQUIRED);
		expect((await h.send("clio", "marie")).content?.[0]?.text).toMatch(REQUIRED);
		expect(h.mutations).toHaveLength(0);
	});

	it("REFUSED: an org-only token (empty allowlist)", async () => {
		const h = harness(token({ fromAllowList: [] }));
		expect((await h.note("clio")).isError).toBe(true);
		expect((await h.send("clio", "marie")).isError).toBe(true);
		expect(h.mutations).toHaveLength(0);
	});

	it("OBSERVED REFUSAL (iris-rh, 2026-10-07): a PERSON token, whole-org allowlist, naming clio", async () => {
		const h = harness(
			token({
				scopeProfile: "team-member",
				fromAllowList: ["clio", "hélios", "marie", "victor"],
				principal: "person",
				orgRole: "org:admin",
				userId: "user_abc",
			}),
		);
		const n = await h.note("clio");
		const m = await h.send("clio", "hélios");
		expect(n.content?.[0]?.text).toMatch(REQUIRED);
		expect(m.content?.[0]?.text).toMatch(REQUIRED);
		expect(h.mutations).toHaveLength(0);
	});

	it("REFUSED: a seat token is not accepted on an org it was not minted for (no org -> no fleet reach)", async () => {
		const h = harness(token({ clerkOrgSlug: undefined }));
		const m = await h.send("clio", "marie");
		expect(m.content?.[0]?.text).toContain("SEAT_ORG_UNRESOLVED");
		expect(h.mutations).toHaveLength(0);
	});
});
