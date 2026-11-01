/**
 * Task k17cbr6y6da096t5e1k869kgb18hd0ht: the get_tool_usage tool and the wrapper's
 * recording, through the real registerTools.
 *
 *   READ   the tool hands the Convex door the identity facts of the verified
 *          context (the seat's key, or the person's bearer proof), never a
 *          claim of its own; `caller` / `orgSlug` are passed through as asked.
 *   REFUSE a backend RBAC_DENIED surfaces as a tool error, not an empty list.
 *   RECORD a call of any tool files one usage row for the verified caller, and
 *          a backend that rejects the recording does not fail the tool.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
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

const text = (r: unknown): string =>
	(r as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
const isError = (r: unknown): boolean =>
	(r as { isError?: boolean })?.isError === true;

const ORG = "org-a";
const ROWS = [{ tool: "store_memory", firstAt: 1, lastAt: 2, count: 3 }];

function base(): OAuthContext {
	return {
		clientId: "client-a",
		userId: "user_sub",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "scoped-a",
		fromAllowList: [],
		namespaceReadPrefixes: [`team/${ORG}`],
		namespaceWritePrefixes: [`team/${ORG}`],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		clerkOrgSlug: ORG,
		orgClerkId: "org_a",
	};
}

const seat: OAuthContext = {
	...base(),
	actor: { agentId: "agent-1", orgSlug: ORG, agentName: "seat" },
};
const person: OAuthContext = {
	...base(),
	principal: "person",
	accessTokenHash: "hash-1",
};

function setup(
	oauthCtx: OAuthContext,
	over: { query?: unknown; mutation?: unknown } = {},
	record = true,
) {
	const query = vi.fn(over.query ?? (async () => ROWS));
	const mutation = vi.fn(over.mutation ?? (async () => ({ recorded: true })));
	const convex = { query, mutation } as unknown as ConvexHttpClient;
	const { server, handlers } = buildFakeServer();
	registerTools(server, convex, oauthCtx, { recordToolUsage: record });
	return { query, mutation, handlers };
}

const toolUsageCalls = (mutation: ReturnType<typeof vi.fn>) =>
	mutation.mock.calls.filter((c) => c[0] === "toolUsage:record");

describe("get_tool_usage", () => {
	it("a seat reads its own rows with its verified agent key", async () => {
		const { query, handlers } = setup(seat);
		const r = await handlers.get("get_tool_usage")?.({});
		expect(isError(r)).toBe(false);
		expect(JSON.parse(text(r))).toEqual(ROWS);
		expect(query).toHaveBeenCalledWith("toolUsage:getToolUsage", {
			selfKey: "agent:agent-1",
			verifiedOrg: { orgSlug: ORG },
		});
	});

	it("a person bearer sends its token proof, and no key of its own", async () => {
		const { query, handlers } = setup(person);
		await handlers.get("get_tool_usage")?.({ caller: "agent:agent-1" });
		expect(query).toHaveBeenCalledWith("toolUsage:getToolUsage", {
			caller: "agent:agent-1",
			verifiedPerson: { accessTokenHash: "hash-1" },
			verifiedOrg: { orgSlug: ORG },
		});
	});

	it("the master passes the organisation it names", async () => {
		const { query, handlers } = setup(LOCAL_STDIO_TRUST_CTX);
		await handlers.get("get_tool_usage")?.({
			caller: "user:u1",
			orgSlug: "org-b",
		});
		expect(query).toHaveBeenCalledWith("toolUsage:getToolUsage", {
			caller: "user:u1",
			verifiedOrg: { orgSlug: "org-b" },
		});
	});

	it("a backend refusal is a tool error naming RBAC_DENIED, not an empty list", async () => {
		const { handlers } = setup(seat, {
			query: async () => {
				throw new Error("RBAC_DENIED: not-org-admin");
			},
		});
		const r = await handlers.get("get_tool_usage")?.({
			caller: "user:someone",
		});
		expect(isError(r)).toBe(true);
		expect(text(r)).toContain("RBAC_DENIED");
	});
});

describe("get_owner_tool_usage and the unidentified bearer", () => {
	it("a person bearer reads an owner with its token proof", async () => {
		const { query, handlers } = setup(person);
		const r = await handlers.get("get_owner_tool_usage")?.({
			ownerUserId: "user_owner",
		});
		expect(JSON.parse(text(r))).toEqual(ROWS);
		expect(query).toHaveBeenCalledWith("toolUsage:usageByOwner", {
			ownerUserId: "user_owner",
			verifiedPerson: { accessTokenHash: "hash-1" },
			verifiedOrg: { orgSlug: ORG },
		});
	});

	it("a seat reads with its agent key", async () => {
		const { query, handlers } = setup(seat);
		await handlers.get("get_owner_tool_usage")?.({ ownerUserId: "user_owner" });
		expect(query).toHaveBeenCalledWith("toolUsage:usageByOwner", {
			ownerUserId: "user_owner",
			selfKey: "agent:agent-1",
			verifiedOrg: { orgSlug: ORG },
		});
	});

	it("an org-level bearer that resolves no identity is refused BEFORE Convex (it must never look like the org-scoped service caller)", async () => {
		const { query, handlers } = setup(base());
		for (const [tool, args] of [
			["get_owner_tool_usage", { ownerUserId: "user_owner" }],
			["get_tool_usage", {}],
		] as const) {
			const r = await handlers.get(tool)?.(args);
			expect(isError(r)).toBe(true);
			expect(text(r)).toContain("needs a caller identity");
		}
		expect(query).not.toHaveBeenCalled();
	});
});

describe("the wrapper records through registerTools", () => {
	it("a call files one usage row for the verified seat", async () => {
		const { mutation, handlers } = setup(seat);
		await handlers.get("get_tool_usage")?.({});
		await new Promise((res) => setTimeout(res, 5));
		expect(toolUsageCalls(mutation)).toEqual([
			[
				"toolUsage:record",
				{
					toolName: "get_tool_usage",
					caller: "agent:agent-1",
					verifiedOrg: { orgSlug: ORG },
				},
			],
		]);
	});

	it("a backend that rejects the recording does not fail the tool", async () => {
		const { handlers } = setup(seat, {
			mutation: async () => {
				throw new Error("convex down");
			},
		});
		const r = await handlers.get("get_tool_usage")?.({});
		await new Promise((res) => setTimeout(res, 5));
		expect(isError(r)).toBe(false);
		expect(JSON.parse(text(r))).toEqual(ROWS);
	});

	it("the HTTP entry turns recording on (activation pin, not just capability)", () => {
		const src = readFileSync(
			fileURLToPath(new URL("../server-http.ts", import.meta.url)),
			"utf8",
		);
		expect(src).toMatch(
			/registerTools\(server, convex, oauthCtx, \{ recordToolUsage: true \}\)/,
		);
	});

	it("a registration without the option files nothing", async () => {
		const { mutation, handlers } = setup(seat, {}, false);
		await handlers.get("get_tool_usage")?.({});
		await new Promise((res) => setTimeout(res, 5));
		expect(toolUsageCalls(mutation)).toHaveLength(0);
	});

	it("the master bearer files nothing", async () => {
		const { mutation, handlers } = setup(LOCAL_STDIO_TRUST_CTX);
		await handlers.get("get_tool_usage")?.({ caller: "user:u1", orgSlug: "org-b" });
		await new Promise((res) => setTimeout(res, 5));
		expect(toolUsageCalls(mutation)).toHaveLength(0);
	});
});
