/**
 * list_blocked_on_me: the tool calls tasks:listBlockedOnMe and forwards the
 * reader's PROOF the way check_messages does (verifiedActor for a seat,
 * verifiedOrg for an org-level token, never both, nothing for an unresolved
 * org). VantagePeers Cloud (multi-tenant). The tool never invents an empty list
 * from a refusal.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	type OAuthContext,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const CLIO_ID = "agentclio0000000000000000000001";
const ORG = "iris-rh";

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
const ORG_TOKEN: OAuthContext = { ...base, clerkOrgSlug: ORG, seatAgent: null };
const UNRESOLVED: OAuthContext = { ...base, seatAgent: null };

type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content?: Array<{ text?: string }>;
}>;
type Call = { name: string; args: Record<string, unknown> };

const RESULT = {
	entries: [
		{
			blockedTaskId: "k1",
			blockedTitle: "U",
			blockedAssignee: "beta",
			onTaskId: "k2",
			onTaskTitle: "T",
			age: 1000,
		},
	],
	total: 1,
	truncated: false,
	oldestAge: 1000,
};

async function run(
	ctx: OAuthContext,
	args: Record<string, unknown>,
	opts: { throws?: Error; result?: unknown } = {},
) {
	const tools = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		tools.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const server = { tool: reg, registerTool: reg } as unknown as McpServer;
	const calls: Call[] = [];
	const client = {
		query: vi.fn(async (name: string, a: Record<string, unknown>) => {
			calls.push({ name, args: a });
			if (opts.throws) throw opts.throws;
			return opts.result ?? RESULT;
		}),
		mutation: vi.fn(async () => null),
		action: vi.fn(async () => null),
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, ctx);
	const handler = tools.get("list_blocked_on_me");
	if (!handler) throw new Error("list_blocked_on_me was not registered");
	const r = await handler(args);
	return {
		calls,
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

describe("list_blocked_on_me", () => {
	it("SEAT: calls tasks:listBlockedOnMe with verifiedActor and no verifiedOrg", async () => {
		const r = await run(SEAT, {});
		expect(r.refused).toBe(false);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].name).toBe("tasks:listBlockedOnMe");
		expect(r.calls[0].args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: ORG,
		});
		expect(r.calls[0].args).not.toHaveProperty("verifiedOrg");
		expect(JSON.parse(r.text)).toEqual(RESULT);
	});

	it("ORG-LEVEL token: sends verifiedOrg and never the recipient name, never verifiedActor", async () => {
		const r = await run(ORG_TOKEN, { recipient: "clio" });
		expect(r.calls[0].name).toBe("tasks:listBlockedOnMe");
		expect(r.calls[0].args.verifiedOrg).toEqual({ orgSlug: ORG });
		expect(r.calls[0].args).not.toHaveProperty("recipient");
		expect(r.calls[0].args).not.toHaveProperty("verifiedActor");
	});

	it("UNRESOLVED org: Convex is never called and the refusal is returned", async () => {
		const r = await run(UNRESOLVED, { recipient: "clio" });
		expect(r.refused).toBe(true);
		expect(r.calls).toHaveLength(0);
		expect(r.text).toContain("RBAC_DENIED");
	});

	it("a recipient name is not an authority gate and is never forwarded: Convex decides by the verified ID", async () => {
		const r = await run(SEAT, { recipient: "someone-else" });
		expect(r.refused).toBe(false);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].args).not.toHaveProperty("recipient");
		expect(r.calls[0].args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: ORG,
		});
		expect(r.text).not.toContain("Forbidden");
	});

	it("a backend refusal surfaces as an error, never as an empty list", async () => {
		const err = Object.assign(new Error("[Request ID: x] Server Error"), {
			data: 'RBAC_DENIED: no verified reader — {"reason":"reader-unidentified","door":"tasks:listBlockedOnMe"}',
		});
		const r = await run(SEAT, {}, { throws: err });
		expect(r.refused).toBe(true);
		expect(r.text).toContain("RBAC_DENIED");
		expect(r.text).not.toContain('"entries"');
	});

	it("an empty backend list is passed through as a real absence", async () => {
		const empty = { entries: [], total: 0, truncated: false, oldestAge: 0 };
		const r = await run(SEAT, {}, { result: empty });
		expect(r.refused).toBe(false);
		expect(JSON.parse(r.text)).toEqual(empty);
	});

	it("limit trims entries but total still counts every waiter", async () => {
		const many = {
			entries: Array.from({ length: 5 }, (_, i) => ({
				...RESULT.entries[0],
				blockedTaskId: `k${i}`,
			})),
			total: 5,
			truncated: false,
			oldestAge: 9,
		};
		const r = await run(SEAT, { limit: 2 }, { result: many });
		const out = JSON.parse(r.text);
		expect(out.entries).toHaveLength(2);
		expect(out.total).toBe(5);
		expect(r.calls[0].args).not.toHaveProperty("limit");
	});
});
