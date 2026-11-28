/**
 * S-28 batch 4 (task k1740ydgqb7bxwnftrfyskx1ch8jwtgg; VantagePeers Cloud + Self-host, MCP
 * server): the 14 MCP-side sites mcp-doctor still reads as non-conforming at 81369e24,
 * each pinned per caller class. A pin states the answer a class gets TODAY; the rule of
 * this batch is that no pin below may change from a success to an error (README#versioning).
 *
 * Caller classes: MASTER (fleet bearer / stdio trust, no agent), MASTER_AGENT, ORG_TOKEN (a
 * verified org, no agent: a person or org-level token), SEAT (a verified org and agent ID),
 * CLERK (a Clerk session: its own identity), NO_ORG (non-master, no verified org, no agent).
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	type OAuthContext,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import { registerKbIngestTools } from "../src/tools/kbIngest.js";
import {
	registerUiResources,
	type UiResourceConvexClient,
} from "../src/ui-resources/register.js";

const OPS_AGENT = "agentdedale00000000000000000001";
const CLIO_ID = "agentclio0000000000000000000001";
const ORG = "acme-hr";
const OPS_ORG = "vantage";
const ID = "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
const MASTER: OAuthContext = {
	...base,
	scopeProfile: "master",
	isMaster: true,
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
};
const MASTER_AGENT: OAuthContext = {
	...MASTER,
	actor: { orgSlug: OPS_ORG, agentName: "dedale", agentId: OPS_AGENT },
};
const ORG_TOKEN: OAuthContext = { ...base, clerkOrgSlug: ORG, seatAgent: null };
const SEAT: OAuthContext = {
	...base,
	clerkOrgSlug: ORG,
	seatAgent: { agentId: CLIO_ID, orgId: ORG, agentName: "clio" },
};
const CLERK: OAuthContext = {
	...base,
	clerkJwt: "eyJ.raw.clerk",
	clerkOrgSlug: ORG,
};
const NO_ORG: OAuthContext = { ...base };

// ── 1. memory-quote (resources/read, class A) ───────────────────────────────

// The read gate admits a non-master bearer by its organisation ID (register.ts).
const UI_ORG_TOKEN: OAuthContext = { ...ORG_TOKEN, orgClerkId: "org_AAAA" };
const UI_SEAT: OAuthContext = { ...SEAT, orgClerkId: "org_AAAA" };

type Call = { name: string; args: Record<string, unknown> };

async function readMemoryQuote(ctx: OAuthContext | undefined) {
	const calls: Call[] = [];
	const fake = {
		query: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			return { value: [], continueCursor: null, isDone: true };
		},
	} as unknown as UiResourceConvexClient;
	const server = new McpServer({ name: "t", version: "0.0.0" });
	const master = ctx === undefined || ctx.isMaster;
	registerUiResources(server, fake, ctx, {
		master,
		callerIdentities: master ? undefined : ctx?.fromAllowList,
	});
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	try {
		await client.readResource({
			uri: "ui://vp/v1/memory-quote?namespace=orchestrator%2Fclio",
		});
		return { calls, refused: false };
	} catch {
		return { calls, refused: true };
	} finally {
		await client.close();
	}
}

describe("memory-quote -> memories:listMemories forwards the agent ID the caller holds", () => {
	const door = "memories:listMemories";
	it("a seat with an agent ID: the door receives verifiedActor (agent ID and org)", async () => {
		const r = await readMemoryQuote(UI_SEAT);
		expect(r.refused).toBe(false);
		const c = r.calls.find((x) => x.name === door);
		expect(c?.args.verifiedActor).toEqual({ agentId: CLIO_ID, orgSlug: ORG });
	});
	it("a master bearer holding an agent ID: the door receives it too, as a tool call does", async () => {
		const r = await readMemoryQuote(MASTER_AGENT);
		const c = r.calls.find((x) => x.name === door);
		expect(c?.args.verifiedActor).toEqual({
			agentId: OPS_AGENT,
			orgSlug: OPS_ORG,
		});
	});
	it("a typed verifiedActor in the URI never replaces the verified one", async () => {
		const calls: Call[] = [];
		const fake = {
			query: async (name: string, args: Record<string, unknown>) => {
				calls.push({ name, args });
				return [];
			},
		} as unknown as UiResourceConvexClient;
		const server = new McpServer({ name: "t", version: "0.0.0" });
		registerUiResources(server, fake, UI_SEAT, {
			master: false,
			callerIdentities: ["clio"],
		});
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "c", version: "0.0.0" });
		await Promise.all([server.connect(st), client.connect(ct)]);
		await client.readResource({
			uri: "ui://vp/v1/memory-quote?namespace=orchestrator%2Fclio&verifiedActor=evil",
		});
		await client.close();
		const c = calls.find((x) => x.name === door);
		expect(c?.args.verifiedActor).toEqual({ agentId: CLIO_ID, orgSlug: ORG });
	});
	it("an org token with no agent ID, a master with none and a Clerk session: served, no actor", async () => {
		for (const ctx of [UI_ORG_TOKEN, MASTER, CLERK]) {
			const r = await readMemoryQuote(ctx);
			expect(r.refused).toBe(false);
			const c = r.calls.find((x) => x.name === door);
			expect(c, "door was not called").toBeDefined();
			expect(c?.args).not.toHaveProperty("verifiedActor");
		}
	});
	it("a bearer with no verified org, and no context: refused before the door", async () => {
		for (const ctx of [NO_ORG, undefined]) {
			const r = await readMemoryQuote(ctx);
			expect(r.refused).toBe(true);
			expect(r.calls).toEqual([]);
		}
	});
});

// ── 2. the tool sites, per caller class ─────────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content?: Array<{ text?: string }>;
}>;
const REPLIES: Record<string, unknown> = {
	"memories:listMemories": { value: [], continueCursor: "", isDone: true },
	"tasks:listBlockedOnMe": {
		entries: [],
		total: 0,
		truncated: false,
		oldestAge: 0,
	},
	"profiles:getProfile": null,
	"fixPatterns:get": null,
	"debate:getRoom": null,
};

async function callTool(
	tool: string,
	door: string,
	ctx: OAuthContext,
	args: Record<string, unknown>,
) {
	const tools = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		tools.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const server = { tool: reg, registerTool: reg } as unknown as McpServer;
	const calls: Call[] = [];
	const make = () =>
		vi.fn(async (name: string, a: Record<string, unknown>) => {
			calls.push({ name, args: a });
			return name in REPLIES ? REPLIES[name] : [];
		});
	const client = { query: make(), mutation: make(), action: make() };
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, ctx);
	const handler = tools.get(tool);
	if (!handler) throw new Error(`${tool} was not registered`);
	let r: Awaited<ReturnType<Handler>>;
	try {
		r = await handler(args);
	} catch (e) {
		return {
			doorCalls: calls.filter((c) => c.name === door),
			refused: true,
			text: String(e),
		};
	}
	return {
		doorCalls: calls.filter((c) => c.name === door),
		refused: r.isError === true,
		text: r.content?.[0]?.text ?? "",
	};
}

let savedMode: string | undefined;
beforeEach(() => {
	savedMode = process.env[ACTOR_CREDENTIAL_MODE_ENV];
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

const CLIO_CLAIM = { agentId: CLIO_ID, orgSlug: ORG };

/**
 * What each class gets at a tool site, as `door called` and the claim the door received.
 * `called: false` is a refusal before the door. A class whose door call is claimless is
 * served, or refused by the DOOR; the pin says which half this server owns.
 */
