/**
 * The inbox tools' CLAIMS, pinned at the tool boundary (PR #1492 REVISE,
 * task k178b802qqs0qtvyjk611ajhkd8fx129). VantagePeers Cloud (multi-tenant).
 *
 * Convex resolves no claim to the `fleet` reader for a non-master token, so the
 * lines of check_messages / mark_as_read / delete_message that decide WHICH proof
 * rides the call ARE the cross-tenant isolation of an org-level token. A
 * RECORDING Convex fake captures the exact args each tool sends, per caller:
 *
 *   SEAT            one resolved agent: verifiedActor sent, verifiedOrg NOT.
 *   ORG-LEVEL       a token that names several agents (no single ID): verifiedOrg
 *                   sent, verifiedActor NOT. Never both. Two shapes: the token
 *                   row's org, and a credential-bound actor with no agentId.
 *   UNRESOLVED ORG  a non-master bearer with no org at all: Convex is NEVER
 *                   called and the refusal is returned.
 *   PERSON          acts in its own name: refused before Convex today on all three
 *                   tools (no human door), so no agent ID or org is ever sent.
 *   MASTER          the fleet service account: no proof of any kind. A master that
 *                   omits callerOrchestrator is refused by the door
 *                   (recipient-required); the tool surfaces that refusal as an
 *                   error, it does not swallow it into an empty success.
 *
 * There is no MCP tool over messages:getUnreadCount (grep in src/tools.ts finds
 * none), so it has no row here; its VERIFIED_ACTOR_DOORS membership is pinned in
 * inbox-doors-verified-reader.test.ts.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	LOCAL_STDIO_TRUST_CTX,
	type OAuthContext,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const CLIO_ID = "agentclio0000000000000000000001";
const ORG = "iris-rh";
const RECEIPT = "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MESSAGE = "j57bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const base: OAuthContext = {
	clientId: "client-x",
	userId: "user-x",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "p",
	fromAllowList: ["clio"],
	namespaceReadPrefixes: ["orchestrator/clio"],
	namespaceWritePrefixes: ["orchestrator/clio"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	accessTokenHash: "hash-x",
};

const SEAT: OAuthContext = {
	...base,
	clerkOrgSlug: ORG,
	seatAgent: { agentId: CLIO_ID, orgId: ORG, agentName: "clio" },
};
const ORG_TOKEN: OAuthContext = {
	...base,
	clerkOrgSlug: ORG,
	seatAgent: null,
};
const ORG_CREDENTIAL_NO_ID: OAuthContext = {
	...base,
	seatAgent: null,
	actor: { orgSlug: ORG, agentName: "clio" },
};
const UNRESOLVED: OAuthContext = { ...base, seatAgent: null };
const PERSON: OAuthContext = {
	...base,
	userId: "user_2abc",
	fromAllowList: [],
	principal: "person",
	clerkOrgSlug: ORG,
	orgRole: "org:admin",
};
const MASTER: OAuthContext = { ...LOCAL_STDIO_TRUST_CTX };

type Call = {
	kind: "query" | "mutation";
	name: string;
	args: Record<string, unknown>;
};
type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content?: Array<{ text?: string }>;
}>;

const DOOR_REFUSAL =
	'RBAC_DENIED: this caller names its inbox by recipient and none was given; an agent presents a verified identity instead — {"reason":"recipient-required","door":"messages:markAsRead"}';

function recordingConvex(opts: { doorRefusesNoReader?: boolean } = {}) {
	const calls: Call[] = [];
	const refuse = (args: Record<string, unknown>) => {
		const proof = args.verifiedActor ?? args.verifiedOrg ?? args.verifiedPerson;
		if (
			opts.doorRefusesNoReader === true &&
			proof === undefined &&
			args.callerOrchestrator === undefined
		) {
			throw Object.assign(new Error("[Request ID: x] Server Error"), {
				data: DOOR_REFUSAL,
			});
		}
	};
	const client = {
		query: vi.fn(async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "query", name, args });
			return { messages: [], truncated: false, nextSince: null };
		}),
		mutation: vi.fn(async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "mutation", name, args });
			refuse(args);
			return name === "messages:markAsRead" ? 1 : { deleted: true };
		}),
		action: vi.fn(async () => null),
	};
	return { client, calls };
}

async function run(
	tool: "check_messages" | "mark_as_read" | "delete_message",
	ctx: OAuthContext,
	args: Record<string, unknown>,
	opts: { doorRefusesNoReader?: boolean } = {},
) {
	const tools = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		tools.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const server = { tool: reg, registerTool: reg } as unknown as McpServer;
	const { client, calls } = recordingConvex(opts);
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, ctx);
	const handler = tools.get(tool);
	if (!handler) throw new Error(`tool ${tool} was not registered`);
	const result = await handler(args);
	return {
		calls,
		refused: result.isError === true,
		text: result.content?.[0]?.text ?? "",
	};
}

// Each tool's call args, valid for every caller (the acting name is the seat's).
const CHECK = { recipient: "clio" };
const MARK = { receiptIds: [RECEIPT], callerOrchestrator: "clio" };
const DELETE = { messageId: MESSAGE, callerOrchestrator: "clio" };

const DOORS = {
	check_messages: { door: "messages:checkNewMessagesEnvelope", kind: "query" },
	mark_as_read: { door: "messages:markAsRead", kind: "mutation" },
	delete_message: { door: "messages:deleteMessage", kind: "mutation" },
} as const;

let savedMode: string | undefined;
beforeEach(() => {
	savedMode = process.env[ACTOR_CREDENTIAL_MODE_ENV];
	// An org-level token naming an agent is served only in the permissive cutover
	// mode; the claims it then sends are what these rows pin.
	process.env[ACTOR_CREDENTIAL_MODE_ENV] = "permissive";
	_resetUnattributedClaimsForTest();
	vi.spyOn(console, "error").mockImplementation(() => {});
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	_setInternalClientForTest({ query: async () => null } as any);
});

afterEach(() => {
	if (savedMode === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	else process.env[ACTOR_CREDENTIAL_MODE_ENV] = savedMode;
	vi.restoreAllMocks();
	_resetUnattributedClaimsForTest();
	_setInternalClientForTest(null);
});

const TOOLS = [
	["check_messages", CHECK],
	["mark_as_read", MARK],
	["delete_message", DELETE],
] as const;

describe.each(TOOLS)("%s: the proof that rides the call", (tool, args) => {
	const { door, kind } = DOORS[tool];

	it("SEAT: sends verifiedActor { agentId, orgSlug } and NO verifiedOrg", async () => {
		const r = await run(tool, SEAT, args);
		expect(r.refused).toBe(false);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].name).toBe(door);
		expect(r.calls[0].kind).toBe(kind);
		expect(r.calls[0].args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: ORG,
		});
		expect(r.calls[0].args).not.toHaveProperty("verifiedOrg");
		expect(r.calls[0].args).not.toHaveProperty("verifiedPerson");
	});

	it("ORG-LEVEL token: sends verifiedOrg { orgSlug } and NO verifiedActor", async () => {
		const r = await run(tool, ORG_TOKEN, args);
		expect(r.refused).toBe(false);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].name).toBe(door);
		expect(r.calls[0].args.verifiedOrg).toEqual({ orgSlug: ORG });
		expect(r.calls[0].args).not.toHaveProperty("verifiedActor");
		expect(r.calls[0].args).not.toHaveProperty("verifiedPerson");
	});

	it("ORG-LEVEL credential without an agent ID: verifiedOrg, never both", async () => {
		const r = await run(tool, ORG_CREDENTIAL_NO_ID, args);
		expect(r.refused).toBe(false);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].args.verifiedOrg).toEqual({ orgSlug: ORG });
		expect(r.calls[0].args).not.toHaveProperty("verifiedActor");
	});

	it("UNRESOLVED org: Convex is NEVER called and the refusal is returned", async () => {
		const r = await run(tool, UNRESOLVED, args);
		expect(r.refused).toBe(true);
		expect(r.calls).toHaveLength(0);
		expect(r.text).toContain("RBAC_DENIED");
		expect(r.text).toContain("verified-org-unresolved");
		expect(r.text).toContain(tool);
	});

	it("MASTER: no proof of any kind, the typed name unchanged", async () => {
		const masterArgs =
			tool === "check_messages"
				? { recipient: "pi" }
				: { ...args, callerOrchestrator: "pi" };
		const r = await run(tool, MASTER, masterArgs);
		expect(r.refused).toBe(false);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].name).toBe(door);
		expect(r.calls[0].args).not.toHaveProperty("verifiedActor");
		expect(r.calls[0].args).not.toHaveProperty("verifiedOrg");
		expect(r.calls[0].args).not.toHaveProperty("verifiedPerson");
		const named =
			tool === "check_messages" ? "recipient" : "callerOrchestrator";
		expect(r.calls[0].args[named]).toBe("pi");
	});
});

describe("PERSON: acts in its own name, the member path unchanged", () => {
	it("mark_as_read: unchanged by this PR: refused before Convex, so no proof of any kind is sent", async () => {
		// mark_as_read is ownStateOnly and declares no personDoor, so a person's
		// call is bound by the agent rules (registerTool.ts, untouched here) and
		// refused for omitting its name. The `personDoorArgs` spread on the door
		// call is therefore not reachable today; this row pins that nothing
		// reaches Convex for a person, and fails if that ever changes.
		const r = await run("mark_as_read", PERSON, { receiptIds: [RECEIPT] });
		expect(r.refused).toBe(true);
		expect(r.calls).toHaveLength(0);
		expect(r.text).toContain("Forbidden");
	});

	it("delete_message: no human door, refused before Convex", async () => {
		const r = await run("delete_message", PERSON, { messageId: MESSAGE });
		expect(r.refused).toBe(true);
		expect(r.calls).toHaveLength(0);
		expect(r.text).toContain("PERSON_NO_HUMAN_DOOR");
	});

	it("check_messages: its own name is not in an allowlist, refused before Convex", async () => {
		const r = await run("check_messages", PERSON, {
			recipient: "user:user_2abc",
		});
		expect(r.refused).toBe(true);
		expect(r.calls).toHaveLength(0);
	});
});

describe("MASTER mark_as_read without callerOrchestrator", () => {
	it("sends no reader proof and surfaces the door's refusal as an error, not an empty success", async () => {
		const r = await run(
			"mark_as_read",
			MASTER,
			{ receiptIds: [RECEIPT] },
			{ doorRefusesNoReader: true },
		);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].args).not.toHaveProperty("verifiedActor");
		expect(r.calls[0].args).not.toHaveProperty("verifiedOrg");
		expect(r.calls[0].args).not.toHaveProperty("verifiedPerson");
		expect(r.calls[0].args.callerOrchestrator).toBeUndefined();
		expect(r.refused).toBe(true);
		expect(r.text).toContain("RBAC_DENIED");
		expect(r.text).toContain("recipient-required");
		expect(r.text).not.toContain("markedAsRead");
	});

	it("the same master naming itself is served (the refusal is for the omission only)", async () => {
		const r = await run(
			"mark_as_read",
			MASTER,
			{ receiptIds: [RECEIPT], callerOrchestrator: "pi" },
			{ doorRefusesNoReader: true },
		);
		expect(r.refused).toBe(false);
		expect(r.text).toContain("markedAsRead");
	});
});
