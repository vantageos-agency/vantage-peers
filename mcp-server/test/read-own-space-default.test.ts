/**
 * A non-master session that omits `namespace` on a memory/episode READ reads its
 * own space (VantagePeers Cloud, task k177e8dyrnykk3c56yf2b0pgfs8hhz06).
 *
 * Measured on production 2026-11-11 (`node scripts/client-seat-matrix.mjs
 * --live`, agent seat probe-a): recall, text_search, hybrid_search,
 * list_episodes, search_episodes_by_keyword and search_episodes_by_semantic
 * called without namespace were refused "this tool requires an explicit
 * namespace argument", while the server instructions (src/brand.ts, item 3) say
 * "an omitted namespace means your own space".
 *
 * The read side now mirrors the write side: an omitted namespace becomes the
 * session's default_write_namespace (defaultWriteNamespace: a person's single
 * team/<org> write prefix, a seat's orchestrator/<its agent ID>), then the read
 * check runs on that value. Nothing widens: the value is one the session could
 * already name explicitly.
 *
 * Poles, for an agent seat AND a person:
 *   SERVED  each of the six tools without namespace is served, the Convex call
 *           receives the default namespace, and only rows of that namespace come
 *           back (a row in another readable namespace of the same session and a
 *           row in another org are seeded and never returned);
 *   DENIED  a seat with no default namespace keeps the explicit-namespace
 *           refusal, and Convex is never called;
 *   DENIED  another org's namespace passed explicitly is still refused;
 *   MASTER  omitting namespace is unchanged: Convex receives no namespace.
 *
 * Harness: the real registerTools + defineTool wrapper (registerTool.ts) over a
 * recording Convex client. The recorder answers like the backend does for a
 * namespace (rows of that namespace) and for none (every row, the list-across
 * shape the Day-88 refusal exists for), so a handler that forwarded no
 * namespace would return the other org's row and fail the SERVED pole.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolResult = {
	isError?: boolean;
	content: { text: string }[];
	structuredContent?: Record<string, unknown>;
};
type Tool = (
	args: Record<string, unknown>,
	extra?: unknown,
) => Promise<ToolResult>;
type Call = { fn: string; args: Record<string, unknown> };
type Row = {
	memoryId: string;
	namespace: string;
	type: string;
	content: string;
	createdBy: string;
};

const SEAT_OWN = "orchestrator/agent123";
const PERSON_OWN = "team/acme";
const OTHER_ORG_NS = "team/other-org";

/** Rows seeded in the recorder: own space, another readable space, another org. */
const ROWS: Row[] = [
	{
		memoryId: "m-seat-own",
		namespace: SEAT_OWN,
		type: "episode",
		content: "seat own",
		createdBy: "alpha",
	},
	{
		memoryId: "m-person-own",
		namespace: PERSON_OWN,
		type: "episode",
		content: "person own",
		createdBy: "alpha",
	},
	{
		memoryId: "m-project",
		namespace: "project/acme",
		type: "episode",
		content: "project",
		createdBy: "alpha",
	},
	{
		memoryId: "m-other-org",
		namespace: OTHER_ORG_NS,
		type: "episode",
		content: "other org",
		createdBy: "intruder",
	},
];

