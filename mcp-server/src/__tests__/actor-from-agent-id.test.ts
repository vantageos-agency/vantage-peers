/**
 * ACTOR_FROM_AGENT_ID: when the bearer resolves an agent ID, the actor IS that ID.
 *
 * VantagePeers Cloud (multi-tenant). Task k1728rrwzwtzc7hvc42d62t6558ha92a.
 * Operator order 2026-10-31: identity is the agent ID; a name never selects or
 * authorises. Observed on prod 065a951f: Marie's Claude.ai person token resolves
 * agent "hélios" (agents.personalAgentOf). A write with from="hélios" succeeded,
 * from="marie" was refused, and from="Helios" (no accent) would have been refused:
 * the spelling decided.
 *
 * Contract under test (every write door goes through defineTool -> bindActingNames):
 *   - a caller with a resolved agent ID acts as that ID; the acting name is
 *     optional; when typed it never decides by spelling. It is refused ONLY when
 *     it designates a DIFFERENT agent ID (found through the caller's own org
 *     directory, orgRoster:getAgentDirectoryForAccessToken, which returns IDs);
 *     a value that designates the same agent or no agent at all is admitted and
 *     the write is attributed to the caller's ID under the agent's STORED label;
 *   - a caller WITHOUT a resolved agent ID keeps today's behaviour (pole 5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { _setInternalClientForTest, type OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

const HELIOS = "hélios";
const HELIOS_ID = "r57d7scvxejmb6fbdpxxx32ndn8fcnat";
const ZOE_ID = "k57zoezoezoezoezoezoezoezoezoe01";
/** An agent of ANOTHER org: its ID is in no directory the caller can read. */
const OTHER_ORG_AGENT_ID = "j57othrorgothrorgothrorgothrorg1";

type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;
type Mutation = { name: string; args: Record<string, unknown> };

/** Marie's Claude.ai person token, resolved to agent hélios by ID. */
const marieToken = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "claude-ai",
	userId: "user_marie",
	scopes: ["mcp:full"],
	scopeProfile: "team-member",
	fromAllowList: [HELIOS, "marie", "zoe"],
	namespaceReadPrefixes: ["team/iris-rh"],
	namespaceWritePrefixes: ["team/iris-rh"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: "iris-rh",
	principal: "person",
	accessTokenHash: "hash-marie",
	actor: { orgSlug: "iris-rh", agentName: HELIOS, agentId: HELIOS_ID },
	...over,
});

/** The same person token with NO agent ID resolved (no actor, no seat stamp). */
const noAgentToken = (): OAuthContext => {
	const { actor: _actor, ...rest } = marieToken();
	return rest as OAuthContext;
};

let directoryCalls: unknown[] = [];
let directoryThrows = false;

beforeEach(() => {
	directoryCalls = [];
	directoryThrows = false;
	_setInternalClientForTest({
		query: async (name: string, args: unknown) => {
			if (name === "memberWriterRoles:assertPersonMayWrite") return null;
			if (name === "orgRoster:getAgentDirectoryForAccessToken") {
				directoryCalls.push(args);
				if (directoryThrows) throw new Error("convex unavailable");
				return [
					{ name: HELIOS, agentId: HELIOS_ID },
					{ name: "zoe", agentId: ZOE_ID },
				];
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string) => {
			throw new Error(`unmocked mutation: ${name}`);
		},
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	} as any);
});

afterEach(() => {
	_setInternalClientForTest(null);
	vi.restoreAllMocks();
});

function harness(ctx: OAuthContext) {
	const tools = new Map<string, Tool>();
	const schemas = new Map<string, z.ZodType>();
	const server = {
		tool() {},
		registerTool: (name: string, config: { inputSchema?: z.ZodType }, h: Tool) => {
			tools.set(name, h);
			if (config.inputSchema) schemas.set(name, config.inputSchema);
		},
	} as never;
	const mutations: Mutation[] = [];
	const convex = {
		query: vi.fn(async () => []),
		mutation: vi.fn(async (name: string, args: Record<string, unknown>) => {
			mutations.push({ name, args });
			return "doc-id-1";
		}),
		action: vi.fn(async () => null),
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, convex as any, ctx);
	return { tools, schemas, mutations };
}

const sendArgs = (extra: Record<string, unknown>) => ({
	recipientAgentIds: [ZOE_ID],
	content: "Briefing ready",
	...extra,
});
const noteArgs = (extra: Record<string, unknown>) => ({
	title: "Weekly",
	topic: "ops",
	participants: ["hélios"],
	content: "Notes",
	...extra,
});

const sent = (m: Mutation[]) =>
	m.filter((x) => x.name === "messages:sendMessage");
const noted = (m: Mutation[]) =>
	m.filter((x) => x.name === "briefingNotes:create");

describe("send_message: the actor is the resolved agent ID", () => {
	it("(1) no `from`: admitted, stored from = the agent's label, verifiedActor = the ID", async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("send_message")?.(sendArgs({}));
		expect(r?.isError, r?.content[0]?.text).toBeUndefined();
		const [m] = sent(h.mutations);
		expect(m.args.from).toBe(HELIOS);
		expect(m.args.verifiedActor).toEqual({
			agentId: HELIOS_ID,
			orgSlug: "iris-rh",
		});
	});

	it('(2) from="Helios" (no accent) designates no agent: admitted, attributed to the same ID under the STORED label', async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("send_message")?.(sendArgs({ from: "Helios" }));
		expect(r?.isError, r?.content[0]?.text).toBeUndefined();
		const [m] = sent(h.mutations);
		expect(m.args.from).toBe(HELIOS);
		expect(m.args.verifiedActor).toEqual({
			agentId: HELIOS_ID,
			orgSlug: "iris-rh",
		});
	});

	it('(2b) from="marie" (a person name, no agent of that name): admitted as the same ID', async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("send_message")?.(sendArgs({ from: "marie" }));
		expect(r?.isError, r?.content[0]?.text).toBeUndefined();
		expect(sent(h.mutations)[0]?.args.from).toBe(HELIOS);
	});

	it("(3) from names another agent of the SAME org (a different ID): refused, nothing sent", async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("send_message")?.(sendArgs({ from: "zoe" }));
		expect(r?.isError).toBe(true);
		expect(r?.content[0]?.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(sent(h.mutations)).toHaveLength(0);
	});

	it("(3b) from is the other agent's ID: refused, nothing sent", async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("send_message")?.(sendArgs({ from: ZOE_ID }));
		expect(r?.isError).toBe(true);
		expect(r?.content[0]?.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(sent(h.mutations)).toHaveLength(0);
	});

	it("(4) from is an agent of ANOTHER org (by ID, in no directory the caller can read): refused, nothing sent", async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("send_message")?.(
			sendArgs({ from: OTHER_ORG_AGENT_ID }),
		);
		expect(r?.isError).toBe(true);
		expect(r?.content[0]?.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(sent(h.mutations)).toHaveLength(0);
	});

	it("(4b) the directory cannot be read: a name that is not the agent's own is refused (fail closed), never admitted as 'no agent'", async () => {
		directoryThrows = true;
		const h = harness(marieToken());
		const r = await h.tools.get("send_message")?.(sendArgs({ from: "Helios" }));
		expect(r?.isError).toBe(true);
		expect(r?.content[0]?.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(sent(h.mutations)).toHaveLength(0);
	});

	it("(4c) the directory is asked with the token hash only, never an org or a name from the call", async () => {
		const h = harness(marieToken());
		await h.tools.get("send_message")?.(sendArgs({ from: "Helios" }));
		expect(directoryCalls).toEqual([{ tokenHash: "hash-marie" }]);
	});

	it("(5) POLE: a caller with NO agent ID keeps today's behaviour (a typed agent name needs the agent's credential)", async () => {
		const h = harness(noAgentToken());
		const r = await h.tools.get("send_message")?.(sendArgs({ from: HELIOS }));
		expect(r?.isError).toBe(true);
		expect(r?.content[0]?.text).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(sent(h.mutations)).toHaveLength(0);
		expect(directoryCalls).toEqual([]);
	});
});