type Pin = {
	called: boolean;
	actor?: typeof CLIO_CLAIM | { agentId: string; orgSlug: string };
	refused?: boolean;
};

const SITES: ReadonlyArray<{
	tool: string;
	door: string;
	args: Record<string, unknown>;
	pins: Record<string, Pin>;
}> = [
	{
		tool: "list_memories",
		door: "memories:listMemories",
		args: { namespace: "orchestrator/clio" },
		pins: {
			MASTER: { called: true },
			ORG_TOKEN: { called: true },
			SEAT: { called: true, actor: CLIO_CLAIM },
			CLERK: { called: true },
			NO_ORG: { called: true },
		},
	},
	{
		tool: "list_episodes",
		door: "memories:listMemories",
		args: { namespace: "orchestrator/clio" },
		pins: {
			MASTER: { called: true },
			ORG_TOKEN: { called: true },
			SEAT: { called: true, actor: CLIO_CLAIM },
			CLERK: { called: true },
			NO_ORG: { called: true },
		},
	},
	{
		tool: "get_profile",
		door: "profiles:getProfile",
		args: { orchestratorId: "clio" },
		pins: {
			MASTER: { called: true },
			ORG_TOKEN: { called: true },
			SEAT: { called: true, actor: CLIO_CLAIM },
			CLERK: { called: true },
			NO_ORG: { called: true },
		},
	},
	{
		tool: "list_blocked_on_me",
		door: "tasks:listBlockedOnMe",
		args: {},
		pins: {
			MASTER: { called: true },
			ORG_TOKEN: { called: true },
			SEAT: { called: true, actor: CLIO_CLAIM },
			CLERK: { called: true },
			NO_ORG: { called: false, refused: true },
		},
	},
	{
		tool: "get_fix_pattern",
		door: "fixPatterns:get",
		args: { patternId: ID },
		pins: {
			MASTER: { called: true },
			ORG_TOKEN: { called: true },
			SEAT: { called: true, actor: CLIO_CLAIM },
			CLERK: { called: true },
			NO_ORG: { called: true },
		},
	},
	{
		tool: "debate_get_room",
		door: "debate:getRoom",
		args: { roomId: ID },
		pins: {
			MASTER: { called: false, refused: true },
			ORG_TOKEN: { called: false, refused: true },
			SEAT: { called: true, actor: CLIO_CLAIM },
			CLERK: { called: true },
			NO_ORG: { called: false, refused: true },
		},
	},
];

