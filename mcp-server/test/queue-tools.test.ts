/**
 * Queue order tools (task k176p84j83gac7reyycweacyb58jvtxg, VantagePeers Cloud + Self-host):
 *   reorder_queue -> tasks:reorderQueue (verifiedActor forwarded, refusals verbatim)
 *   next_task     -> tasks:nextForAssignee (verifiedOrg ALWAYS forwarded, explicit empty)
 *   list_tasks    -> optional sort="queue"; absent = no sort key sent to tasks:list
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	type OAuthContext,
} from "../src/auth.js";
import { MCP_CALLED_FUNCTIONS } from "../src/backendContract.js";
import { listTasksArgsSchema, registerTools } from "../src/tools.js";

const CLIO_ID = "agentclio0000000000000000000001";
const ORG = "acme-hr";
const T1 = "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const T2 = "k17bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
const UNRESOLVED: OAuthContext = { ...base, seatAgent: null };

type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content?: Array<{ text?: string }>;
	structuredContent?: unknown;
}>;
type Call = { kind: string; name: string; args: Record<string, unknown> };

async function run(
	ctx: OAuthContext,
	tool: string,
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
	const make = (kind: string) =>
		vi.fn(async (name: string, a: Record<string, unknown>) => {
			calls.push({ kind, name, args: a });
			if (opts.throws) throw opts.throws;
			return opts.result ?? null;
		});
	const client = { query: make("query"), mutation: make("mutation"), action: make("action") };
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, ctx);
	const handler = tools.get(tool);
	if (!handler) throw new Error(`${tool} was not registered`);
	const r = await handler(args);
	return { calls, refused: r.isError === true, text: r.content?.[0]?.text ?? "", raw: r };
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

describe("reorder_queue", () => {
	it("calls tasks:reorderQueue with the exact args and the verified actor", async () => {
		const r = await run(
			SEAT,
			"reorder_queue",
			{ assignedToAgentId: CLIO_ID, taskIds: [T1, T2] },
			{ result: { ranked: 2, cleared: 1 } },
		);
		expect(r.refused, r.text).toBe(false);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].kind).toBe("mutation");
		expect(r.calls[0].name).toBe("tasks:reorderQueue");
		expect(r.calls[0].args).toEqual({
			assignedToAgentId: CLIO_ID,
			taskIds: [T1, T2],
			verifiedActor: { agentId: CLIO_ID, orgSlug: ORG },
		});
		expect(JSON.parse(r.text)).toEqual({ ranked: 2, cleared: 1 });
	});

	it("[] clears the queue and is forwarded as an empty list", async () => {
		const r = await run(SEAT, "reorder_queue", { assignedToAgentId: CLIO_ID, taskIds: [] }, {
			result: { ranked: 0, cleared: 3 },
		});
		expect(r.calls[0].args.taskIds).toEqual([]);
	});

	it("surfaces a backend refusal verbatim", async () => {
		const msg = "QUEUE_TASK_NOT_ASSIGNED: task k17aaa is not assigned to this assignee";
		const r = await run(
			SEAT,
			"reorder_queue",
			{ assignedToAgentId: CLIO_ID, taskIds: [T1] },
			{ throws: new Error(msg) },
		);
		expect(r.refused).toBe(true);
		expect(r.text).toContain(msg);
	});

	it("is not a read-only tool", async () => {
		const r = await run(SEAT, "reorder_queue", { assignedToAgentId: CLIO_ID, taskIds: [] });
		expect(r.refused).toBe(false);
	});
});

describe("next_task", () => {
	it("forwards verifiedOrg ALWAYS (and no verifiedActor), and returns the task", async () => {
		const task = { _id: T1, title: "Do it", status: "todo", priority: "high", assignedTo: "clio", queueRank: 1 };
		const r = await run(SEAT, "next_task", { assignedToAgentId: CLIO_ID }, {
			result: { found: true, task },
		});
		expect(r.refused, r.text).toBe(false);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].name).toBe("tasks:nextForAssignee");
		expect(r.calls[0].args).toHaveProperty("verifiedOrg");
		expect(r.calls[0].args.verifiedOrg).toBeTruthy();
		// The door admits a verifiedActor only as an operator-org agent; the org alone scopes a seat.
		expect(r.calls[0].args).not.toHaveProperty("verifiedActor");
		expect(r.calls[0].args.assignedToAgentId).toBe(CLIO_ID);
		expect(JSON.parse(r.text)).toEqual({ found: true, task });
	});

	it("forwards assignedTo by name, with verifiedOrg", async () => {
		const r = await run(SEAT, "next_task", { assignedTo: "clio" }, { result: { found: false } });
		expect(r.calls[0].args.assignedTo).toBe("clio");
		expect(r.calls[0].args).toHaveProperty("verifiedOrg");
	});

	it("returns an explicit empty, never a silent one", async () => {
		const r = await run(SEAT, "next_task", { assignedTo: "clio" }, { result: { found: false } });
		expect(r.refused).toBe(false);
		const body = JSON.parse(r.text);
		expect(body.found).toBe(false);
		expect(String(body.message ?? "")).toMatch(/no pickable task/i);
	});

	it("names neither assignee: refused before any Convex call", async () => {
		const r = await run(SEAT, "next_task", {});
		expect(r.refused).toBe(true);
		expect(r.calls).toHaveLength(0);
	});

	it("UNRESOLVED org: Convex is never called", async () => {
		const r = await run(UNRESOLVED, "next_task", { assignedTo: "clio" });
		expect(r.refused).toBe(true);
		expect(r.calls).toHaveLength(0);
	});
});

describe("list_tasks sort", () => {
	it("without sort sends NO sort key (identical to today)", async () => {
		const r = await run(SEAT, "list_tasks", { assignedTo: "clio" }, { result: [] });
		const call = r.calls.find((c) => c.name === "tasks:list");
		expect(call).toBeDefined();
		expect(Object.keys(call?.args ?? {})).not.toContain("sort");
	});

	it('sort="queue" is forwarded', async () => {
		const r = await run(SEAT, "list_tasks", { assignedTo: "clio", sort: "queue" }, { result: [] });
		const call = r.calls.find((c) => c.name === "tasks:list");
		expect(call?.args.sort).toBe("queue");
	});

	it("the args schema accepts only sort=queue", () => {
		expect(listTasksArgsSchema.safeParse({ sort: "queue" }).success).toBe(true);
		expect(listTasksArgsSchema.safeParse({}).success).toBe(true);
		expect(listTasksArgsSchema.safeParse({ sort: "newest" }).success).toBe(false);
	});
});

describe("contract registry", () => {
	it("MCP_CALLED_FUNCTIONS lists both new doors", () => {
		expect(MCP_CALLED_FUNCTIONS).toContain("tasks:reorderQueue");
		expect(MCP_CALLED_FUNCTIONS).toContain("tasks:nextForAssignee");
	});
});
