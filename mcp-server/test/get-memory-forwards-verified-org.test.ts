/**
 * S-28 batch 3, site tools.ts memories:getMemory [get_memory]: the door accepts
 * `verifiedOrg` (convex/memories.ts, DOOR_SCOPE "memories:getMemory": always), so
 * the tool forwards the bearer's verified org, the way get_episode does.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer() {
	const handlers = new Map<string, ToolHandler>();
	const capture = (...args: unknown[]): unknown => {
		handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
		return {};
	};
	return {
		server: { tool: capture, registerTool: capture } as unknown as McpServer,
		handlers,
	};
}

const MEMORY_ID = `row${"1".padStart(29, "0")}`;

const bearer = (extra: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "client-org-a",
	userId: "user-org-a",
	scopes: ["vantage:read"],
	scopeProfile: "scoped-org-a",
	fromAllowList: ["alice"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: "org-a",
	...extra,
});

async function callGetMemory(ctx: OAuthContext) {
	const { server, handlers } = buildFakeServer();
	const query = vi.fn(async () => ({
		_id: MEMORY_ID,
		_creationTime: 1,
		namespace: "team/org-a",
		type: "feedback",
		content: "own",
		createdBy: "alice",
		createdAt: 1,
	}));
	registerTools(
		server,
		{ query, mutation: vi.fn(), action: vi.fn() } as unknown as ConvexHttpClient,
		ctx,
	);
	await handlers.get("get_memory")?.({ memoryId: MEMORY_ID });
	return query.mock.calls as unknown as [string, Record<string, unknown>][];
}

describe("get_memory forwards the verified org to memories:getMemory", () => {
	it("a verified bearer: the door receives verifiedOrg", async () => {
		const calls = await callGetMemory(bearer());
		const door = calls.filter(([fn]) => fn === "memories:getMemory");
		expect(door).toHaveLength(1);
		expect(door[0][1]).toMatchObject({
			memoryId: MEMORY_ID,
			verifiedOrg: { orgSlug: "org-a" },
		});
	});

	it("the master forwards no claim (unchanged)", async () => {
		const calls = await callGetMemory(
			bearer({ isMaster: true, clerkOrgSlug: undefined }),
		);
		const door = calls.filter(([fn]) => fn === "memories:getMemory");
		expect(door).toHaveLength(1);
		expect(door[0][1].verifiedOrg).toBeUndefined();
	});
});