const CLASSES: Record<string, OAuthContext> = {
	MASTER,
	ORG_TOKEN,
	SEAT,
	CLERK,
	NO_ORG,
};

for (const site of SITES) {
	describe(`${site.tool} -> ${site.door}: the answer of each caller class`, () => {
		for (const [cls, pin] of Object.entries(site.pins)) {
			it(`${cls}: ${pin.called ? "door called" : "refused before the door"}${pin.actor ? ", actor forwarded" : ", no actor"}`, async () => {
				const r = await callTool(site.tool, site.door, CLASSES[cls], {
					...site.args,
				});
				expect(r.doorCalls.length > 0, r.text).toBe(pin.called);
				if (pin.refused !== undefined) expect(r.refused).toBe(pin.refused);
				for (const c of r.doorCalls) {
					if (pin.actor) expect(c.args.verifiedActor).toEqual(pin.actor);
					else expect(c.args).not.toHaveProperty("verifiedActor");
					expect(c.args).not.toHaveProperty("verifiedOrg");
				}
			});
		}
	});
}

// ── 3. the KB sites (kbIngest.ts), master class ─────────────────────────────

function kbSetup(ctx: OAuthContext | undefined) {
	const handlers = new Map<
		string,
		(a: Record<string, unknown>) => Promise<unknown>
	>();
	const server = {
		tool: () => undefined,
		registerTool: (
			name: string,
			_c: unknown,
			h: (a: Record<string, unknown>) => Promise<unknown>,
		) => {
			handlers.set(name, h);
		},
	};
	const action = vi.fn().mockResolvedValue({ docId: "d", chunkCount: 1 });
	const mutation = vi
		.fn()
		.mockResolvedValue({ storageId: "sid", orgId: "org-A" });
	registerKbIngestTools(
		server as never,
		{ action, mutation } as unknown as ConvexHttpClient,
		ctx,
	);
	return { handlers, action, mutation };
}

describe("kbIngest.ts: the master is refused before the door where it would be sent claimless", () => {
	const SITES_KB = [
		{
			tool: "store_document_chunked",
			args: { storageId: "s", mimeType: "text/markdown", filename: "a.md" },
		},
		{ tool: "soft_delete_document", args: { docId: "d" } },
		{ tool: "generate_upload_url", args: {} },
		{ tool: "generate_upload_url", args: { sha256: "a".repeat(64) } },
	];
	for (const s of SITES_KB) {
		it(`${s.tool}(${Object.keys(s.args).join(",")}): AUTH_NO_ORG_ID, no door call`, async () => {
			const k = kbSetup(MASTER);
			await expect(k.handlers.get(s.tool)?.(s.args)).rejects.toThrow(
				/AUTH_NO_ORG_ID/,
			);
			expect(k.action).not.toHaveBeenCalled();
			expect(k.mutation).not.toHaveBeenCalled();
		});
	}
	it("claim_upload keeps the master path it has today: the door is called, claimless", async () => {
		const k = kbSetup(MASTER);
		await k.handlers.get("claim_upload")?.({ storageId: "sid", ticket: "t" });
		expect(k.mutation).toHaveBeenCalledTimes(1);
		const [door, args] = k.mutation.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(door).toBe("kbMutations:claimUpload");
		expect(args).not.toHaveProperty("verifiedOrg");
	});
});