const SEAT: OAuthContext = {
	clientId: "seat",
	userId: "seat",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "acme-seat",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["team/acme", "project/acme"],
	namespaceWritePrefixes: ["team/acme", "project/acme"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	ownAgentNamespace: SEAT_OWN,
	ownProjectNamespace: "project/acme",
};

/** A person: rights as convex/lib/tokenRights.ts personTokenRights derives them. */
const PERSON: OAuthContext = {
	clientId: "claude",
	userId: "user_person",
	scopes: ["mcp:full"],
	scopeProfile: "team-member",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["team/acme", "project/acme"],
	namespaceWritePrefixes: ["team/acme"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	principal: "person",
};

/** A seat that resolved no agent and holds several write prefixes: no default. */
const NO_DEFAULT_SEAT: OAuthContext = {
	...SEAT,
	ownAgentNamespace: undefined,
	ownProjectNamespace: undefined,
};

const MASTER: OAuthContext = {
	...SEAT,
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	isMaster: true,
	ownAgentNamespace: undefined,
	ownProjectNamespace: undefined,
};

function recorder() {
	const calls: Call[] = [];
	const rowsFor = (args: Record<string, unknown>) =>
		ROWS.filter(
			(r) =>
				(args.namespace === undefined || r.namespace === args.namespace) &&
				(args.type === undefined || r.type === args.type),
		);
	const answer = (fn: string, args: Record<string, unknown>) => {
		calls.push({ fn, args });
		if (fn === "memories:listMemories") {
			return { value: rowsFor(args), continueCursor: null, isDone: true };
		}
		return rowsFor(args);
	};
	return {
		calls,
		client: {
			query: async (fn: string, args: Record<string, unknown>) =>
				answer(fn, args),
			action: async (fn: string, args: Record<string, unknown>) =>
				answer(fn, args),
			mutation: async (fn: string, args: Record<string, unknown>) =>
				answer(fn, args),
		},
	};
}

function toolsFor(ctx: OAuthContext) {
	const rec = recorder();
	const tools = new Map<string, Tool>();
	const server = {
		tool() {},
		registerTool: (name: string, _config: unknown, handler: Tool) => {
			tools.set(name, handler);
		},
	} as never;
	// biome-ignore lint/suspicious/noExplicitAny: recording Convex client
	registerTools(server, rec.client as any, ctx);
	return { tools, calls: rec.calls };
}

/** The six reads, the Convex function each forwards to, and its plain arguments. */
const READS: { tool: string; fn: string; args: Record<string, unknown> }[] = [
	{ tool: "recall", fn: "search:recall", args: { query: "own" } },
	{ tool: "text_search", fn: "search:textSearch", args: { query: "own" } },
	{ tool: "hybrid_search", fn: "search:hybridSearch", args: { query: "own" } },
	{ tool: "list_episodes", fn: "memories:listMemories", args: {} },
	{
		tool: "search_episodes_by_keyword",
		fn: "search:textSearch",
		args: { query: "own" },
	},
	{
		tool: "search_episodes_by_semantic",
		fn: "search:recall",
		args: { query: "own" },
	},
];

function rowsOf(r: ToolResult): Row[] {
	const parsed = JSON.parse(r.content[0].text) as Row[] | { items: Row[] };
	return Array.isArray(parsed) ? parsed : parsed.items;
}

async function call(
	ctx: OAuthContext,
	tool: string,
	args: Record<string, unknown>,
) {
	const { tools, calls } = toolsFor(ctx);
	const handler = tools.get(tool);
	expect(handler, tool).toBeDefined();
	const result = (await handler?.(args, {})) as ToolResult;
	return { result, calls };
}

describe.each([
	{ who: "agent seat", ctx: SEAT, own: SEAT_OWN, ownRow: "m-seat-own" },
	{ who: "person", ctx: PERSON, own: PERSON_OWN, ownRow: "m-person-own" },
])("SERVED: a $who omitting namespace reads its own space", ({
	ctx,
	own,
	ownRow,
}) => {
	it.each(READS)("$tool: served from $fn with the own namespace only", async ({
		tool,
		fn,
		args,
	}) => {
		const { result, calls } = await call(ctx, tool, args);
		expect(result.isError, result.content[0]?.text).toBeFalsy();
		const forwarded = calls.filter((c) => c.fn === fn);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0].args.namespace).toBe(own);
		const ids = rowsOf(result).map((r) => r.memoryId);
		expect(ids).toEqual([ownRow]);
		expect(ids).not.toContain("m-other-org");
		expect(ids).not.toContain("m-project");
	});
});

describe("DENIED: a seat with no default namespace keeps the explicit-namespace refusal", () => {
	it.each(READS)("$tool: refused, Convex never called", async ({
		tool,
		args,
	}) => {
		const { result, calls } = await call(NO_DEFAULT_SEAT, tool, args);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(
			/requires an explicit namespace argument/,
		);
		expect(calls).toHaveLength(0);
	});
});

describe.each([
	{ who: "agent seat", ctx: SEAT },
	{ who: "person", ctx: PERSON },
])("DENIED: a $who naming another org's namespace is still refused", ({
	ctx,
}) => {
	it.each(READS)("$tool: refused, Convex never called", async ({
		tool,
		args,
	}) => {
		const { result, calls } = await call(ctx, tool, {
			...args,
			namespace: OTHER_ORG_NS,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			`namespace='${OTHER_ORG_NS}' is not readable`,
		);
		expect(calls).toHaveLength(0);
	});
});

describe("MASTER: omitting namespace is unchanged (every namespace)", () => {
	it.each(READS)("$tool: Convex receives no namespace", async ({
		tool,
		fn,
		args,
	}) => {
		const { result, calls } = await call(MASTER, tool, args);
		expect(result.isError, result.content[0]?.text).toBeFalsy();
		const forwarded = calls.filter((c) => c.fn === fn);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0].args.namespace).toBeUndefined();
	});
});