describe("create_briefing_note: the author is the resolved agent ID", () => {
	it("createdBy is optional in the advertised schema", () => {
		const h = harness(marieToken());
		const schema = h.schemas.get("create_briefing_note");
		expect(schema).toBeDefined();
		const parsed = schema?.safeParse(noteArgs({}));
		expect(parsed?.success, JSON.stringify(parsed)).toBe(true);
	});

	it("no createdBy: admitted, stored createdBy = the agent's label, verifiedActor = the ID", async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("create_briefing_note")?.(noteArgs({}));
		expect(r?.isError, r?.content[0]?.text).toBeUndefined();
		const [m] = noted(h.mutations);
		expect(m.args.createdBy).toBe(HELIOS);
		expect(m.args.verifiedActor).toEqual({
			agentId: HELIOS_ID,
			orgSlug: "iris-rh",
		});
	});

	it('createdBy="Helios": admitted, same author ID, stored label', async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("create_briefing_note")?.(
			noteArgs({ createdBy: "Helios" }),
		);
		expect(r?.isError, r?.content[0]?.text).toBeUndefined();
		const [m] = noted(h.mutations);
		expect(m.args.createdBy).toBe(HELIOS);
		expect(m.args.verifiedActor).toEqual({
			agentId: HELIOS_ID,
			orgSlug: "iris-rh",
		});
	});

	it("createdBy names another agent of the same org: refused, nothing stored", async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("create_briefing_note")?.(
			noteArgs({ createdBy: "zoe" }),
		);
		expect(r?.isError).toBe(true);
		expect(r?.content[0]?.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(noted(h.mutations)).toHaveLength(0);
	});

	it("createdBy is an agent of another org (by ID): refused, nothing stored", async () => {
		const h = harness(marieToken());
		const r = await h.tools.get("create_briefing_note")?.(
			noteArgs({ createdBy: OTHER_ORG_AGENT_ID }),
		);
		expect(r?.isError).toBe(true);
		expect(r?.content[0]?.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(noted(h.mutations)).toHaveLength(0);
	});

	it("POLE: a caller with NO agent ID that omits createdBy is still refused (the name is required without an ID)", async () => {
		const h = harness(noAgentToken());
		const r = await h.tools.get("create_briefing_note")?.(noteArgs({}));
		expect(r?.isError).toBe(true);
		expect(noted(h.mutations)).toHaveLength(0);
	});

	it("POLE: a caller with NO agent ID that types an agent name keeps AGENT_CREDENTIAL_REQUIRED", async () => {
		const h = harness(noAgentToken());
		const r = await h.tools.get("create_briefing_note")?.(
			noteArgs({ createdBy: HELIOS }),
		);
		expect(r?.isError).toBe(true);
		expect(r?.content[0]?.text).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(noted(h.mutations)).toHaveLength(0);
	});
});
