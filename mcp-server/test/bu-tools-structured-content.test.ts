/**
 * The business-unit tools (create_bu, update_bu, get_bu, list_bus, delete_bu)
 * declare an outputSchema and answer every success with a structuredContent
 * that validates against it (VantagePeers Cloud + Self-host, MCP server; S-51,
 * S-53, S-54 of mcp-doctor).
 *
 * Call shape: registerTools() is the REAL production function; the server is a
 * recording stand-in that keeps each tool's registered config (so its declared
 * outputSchema is read from the registration itself) and its handler, and the
 * Convex client is a mock keyed by function path, answering the shape each
 * door's `returns:` validator promises (convex/businessUnits.ts). The BU tools
 * are masked from tools/list (tool-exposure.json), so they are driven through
 * their handlers, as test/mandate-tools-structured-content.test.ts does.
 *
 * Each success: the text is unchanged (the two-space JSON of the answer) and
 * structuredContent is that same object (list_bus: { items, nextCursor,
 * truncated } whose items are the rows the text shows). Each refusal keeps
 * isError and carries no structuredContent.
 */

import { describe, expect, it } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Captured = {
	config: {
		outputSchema?: { safeParse: (v: unknown) => { success: boolean } };
	};
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
		registerTool: (
			name: string,
			config: Captured["config"],
			handler: never,
		) => {
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

const BU_ID = "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const fullRow = (over: Record<string, unknown> = {}) => ({
	_id: BU_ID,
	_creationTime: 1_700_000_000_000,
	name: "VantagePeers",
	description: "Shared memory for agents",
	purpose: "Make agent teams persistent",
	orchestratorId: "alpha",
	status: "building",
	businessModel: "subscription",
	targetCustomers: "agent teams",
	services: ["MCP"],
	pricing: "per seat",
	revenueProjections: { y1: 0, y2: 50000, y3: 200000 },
	coreTeam: { agents: ["alpha"], skills: [], hooks: [], plugins: [] },
	coreProcesses: ["release"],
	dependencies: [],
	kpis: ["ARR"],
	managementFee: 10,
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
	...over,
});

const createArgs = {
	name: "VantagePeers",
	description: "Shared memory for agents",
	purpose: "Make agent teams persistent",
	orchestratorId: "alpha",
	status: "building",
	businessModel: "subscription",
	targetCustomers: "agent teams",
	services: ["MCP"],
	pricing: "per seat",
	revenueProjections: { y1: 0, y2: 50000, y3: 200000 },
	coreTeam: { agents: ["alpha"], skills: [], hooks: [], plugins: [] },
	coreProcesses: ["release"],
	dependencies: [],
	kpis: ["ARR"],
};

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
	expect(
		res.structuredContent,
		`${name} answers structuredContent`,
	).toBeDefined();
	const parsed = (schema as NonNullable<typeof schema>).safeParse(
		res.structuredContent,
	);
	expect(parsed.success, JSON.stringify(parsed)).toBe(true);
	expect(res.content).toHaveLength(1);
	expect(res.content[0].type).toBe("text");
	return res;
}

