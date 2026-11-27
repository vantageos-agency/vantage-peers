/**
 * The mandate tools (create_mandate, accept_mandate, update_mandate,
 * settle_mandate, validate_mandate_spending, get_mandate, list_mandates)
 * declare an outputSchema and answer every success with a structuredContent
 * that validates against it (VantagePeers Cloud + Self-host, MCP server; S-51,
 * S-53, S-54 of mcp-doctor).
 *
 * Call shape: registerTools() is the REAL production function; the server is a
 * recording stand-in that keeps each tool's registered config (so its declared
 * outputSchema is read from the registration itself) and its handler, and the
 * Convex client is a mock keyed by function path, answering the shape each
 * door's `returns:` validator promises (convex/mandates.ts). The mandate tools
 * are masked from tools/list (tool-exposure.json), so they are driven through
 * their handlers, as test/grant-aware-scope-filter-missions-mandates.test.ts
 * does.
 *
 * Each success: the text is unchanged (the two-space JSON of the answer) and
 * structuredContent is that same object (a list: { items, nextCursor,
 * truncated } whose items are the rows the text shows). Each refusal keeps
 * isError and carries no structuredContent.
 */

import { describe, expect, it } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Captured = {
	config: { outputSchema?: { safeParse: (v: unknown) => { success: boolean } } };
	handler: (args: Record<string, unknown>) => Promise<{
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		structuredContent?: Record<string, unknown>;
	}>;
};

type Door = (args: Record<string, unknown>) => unknown;

function harness(
	doors: Record<string, Door>,
	oauthCtx: OAuthContext = LOCAL_STDIO_TRUST_CTX,
) {
	const tools = new Map<string, Captured>();
	const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
	const server = {
		registerTool: (name: string, config: Captured["config"], handler: never) => {
			tools.set(name, { config, handler });
		},
	} as unknown as Parameters<typeof registerTools>[0];
	const door = async (fn: unknown, args: unknown) => {
		const path = String(fn);
		calls.push({ fn: path, args: args as Record<string, unknown> });
		const d = doors[path];
		if (d === undefined) throw new Error(`no door mocked for ${path}`);
		return d(args as Record<string, unknown>);
	};
	const convex = {
		query: door,
		mutation: door,
		action: door,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, oauthCtx);
	return {
		calls,
		tool: (name: string) => {
			const t = tools.get(name);
			if (t === undefined) throw new Error(`${name} not registered`);
			return t;
		},
	};
}

const MANDATE_ID = "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const row = (over: Record<string, unknown> = {}) => ({
	_id: MANDATE_ID,
	_creationTime: 1_700_000_000_000,
	requestedBy: "alpha",
	fulfilledBy: "beta",
	service: "code review",
	budget: 5000,
	status: "requested",
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
	...over,
});

/** The tool answered a success whose structuredContent validates against its declared schema. */
async function success(
	h: ReturnType<typeof harness>,
	name: string,
	args: Record<string, unknown>,
) {
	const t = h.tool(name);
	const schema = t.config.outputSchema;
	expect(schema, `${name} declares an outputSchema`).toBeDefined();
	const res = await t.handler(args);
	expect(res.isError, res.content?.[0]?.text).not.toBe(true);
	expect(res.structuredContent, `${name} answers structuredContent`).toBeDefined();
	const parsed = (schema as NonNullable<typeof schema>).safeParse(
		res.structuredContent,
	);
	expect(parsed.success, JSON.stringify(parsed)).toBe(true);
	expect(res.content).toHaveLength(1);
	expect(res.content[0].type).toBe("text");
	return res;
}

