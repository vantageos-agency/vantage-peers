/**
 * Bipolar probe for defineTool (mission vp-multitenant-zero-hole-v1, S2).
 *
 * Two proofs:
 *  1. TYPE-CASE (RED at compile time): a registration that omits `scope`, or
 *     declares an unknown/permissive scope, must fail `tsc`. Proven with
 *     `@ts-expect-error` — if the type ever allowed omission, the directive
 *     becomes unused and `tsc --noEmit` fails. Run: `npx tsc --noEmit`.
 *  2. RUNTIME (MUST_BLOCK / MUST_PASS): the wrapper actually applies the shared
 *     auth predicates for enforceable scopes, and lets legitimately-public and
 *     legitimately-internal (service-account/master) callers through.
 *
 * defineTool is positional: (server, ctx, scope, name, description, schema,
 * annotations?, handler). `scope` (3rd arg) is required by the type.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { OAuthContext } from "../auth.js";
import { defineTool } from "../registerTool.js";

// Minimal McpServer stub that captures the guarded handler defineTool registers.
function stubServer(): {
	server: McpServer;
	invoke: (args: Record<string, unknown>) => Promise<{ isError?: boolean }>;
} {
	let captured: ((a: unknown, e: unknown) => unknown) | null = null;
	const server = {
		tool: (...call: unknown[]) => {
			captured = call[call.length - 1] as (a: unknown, e: unknown) => unknown;
		},
		registerTool: (...call: unknown[]) => {
			captured = call[call.length - 1] as (a: unknown, e: unknown) => unknown;
		},
	} as unknown as McpServer;
	return {
		server,
		invoke: async (args) => {
			if (!captured) throw new Error("tool not registered");
			return (await captured(args, {})) as { isError?: boolean };
		},
	};
}

const okHandler = async () => ({
	content: [{ type: "text" as const, text: "ok" }],
});

const masterCtx: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

// A real tenant-scoped identity (e.g. Clerk team-member) that owns team/acme.
const teamCtx: OAuthContext = {
	clientId: "dcr-clerk-acme",
	userId: "user_1",
	scopes: ["mcp:full"],
	scopeProfile: "team-member",
	fromAllowList: [],
	namespaceReadPrefixes: ["team/acme"],
	namespaceWritePrefixes: ["team/acme"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

// The MCP server's own service account (legacy bearer path has no oauthCtx).
const serviceAccountCtx = undefined;

describe("defineTool — runtime scope enforcement (MUST_BLOCK / MUST_PASS)", () => {
	it("write: BLOCKS a tenant writing outside its namespace", async () => {
		const { server, invoke } = stubServer();
		defineTool(
			server,
			{ oauthCtx: teamCtx },
			{ kind: "write", namespaceArg: "namespace" },
			"t",
			"d",
			{ namespace: z.string() },
			okHandler,
		);
		const res = await invoke({ namespace: "team/other" });
		expect(res.isError).toBe(true);
	});

	it("write: PASSES a tenant writing its own namespace", async () => {
		const { server, invoke } = stubServer();
		defineTool(
			server,
			{ oauthCtx: teamCtx },
			{ kind: "write", namespaceArg: "namespace" },
			"t",
			"d",
			{ namespace: z.string() },
			okHandler,
		);
		const res = await invoke({ namespace: "team/acme/notes" });
		expect(res.isError).toBeUndefined();
	});

	it("read: BLOCKS a list-across (namespace undefined) from a scoped tenant", async () => {
		const { server, invoke } = stubServer();
		defineTool(
			server,
			{ oauthCtx: teamCtx },
			{ kind: "read", namespaceArg: "namespace" },
			"t",
			"d",
			{ namespace: z.string().optional() },
			okHandler,
		);
		const res = await invoke({});
		expect(res.isError).toBe(true);
	});

	it("master: BLOCKS a non-master tenant", async () => {
		const { server, invoke } = stubServer();
		defineTool(
			server,
			{ oauthCtx: teamCtx },
			{ kind: "master" },
			"t",
			"d",
			{},
			okHandler,
		);
		const res = await invoke({});
		expect(res.isError).toBe(true);
	});

	it("master: PASSES the master scope", async () => {
		const { server, invoke } = stubServer();
		defineTool(
			server,
			{ oauthCtx: masterCtx },
			{ kind: "master" },
			"t",
			"d",
			{},
			okHandler,
		);
		const res = await invoke({});
		expect(res.isError).toBeUndefined();
	});

	it("master: PASSES the service-account (legacy bearer, no oauthCtx)", async () => {
		const { server, invoke } = stubServer();
		defineTool(
			server,
			{ oauthCtx: serviceAccountCtx },
			{ kind: "master" },
			"t",
			"d",
			{},
			okHandler,
		);
		const res = await invoke({});
		expect(res.isError).toBeUndefined();
	});

	it("public: PASSES any authenticated caller (explicitly declared, not defaulted)", async () => {
		const { server, invoke } = stubServer();
		defineTool(
			server,
			{ oauthCtx: teamCtx },
			{ kind: "public", reason: "server capability discovery" },
			"t",
			"d",
			{},
			okHandler,
		);
		const res = await invoke({});
		expect(res.isError).toBeUndefined();
	});

	it("from: BLOCKS an identity not in the allowlist", async () => {
		const { server, invoke } = stubServer();
		const scopedFrom: OAuthContext = { ...teamCtx, fromAllowList: ["nadia"] };
		defineTool(
			server,
			{ oauthCtx: scopedFrom },
			{ kind: "from", fromArg: "createdBy" },
			"t",
			"d",
			{ createdBy: z.string() },
			okHandler,
		);
		const res = await invoke({ createdBy: "someone-else" });
		expect(res.isError).toBe(true);
	});
});

describe("defineTool — type-level: scope is mandatory (RED at compile time)", () => {
	it("omitting scope does not compile", () => {
		const { server } = stubServer();
		defineTool(
			server,
			{},
			// @ts-expect-error — `scope` (3rd arg) is required; a string name here
			// where a ToolScope is expected must fail tsc.
			"t",
			"d",
			{},
			okHandler,
		);
		expect(true).toBe(true);
	});

	it("an unknown/permissive-default scope kind does not compile", () => {
		const { server } = stubServer();
		defineTool(
			server,
			{},
			// @ts-expect-error — there is no permissive/default kind; only the
			// enumerated members of ToolScope are assignable.
			{ kind: "everyone" },
			"t",
			"d",
			{},
			okHandler,
		);
		expect(true).toBe(true);
	});

	it("public without a reason does not compile (forces justification)", () => {
		const { server } = stubServer();
		defineTool(
			server,
			{},
			// @ts-expect-error — `public` requires an explicit `reason` string.
			{ kind: "public" },
			"t",
			"d",
			{},
			okHandler,
		);
		expect(true).toBe(true);
	});
});
