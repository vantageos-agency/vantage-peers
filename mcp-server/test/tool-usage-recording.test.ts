/**
 * Task k17cbr6y6da096t5e1k869kgb18hd0ht: the tool wrapper (registerTool.ts
 * defineTool) records which tool a caller called, once the call resolved.
 *
 *   - a resolved call (success OR tool error) is recorded, by tool name;
 *   - a scope refusal is NOT recorded (the tool never ran);
 *   - a recording failure (sync throw or rejected promise) never fails the tool;
 *   - the caller key comes from the verified oauthContext, never a tool argument;
 *   - a master / unidentified caller sends nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { OAuthContext } from "../src/auth.js";
import { defineTool, type ToolAuthContext } from "../src/registerTool.js";
import { recordToolUsage, toolUsageCallerOf } from "../src/toolUsage.js";

type Handler = (
	args: Record<string, unknown>,
	extra: unknown,
) => Promise<{ content: unknown[]; isError?: boolean }>;

function fakeServer() {
	const handlers = new Map<string, Handler>();
	return {
		handlers,
		registerTool: (name: string, _cfg: unknown, h: Handler) => {
			handlers.set(name, h);
		},
	};
}

function org(over: Partial<OAuthContext> = {}): OAuthContext {
	return {
		clientId: "c1",
		userId: "user_sub1",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 60_000,
		isMaster: false,
		clerkOrgSlug: "acme",
		orgClerkId: "org_acme",
		...over,
	};
}

async function call(
	ctx: ToolAuthContext,
	scope: Parameters<typeof defineTool>[2],
	handler: Handler,
) {
	const server = fakeServer();
	defineTool(
		// biome-ignore lint/suspicious/noExplicitAny: fake server
		server as any,
		ctx,
		scope,
		"my_tool",
		"d",
		{ x: z.string().optional() },
		{ readOnlyHint: true },
		// biome-ignore lint/suspicious/noExplicitAny: handler shape
		handler as any,
	);
	return server.handlers.get("my_tool")?.({}, {});
}

describe("defineTool records tool usage after the call resolves", () => {
	it("records a successful call by tool name", async () => {
		const recordUsage = vi.fn();
		await call(
			{ oauthCtx: org(), recordUsage },
			{ kind: "public" },
			async () => ({
				content: [],
			}),
		);
		expect(recordUsage).toHaveBeenCalledTimes(1);
		expect(recordUsage).toHaveBeenCalledWith("my_tool");
	});

	it("records a tool error result too", async () => {
		const recordUsage = vi.fn();
		const r = await call(
			{ oauthCtx: org(), recordUsage },
			{ kind: "public" },
			async () => ({ content: [], isError: true }),
		);
		expect(r?.isError).toBe(true);
		expect(recordUsage).toHaveBeenCalledTimes(1);
	});

	it("records a handler that throws, and still throws", async () => {
		const recordUsage = vi.fn();
		await expect(
			call({ oauthCtx: org(), recordUsage }, { kind: "public" }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(recordUsage).toHaveBeenCalledTimes(1);
	});

	it("does NOT record a scope refusal (master-only tool, non-master caller)", async () => {
		const recordUsage = vi.fn();
		const handler = vi.fn(async () => ({ content: [] }));
		const r = await call(
			{ oauthCtx: org(), recordUsage },
			{ kind: "master" },
			handler,
		);
		expect(r?.isError).toBe(true);
		expect(handler).not.toHaveBeenCalled();
		expect(recordUsage).not.toHaveBeenCalled();
	});

	it("a recorder that throws synchronously does not fail the tool", async () => {
		const recordUsage = vi.fn(() => {
			throw new Error("recorder down");
		});
		const r = await call(
			{ oauthCtx: org(), recordUsage },
			{ kind: "public" },
			async () => ({ content: [{ type: "text", text: "ok" }] }),
		);
		expect(r?.isError).toBeUndefined();
		expect(r?.content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("a recorder that rejects does not fail the tool (no unhandled rejection)", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		const recordUsage = vi.fn(async () => {
			throw new Error("recorder rejected");
		});
		const r = await call(
			{ oauthCtx: org(), recordUsage },
			{ kind: "public" },
			async () => ({ content: [] }),
		);
		await new Promise((res) => setTimeout(res, 10));
		process.off("unhandledRejection", unhandled);
		expect(r?.isError).toBeUndefined();
		expect(unhandled).not.toHaveBeenCalled();
	});

	it("no recorder on the context: the tool runs unchanged", async () => {
		const r = await call(
			{ oauthCtx: org() },
			{ kind: "public" },
			async () => ({
				content: [],
			}),
		);
		expect(r?.isError).toBeUndefined();
	});
});

describe("toolUsageCallerOf: the caller key is the verified identity", () => {
	it("a person token is user:<verified subject>", () => {
		expect(
			toolUsageCallerOf(
				org({ principal: "person", accessTokenHash: "h", userId: "user_p" }),
			),
		).toEqual({ send: true, callerKey: "user:user_p" });
	});
	it("a person acting through its personal agent is still the person", () => {
		expect(
			toolUsageCallerOf(
				org({
					principal: "person",
					accessTokenHash: "h",
					userId: "user_p",
					actor: { orgSlug: "acme", agentName: "pa", agentId: "agent1" },
				}),
			),
		).toEqual({ send: true, callerKey: "user:user_p" });
	});
	it("an agent credential is agent:<agent id>", () => {
		expect(
			toolUsageCallerOf(
				org({ actor: { orgSlug: "acme", agentName: "n", agentId: "agent7" } }),
			),
		).toEqual({ send: true, callerKey: "agent:agent7" });
	});
	it("a one-agent seat is agent:<seat agent id>", () => {
		expect(
			toolUsageCallerOf(
				org({
					seatAgent: { agentId: "agent9", orgId: "acme", agentName: "n" },
				}),
			),
		).toEqual({ send: true, callerKey: "agent:agent9" });
	});
	it("a Clerk session sends no key (Convex derives it from the JWT)", () => {
		expect(toolUsageCallerOf(org({ clerkJwt: "jwt" }))).toEqual({
			send: true,
		});
	});
	it("master, no context, and an org-level seat with no agent send nothing", () => {
		expect(toolUsageCallerOf(undefined)).toEqual({ send: false });
		expect(toolUsageCallerOf(org({ isMaster: true }))).toEqual({
			send: false,
		});
		expect(toolUsageCallerOf(org())).toEqual({ send: false });
	});
});

describe("recordToolUsage", () => {
	it("calls toolUsage:record with the tool and key, never an org or an argument", async () => {
		const mutation = vi.fn(async () => ({ recorded: true }));
		await recordToolUsage(
			{ mutation } as never,
			org({ actor: { orgSlug: "acme", agentName: "n", agentId: "agent7" } }),
			"store_memory",
		);
		expect(mutation).toHaveBeenCalledWith("toolUsage:record", {
			toolName: "store_memory",
			caller: "agent:agent7",
		});
	});
	it("sends nothing for a master caller", async () => {
		const mutation = vi.fn();
		await recordToolUsage({ mutation } as never, org({ isMaster: true }), "x");
		expect(mutation).not.toHaveBeenCalled();
	});
	it("swallows a rejected or throwing client", async () => {
		const ctx = org({ clerkJwt: "j" });
		await expect(
			recordToolUsage(
				{ mutation: async () => Promise.reject(new Error("net")) } as never,
				ctx,
				"x",
			),
		).resolves.toBeUndefined();
		await expect(
			recordToolUsage(
				{
					mutation: () => {
						throw new Error("sync");
					},
				} as never,
				ctx,
				"x",
			),
		).resolves.toBeUndefined();
	});
});