describe("create_mandate", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({
			"mandates:create": () => MANDATE_ID,
		});
		const res = await success(h, "create_mandate", {
			requestedBy: "alpha",
			fulfilledBy: "beta",
			service: "code review",
			budget: 5000,
		});
		expect(res.structuredContent).toEqual({
			mandateId: MANDATE_ID,
			requestedBy: "alpha",
			fulfilledBy: "beta",
			service: "code review",
			budget: 5000,
		});
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		const h = harness({
			"mandates:create": () => {
				throw new Error("not the fleet master");
			},
		});
		const res = await h.tool("create_mandate").handler({
			requestedBy: "alpha",
			fulfilledBy: "beta",
			service: "code review",
			budget: 5000,
		});
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("accept_mandate", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({ "mandates:accept": () => null });
		const res = await success(h, "accept_mandate", {
			mandateId: MANDATE_ID,
			callerOrchestrator: "beta",
		});
		expect(res.structuredContent).toEqual({
			mandateId: MANDATE_ID,
			status: "accepted",
		});
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
		expect(h.calls.map((c) => c.fn)).toContain("mandates:accept");
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		const h = harness({
			"mandates:accept": () => {
				throw new Error("only the fulfiller may accept");
			},
		});
		const res = await h.tool("accept_mandate").handler({
			mandateId: MANDATE_ID,
			callerOrchestrator: "gamma",
		});
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("update_mandate", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({ "mandates:update": () => null });
		const res = await success(h, "update_mandate", {
			mandateId: MANDATE_ID,
			callerOrchestrator: "beta",
			tokensCost: 1200,
			status: "delivered",
		});
		expect(res.structuredContent).toEqual({
			mandateId: MANDATE_ID,
			updated: true,
		});
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
		expect(h.calls.map((c) => c.fn)).toContain("mandates:update");
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		const h = harness({
			"mandates:update": () => {
				throw new Error("only the fulfiller may update");
			},
		});
		const res = await h.tool("update_mandate").handler({
			mandateId: MANDATE_ID,
			callerOrchestrator: "gamma",
			tokensCost: 1,
		});
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("settle_mandate", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({ "mandates:settle": () => null });
		const res = await success(h, "settle_mandate", {
			mandateId: MANDATE_ID,
			callerOrchestrator: "alpha",
			finalCost: 4800,
		});
		expect(res.structuredContent).toEqual({
			mandateId: MANDATE_ID,
			status: "settled",
			finalCost: 4800,
		});
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
		expect(h.calls.map((c) => c.fn)).toContain("mandates:settle");
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		const h = harness({
			"mandates:settle": () => {
				throw new Error("only the requester may settle");
			},
		});
		const res = await h.tool("settle_mandate").handler({
			mandateId: MANDATE_ID,
			callerOrchestrator: "gamma",
			finalCost: 1,
		});
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("validate_mandate_spending", () => {
	it("a spend within the limits: schema declared, structuredContent equal to the text", async () => {
		const answer = {
			withinLimits: true,
			currentSpend: 1000,
			remainingBudget: 4000,
			perTransactionLimit: 800,
			perPeriodLimit: 2500,
		};
		const h = harness({ "mandates:validateSpending": () => answer });
		const res = await success(h, "validate_mandate_spending", {
			mandateId: MANDATE_ID,
			proposedAmount: 500,
		});
		expect(res.structuredContent).toEqual(answer);
		expect(res.content[0].text).toBe(JSON.stringify(answer, null, 2));
	});

	it("a spend over the limits (reason present, limits absent) validates too", async () => {
		const answer = {
			withinLimits: false,
			reason: "proposedAmount 9000 exceeds the remaining budget 4000",
			currentSpend: 1000,
			remainingBudget: 4000,
		};
		const h = harness({ "mandates:validateSpending": () => answer });
		const res = await success(h, "validate_mandate_spending", {
			mandateId: MANDATE_ID,
			proposedAmount: 9000,
		});
		expect(res.structuredContent).toEqual(answer);
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		const h = harness({
			"mandates:validateSpending": () => {
				throw new Error("mandate not found");
			},
		});
		const res = await h.tool("validate_mandate_spending").handler({
			mandateId: MANDATE_ID,
			proposedAmount: 1,
		});
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("get_mandate", () => {
	it("declares its schema and answers the row as structuredContent, equal to its text", async () => {
		const stored = row({
			status: "in_progress",
			tokensCost: 120,
			linkedTaskIds: ["k17taskaaaaaaaaaaaaaaaaaaaaaaaaa"],
			spendingLimits: { maxPerTransaction: 800, maxPerPeriod: 2500, periodDays: 30 },
			approvedCategories: ["review"],
			mandateDocument: "doc-1",
		});
		const h = harness({ "mandates:get": () => stored });
		const res = await success(h, "get_mandate", { mandateId: MANDATE_ID });
		expect(res.structuredContent).toEqual(stored);
		expect(res.content[0].text).toBe(JSON.stringify(stored, null, 2));
	});

	it("a mandate that is not there stays an error with no structuredContent", async () => {
		const h = harness({ "mandates:get": () => null });
		const res = await h
			.tool("get_mandate")
			.handler({ mandateId: MANDATE_ID });
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("list_mandates", () => {
	it("a page under the cap: items are the rows the text shows, nextCursor null, truncated false", async () => {
		const rows = [row(), row({ _id: "j57bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", status: "settled", tokensCost: 4800, completedAt: 1_700_000_100_000 })];
		const h = harness({ "mandates:list": () => rows });
		const res = await success(h, "list_mandates", {});
		expect(res.structuredContent).toEqual({
			items: rows,
			nextCursor: null,
			truncated: false,
		});
		expect(res.content[0].text).toBe(JSON.stringify(rows, null, 2));
	});

	it("a full page carries the cursor in both channels", async () => {
		const rows = [row(), row({ _id: "j57bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", _creationTime: 1_699_000_000_000 })];
		const h = harness({ "mandates:list": () => rows });
		const res = await success(h, "list_mandates", { limit: 2 });
		const text = JSON.parse(res.content[0].text) as {
			items: unknown[];
			nextCursor: string;
		};
		const sc = res.structuredContent as {
			items: unknown[];
			nextCursor: string | null;
			truncated: boolean;
		};
		expect(typeof text.nextCursor).toBe("string");
		expect(sc.items).toEqual(text.items);
		expect(sc.nextCursor).toBe(text.nextCursor);
		expect(sc.truncated).toBe(false);
	});

	it("an empty list validates", async () => {
		const h = harness({ "mandates:list": () => [] });
		const res = await success(h, "list_mandates", {});
		expect(res.structuredContent).toEqual({
			items: [],
			nextCursor: null,
			truncated: false,
		});
		expect(res.content[0].text).toBe("[]");
	});

	it("the typed refusal envelope stays an error with no structuredContent", async () => {
		const h = harness({
			"mandates:list": () => ({ refused: true, items: [] }),
		});
		const res = await h.tool("list_mandates").handler({});
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});

	it("an invalid cursor keeps its own error shape", async () => {
		const h = harness({ "mandates:list": () => [] });
		const res = await h.tool("list_mandates").handler({ cursor: "not-a-cursor" });
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toEqual({
			error: { code: "invalid_cursor", message: expect.any(String) },
		});
	});
});
