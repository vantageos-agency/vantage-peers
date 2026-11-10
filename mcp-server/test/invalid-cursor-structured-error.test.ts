/**
 * An invalid cursor passed as a TOOL ARGUMENT is a tool result with
 * isError: true whose structuredContent.error.code is "invalid_cursor"
 * (VantagePeers Cloud MCP, task k171rk9evy8yy48tfx765zqwk18hwdvh, mcp-doctor
 * rule C11, tool pole).
 *
 * Rule source: resources/references/mcp-standard.md line 83, C-11 (b)
 * (ElPi-Corp main @ 0e26fa5c), after SEP-1303. The protocol pole (an invalid
 * cursor on a protocol list method is -32602) is a different surface and is
 * not exercised here.
 *
 * Three poles per tool, all on the handler as registered (the SDK's own
 * behaviour on the wire is pinned by the "invalid-cursor" pole of
 * test/output-schema-structured-content.test.ts):
 *   - INVALID: a cursor that does not decode is refused with the stable code;
 *   - VALID:   a cursor the tool emits is still decoded and reaches Convex;
 *   - OTHER:   any other error (a Convex failure) keeps its current shape,
 *              isError with no structuredContent.
 *
 * The tools: the eleven the mcp-doctor report at 56425010 names (each takes a
 * cursor and no required argument), plus the two advertised cursor tools that
 * do require an argument (list_memories, list_tasks_by_mission), which the
 * doctor could not call but which decode their cursor the same way.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { encodeCursor } from "../src/paging.js";
import { registerTools } from "../src/tools.js";

type ToolResult = {
	content?: Array<{ type?: string; text?: string }>;
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
};
type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** The literal cursor mcp-doctor sends: base64url garbage that decodes to no JSON. */
const INVALID_CURSOR = "mcp-doctor:invalid-cursor:%%%";
const ANCHOR_TIME = 1_700_000_000_123;
const ANCHOR_BACKEND = "convex-continue-cursor-0001";

const master = (): OAuthContext => ({
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: true,
});

function harness(fail = false) {
	const handlers = new Map<string, Handler>();
	const calls: Array<{ fn: string; args: unknown }> = [];
	const server = {
		tool: (...a: unknown[]) => {
			handlers.set(a[0] as string, a[a.length - 1] as Handler);
			return {};
		},
		registerTool: (...a: unknown[]) => {
			handlers.set(a[0] as string, a[a.length - 1] as Handler);
			return {};
		},
	} as unknown as McpServer;
	const answer = async (fn: unknown, args: unknown) => {
		calls.push({ fn: String(fn), args });
		if (fail) throw new Error("backend unavailable");
		return {
			items: [],
			page: [],
			nextCursor: null,
			isDone: true,
			continueCursor: "",
		};
	};
	const convex = {
		query: answer,
		mutation: answer,
		action: answer,
	} as unknown as ConvexHttpClient;
	registerTools(server, convex, master());
	return {
		calls,
		call: async (name: string, args: Record<string, unknown>) => {
			const h = handlers.get(name);
			if (!h) throw new Error(`${name} not registered`);
			return (await h(args)) as ToolResult;
		},
	};
}

