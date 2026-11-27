/**
 * S-35 -- get_issue and issue_stats, driven at the REGISTERED HANDLER, past the wrapper.
 *
 * These tests exist because the wrapper's { kind: "master" } on get_issue and issue_stats makes the
 * in-handler check unreachable through registerTools: the wrapper refuses a non-master caller
 * first, so a test through the registered tool cannot turn the in-handler check red.
 *
 * defineTool is replaced by a pass-through that hands the raw handler to the recording server
 * (the wrapper's scope refusal is not in the path), as the masked mandate handlers are driven
 * in mandate-tools-structured-content.test.ts. A non-master context must get the null answer
 * and the door mock must not be called; a master context is forwarded to the door.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/registerTool.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../src/registerTool.js")>();
	return {
		...original,
		defineTool: (
			server: { registerTool: (...a: unknown[]) => unknown },
			_ctx: unknown,
			_scope: unknown,
			name: string,
			_description: string,
			_schema: unknown,
			...rest: unknown[]
		) => {
			server.registerTool(name, {}, rest[rest.length - 1]);
		},
	};
});

import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Handler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
	structuredContent?: unknown;
	isError?: boolean;
}>;

function rawHandler(
	name: string,
	ctx: OAuthContext | undefined,
	door: unknown,
) {
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool: (n: string, _c: unknown, h: Handler) => handlers.set(n, h),
	} as unknown as Parameters<typeof registerTools>[0];
	const query = vi.fn().mockResolvedValue(door);
	const convex = {
		query,
		mutation: vi.fn(),
		action: vi.fn(),
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, ctx);
	const handler = handlers.get(name);
	if (!handler) throw new Error(`${name} not registered`);
	return { handler, query };
}

const MEMBER: OAuthContext = {
	clientId: "client-fixture-alpha",
	userId: "user-fixture-alpha",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["team/org-fixture-alpha"],
	namespaceWritePrefixes: ["team/org-fixture-alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
	orgClerkId: "org_fixtureAlpha",
};

const ISSUE = { _id: "i1", repo: "o/r", issueNumber: 1, status: "open" };
const STATS = { open: 3, in_progress: 1, fixed: 2, verified: 0, closed: 5 };

describe("S-35 -- get_issue handler, past the wrapper", () => {
	const args = { repo: "o/r", issueNumber: 1 };
	for (const [label, ctx] of [
		["member", MEMBER],
		["no context", undefined],
	] as const) {
		it(`${label}: not-found answer, door not called`, async () => {
			const { handler, query } = rawHandler("get_issue", ctx, ISSUE);
			const res = await handler(args);
			expect(res.isError).not.toBe(true);
			expect(JSON.parse(res.content[0].text)).toEqual({
				error: "Issue not found",
			});
			expect(res.structuredContent).toEqual({ issue: null });
			expect(query).not.toHaveBeenCalled();
		});
	}
	it("master: forwarded to the door, row answered", async () => {
		const { handler, query } = rawHandler(
			"get_issue",
			LOCAL_STDIO_TRUST_CTX,
			ISSUE,
		);
		const res = await handler(args);
		expect(query).toHaveBeenCalledWith("issues:getByRepoNumber", args);
		expect(res.structuredContent).toEqual({ issue: ISSUE });
	});
});

describe("S-35 -- issue_stats handler, past the wrapper", () => {
	for (const [label, ctx] of [
		["member", MEMBER],
		["no context", undefined],
	] as const) {
		it(`${label}: the no-statistics refusal, door not called`, async () => {
			const { handler, query } = rawHandler("issue_stats", ctx, STATS);
			const res = await handler({});
			// The null the pre-read check yields is not a statistics answer: the handler refuses it.
			expect(res.isError).toBe(true);
			expect(res.content[0].text).toBe(
				"Error: issue_stats: no statistics are available to this caller",
			);
			expect(query).not.toHaveBeenCalled();
		});
	}
	it("master: forwarded to the door, counts answered", async () => {
		const { handler, query } = rawHandler(
			"issue_stats",
			LOCAL_STDIO_TRUST_CTX,
			STATS,
		);
		const res = await handler({});
		expect(query).toHaveBeenCalledWith("issues:getStats", {});
		expect(res.structuredContent).toEqual(STATS);
	});
});