describe("create_bu", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({ "businessUnits:create": () => BU_ID });
		const res = await success(h, "create_bu", createArgs);
		expect(res.structuredContent).toEqual({
			buId: BU_ID,
			name: "VantagePeers",
			orchestratorId: "alpha",
			status: "building",
		});
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
		expect(h.calls.map((c) => c.fn)).toContain("businessUnits:create");
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		const h = harness({
			"businessUnits:create": () => {
				throw new Error("orchestrator not on your roster");
			},
		});
		const res = await h.tool("create_bu").handler(createArgs);
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("update_bu", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({ "businessUnits:update": () => null });
		const res = await success(h, "update_bu", {
			buId: BU_ID,
			callerOrchestrator: "alpha",
			status: "live",
		});
		expect(res.structuredContent).toEqual({ buId: BU_ID, updated: true });
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
		expect(h.calls.map((c) => c.fn)).toContain("businessUnits:update");
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		const h = harness({
			"businessUnits:update": () => {
				throw new Error("only the owning orchestrator may update");
			},
		});
		const res = await h.tool("update_bu").handler({
			buId: BU_ID,
			callerOrchestrator: "gamma",
			status: "live",
		});
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("get_bu", () => {
	it("declares its schema and answers the row as structuredContent, equal to its text", async () => {
		const stored = fullRow({
			domain: "vantagepeers.com",
			orgId: "org_1",
			clerkOrgId: "org_clerk_1",
			ownerId: "agent_1",
		});
		const h = harness({ "businessUnits:get": () => stored });
		const res = await success(h, "get_bu", { buId: BU_ID });
		expect(res.structuredContent).toEqual(stored);
		expect(res.content[0].text).toBe(JSON.stringify(stored, null, 2));
	});

	it("a business unit that is not there stays an error with no structuredContent", async () => {
		const h = harness({ "businessUnits:get": () => null });
		const res = await h.tool("get_bu").handler({ buId: BU_ID });
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("list_bus", () => {
	it("a page under the cap: items are the rows the text shows, nextCursor null, truncated false", async () => {
		const rows = [
			fullRow(),
			fullRow({ _id: "j57bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Other" }),
		];
		const h = harness({
			"businessUnits:list": () => ({ items: rows, nextCursor: null }),
		});
		const res = await success(h, "list_bus", {});
		expect(res.structuredContent).toEqual({
			items: rows,
			nextCursor: null,
			truncated: false,
		});
		expect(JSON.parse(res.content[0].text)).toEqual({
			items: rows,
			nextCursor: null,
		});
	});

	it("fields=lite rows validate too", async () => {
		const lite = [
			{
				_id: BU_ID,
				_creationTime: 1_700_000_000_000,
				name: "VantagePeers",
				status: "live",
				orchestratorId: "alpha",
			},
		];
		const h = harness({
			"businessUnits:list": () => ({ items: lite, nextCursor: null }),
		});
		const res = await success(h, "list_bus", { fields: "lite" });
		expect(res.structuredContent).toEqual({
			items: lite,
			nextCursor: null,
			truncated: false,
		});
	});

	it("the door's {time,id} nextCursor is forwarded in both channels (#1807 kept)", async () => {
		const door = btoa(JSON.stringify({ time: 1_699_000_000_000, id: BU_ID }));
		const h = harness({
			"businessUnits:list": () => ({ items: [fullRow()], nextCursor: door }),
		});
		const res = await success(h, "list_bus", { limit: 1 });
		const text = JSON.parse(res.content[0].text) as { nextCursor: string };
		expect(text.nextCursor).toBe(door);
		expect(
			(res.structuredContent as { nextCursor: string | null }).nextCursor,
		).toBe(door);
		// and the cursor is accepted back, verbatim, by the next call
		await success(h, "list_bus", { limit: 1, cursor: door });
		const second = h.calls.filter((c) => c.fn === "businessUnits:list")[1];
		expect(second.args.cursor).toBe(door);
	});

	it("an empty page validates", async () => {
		const h = harness({
			"businessUnits:list": () => ({ items: [], nextCursor: null }),
		});
		const res = await success(h, "list_bus", {});
		expect(res.structuredContent).toEqual({
			items: [],
			nextCursor: null,
			truncated: false,
		});
	});

	it("a cursor of an unknown shape is refused with no structuredContent of a page", async () => {
		const h = harness({
			"businessUnits:list": () => ({ items: [], nextCursor: null }),
		});
		const res = await h.tool("list_bus").handler({ cursor: "not-a-cursor" });
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toEqual({
			error: { code: "invalid_cursor", message: expect.any(String) },
		});
		expect(h.calls).toHaveLength(0);
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		const h = harness({
			"businessUnits:list": () => {
				throw new Error("RBAC_DENIED");
			},
		});
		const res = await h.tool("list_bus").handler({});
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});

describe("delete_bu", () => {
	it("declares its schema and answers structuredContent equal to its text", async () => {
		const h = harness({ "businessUnits:remove": () => ({ deleted: true }) });
		const res = await success(h, "delete_bu", { buId: BU_ID });
		expect(res.structuredContent).toEqual({ deleted: true });
		expect(res.content[0].text).toBe(
			JSON.stringify(res.structuredContent, null, 2),
		);
		expect(h.calls.map((c) => c.fn)).toContain("businessUnits:remove");
	});

	it("a refusal from the door stays an error with no structuredContent", async () => {
		const h = harness({
			"businessUnits:remove": () => {
				throw new Error("only the fleet master may delete");
			},
		});
		const res = await h.tool("delete_bu").handler({ buId: BU_ID });
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toBeUndefined();
	});
});