/** [tool, required args, a valid cursor of the form that tool emits, the anchor it must forward]. */
const TOOLS: Array<[string, Record<string, unknown>, string, string | number]> =
	[
		[
			"list_episodes",
			{},
			encodeCursor({ backendCursor: ANCHOR_BACKEND }),
			ANCHOR_BACKEND,
		],
		[
			"list_peers",
			{},
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
		[
			"list_messages",
			{},
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
		[
			"list_tasks",
			{},
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
		[
			"list_missions",
			{},
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
		[
			"list_diaries",
			{},
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
		[
			"list_briefing_notes",
			{},
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
		[
			"list_recurring_tasks",
			{},
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
		[
			"list_repo_mappings",
			{},
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
		[
			"get_github_owner_bindings",
			{},
			encodeCursor({ backendCursor: ANCHOR_BACKEND }),
			ANCHOR_BACKEND,
		],
		[
			"list_fix_patterns",
			{},
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
		[
			"list_memories",
			{ namespace: "global" },
			encodeCursor({ backendCursor: ANCHOR_BACKEND }),
			ANCHOR_BACKEND,
		],
		[
			"list_tasks_by_mission",
			{ missionId: "k57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
			encodeCursor({ createdBefore: ANCHOR_TIME }),
			ANCHOR_TIME,
		],
	];

describe("an invalid cursor argument is isError with structuredContent.error.code invalid_cursor", () => {
	for (const [tool, args] of TOOLS) {
		it(`${tool}: INVALID cursor -> isError, error.code "invalid_cursor", a message`, async () => {
			const r = await harness().call(tool, { ...args, cursor: INVALID_CURSOR });
			expect(r.isError, JSON.stringify(r)).toBe(true);
			const error = r.structuredContent?.error as
				| { code?: unknown; message?: unknown }
				| undefined;
			expect(error?.code, JSON.stringify(r)).toBe("invalid_cursor");
			expect(typeof error?.message).toBe("string");
			expect(String(error?.message)).toMatch(/invalid cursor/i);
			// The text a client without structuredContent support reads still says so.
			expect(r.content?.[0]?.text).toMatch(/invalid cursor/i);
			// Nothing but the error rides the structuredContent.
			expect(Object.keys(r.structuredContent ?? {})).toEqual(["error"]);
		});

		it(`${tool}: an EMPTY cursor is the first page, not an invalid one`, async () => {
			const r = await harness().call(tool, { ...args, cursor: "" });
			expect(r.structuredContent?.error).toBeUndefined();
		});
	}
});

describe("a valid cursor still pages", () => {
	for (const [tool, args, cursor, anchor] of TOOLS) {
		it(`${tool}: the cursor it emits is decoded and its anchor reaches Convex`, async () => {
			const h = harness();
			const r = await h.call(tool, { ...args, cursor });
			expect(r.isError, JSON.stringify(r)).not.toBe(true);
			expect(JSON.stringify(h.calls)).toContain(JSON.stringify(anchor));
		});
	}
});

describe("any other error keeps its current shape: isError, no structuredContent", () => {
	for (const [tool, args, cursor] of TOOLS) {
		it(`${tool}: a Convex failure on a valid cursor`, async () => {
			const r = await harness(true).call(tool, { ...args, cursor });
			expect(r.isError, JSON.stringify(r)).toBe(true);
			expect(r.structuredContent).toBeUndefined();
		});
	}
});

describe("get_github_owner_bindings: its cursors are opaque, so an invalid one is known before Convex", () => {
	it("nextCursor and unprovenNextCursor are encoded, and decode back to the Convex cursor", async () => {
		const handlers = new Map<string, Handler>();
		const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
		const server = {
			tool: () => ({}),
			registerTool: (...a: unknown[]) => {
				handlers.set(a[0] as string, a[a.length - 1] as Handler);
				return {};
			},
		} as unknown as McpServer;
		const convex = {
			query: async (fn: unknown, args: Record<string, unknown>) => {
				calls.push({ fn: String(fn), args });
				return { items: [], nextCursor: `${String(fn)}#next` };
			},
		} as unknown as ConvexHttpClient;
		registerTools(server, convex, master());
		const h = handlers.get("get_github_owner_bindings") as Handler;
		const first = (await h({ limit: 1 })) as ToolResult;
		const sc = first.structuredContent as {
			nextCursor: string;
			unprovenNextCursor: string;
		};
		expect(sc.nextCursor).not.toBe("githubOwnerBinding:listBindings#next");
		expect(sc.unprovenNextCursor).not.toBe(
			"githubOwnerBinding:listUnprovenMappings#next",
		);
		calls.length = 0;
		await h({
			limit: 1,
			cursor: sc.nextCursor,
			unprovenCursor: sc.unprovenNextCursor,
		});
		expect(
			calls.find((c) => c.fn === "githubOwnerBinding:listBindings")?.args
				.cursor,
		).toBe("githubOwnerBinding:listBindings#next");
		expect(
			calls.find((c) => c.fn === "githubOwnerBinding:listUnprovenMappings")
				?.args.cursor,
		).toBe("githubOwnerBinding:listUnprovenMappings#next");
	});

	it("an invalid unprovenCursor is refused the same way, before any Convex call", async () => {
		const h = harness();
		const r = await h.call("get_github_owner_bindings", {
			unprovenCursor: INVALID_CURSOR,
		});
		expect(r.isError).toBe(true);
		expect((r.structuredContent?.error as { code?: string })?.code).toBe(
			"invalid_cursor",
		);
		expect(h.calls).toEqual([]);
	});

	it("a null nextCursor (the list is exhausted) stays null", async () => {
		const r = await harness().call("get_github_owner_bindings", {});
		expect(r.structuredContent?.nextCursor).toBeNull();
	});
});
