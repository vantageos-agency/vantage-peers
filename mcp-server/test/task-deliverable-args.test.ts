/**
 * Task deliverable (task k17cn84f2hm555cgqeegw0bq7n8ahsak): the MCP tools carry
 * the optional `deliverable` {pkg, export} to the Convex doors verbatim and pass
 * the derived `deliverableDivergence` through.
 *
 *   FORWARD   create_task / update_task send `deliverable` unchanged
 *   ABSENT    no deliverable given -> no `deliverable` key sent (call unchanged)
 *   REFUSE    a malformed deliverable is refused at the tool schema, before Convex
 *   LITE      list_tasks lite projection carries `deliverableDivergence` only when
 *             the backend set it; a row without it keeps the 6-key lite shape
 *   FULL      get_task passes the stored deliverable fields through untouched
 *   CONTRACT  the new argument bumped the contract: MCP requires 6, Convex serves 6
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BACKEND_CONTRACT_VERSION } from "../../convex/lib/backendManifest";
import type { OAuthContext } from "../src/auth.js";
import { REQUIRED_CONTRACT_VERSION } from "../src/backendContract";
import { registerTools } from "../src/tools.js";

type Result = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function seat(): OAuthContext {
	return {
		clientId: "client-clio",
		userId: "user-clio",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "clio-acme-hr",
		fromAllowList: ["clio", "helios"],
		namespaceReadPrefixes: ["team/acme-hr"],
		namespaceWritePrefixes: ["team/acme-hr"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		accessTokenHash: "hash-clio",
		clerkOrgSlug: "acme-hr",
		seatAgent: { agentId: "jh72scrneffpeqwy51rg8hny1x8fv2c4", orgId: "acme-hr", agentName: "clio" },
	};
}

type Call = { kind: string; name: string; args: Record<string, unknown> };

function harness(rows: Record<string, unknown>[] = []) {
	const handlers = new Map<string, Handler>();
	const shapes = new Map<string, z.ZodTypeAny>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		const config = a[1] as { inputSchema?: z.ZodTypeAny } | undefined;
		if (config?.inputSchema) shapes.set(a[0] as string, config.inputSchema);
		return {};
	};
	const calls: Call[] = [];
	const convex = {
		query: async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "query", name, args });
			if (name === "tasks:list") return rows;
			if (name === "tasks:getById") return rows[0] ?? null;
			if (name.startsWith("orgRoster:")) return ["clio", "helios"];
			return [];
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "mutation", name, args });
			return "doc-id";
		},
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(
		{ registerTool: reg, tool: reg } as unknown as Parameters<typeof registerTools>[0],
		convex,
		seat(),
	);
	const call = (tool: string, args: Record<string, unknown>) => {
		const h = handlers.get(tool);
		if (!h) throw new Error(`${tool} not registered`);
		return h(args);
	};
	const to = (name: string) => calls.filter((c) => c.kind !== "query" && c.name === name);
	return { call, to, shapes };
}

const DELIVERABLE = { pkg: "@vantageos/widget", export: "WidgetPanel" };

describe("FORWARD / ABSENT", () => {
	it("create_task forwards deliverable verbatim", async () => {
		const h = harness();
		const res = await h.call("create_task", {
			title: "t", assignedTo: "clio", priority: "low", status: "todo",
			createdBy: "clio", deliverable: DELIVERABLE,
		});
		expect(res.isError).toBeFalsy();
		expect(h.to("tasks:create")[0]?.args.deliverable).toEqual(DELIVERABLE);
	});

	it("create_task without deliverable sends no deliverable key", async () => {
		const h = harness();
		await h.call("create_task", {
			title: "t", assignedTo: "clio", priority: "low", status: "todo", createdBy: "clio",
		});
		expect(h.to("tasks:create")[0]?.args).not.toHaveProperty("deliverable");
	});

	it("update_task forwards deliverable verbatim, and omits the key when absent", async () => {
		const h = harness();
		await h.call("update_task", {
			taskId: "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", callerOrchestrator: "clio", deliverable: DELIVERABLE,
		});
		expect(h.to("tasks:update")[0]?.args.deliverable).toEqual(DELIVERABLE);
		const h2 = harness();
		await h2.call("update_task", {
			taskId: "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", callerOrchestrator: "clio", priority: "high",
		});
		expect(h2.to("tasks:update")[0]?.args).not.toHaveProperty("deliverable");
	});
});

describe("REFUSE — malformed deliverable never reaches the tool body", () => {
	const minimal: Record<string, Record<string, unknown>> = {
		create_task: { title: "t", assignedTo: "clio", priority: "low", status: "todo" },
		update_task: { taskId: "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
	};
	it.each(["create_task", "update_task"])("%s schema accepts a well-formed deliverable and rejects malformed ones", (tool) => {
		const schema = harness().shapes.get(tool);
		expect(schema).toBeDefined();
		const parse = (deliverable: unknown) =>
			schema?.safeParse({ ...minimal[tool], deliverable }).success;
		expect(parse(DELIVERABLE)).toBe(true);
		expect(parse(undefined)).toBe(true);
		expect(parse({ pkg: "", export: "A" })).toBe(false);
		expect(parse({ pkg: "p" })).toBe(false);
		expect(parse("p#A")).toBe(false);
		expect(parse({ ...DELIVERABLE, repo: "x" })).toBe(false);
	});
});

describe("LITE / FULL projections", () => {
	const base = {
		_id: "k17bbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		_creationTime: 5,
		title: "t",
		status: "todo",
		priority: "low",
		assignedTo: "clio",
		createdBy: "clio",
		orgId: "acme-hr",
	};

	it("lite carries deliverableDivergence only when the backend set it", async () => {
		const withD = { ...base, deliverable: DELIVERABLE, deliverableDivergence: "delivered-but-open" };
		const h = harness([withD, { ...base, _id: "k17ccccccccccccccccccccccccccccc" }]);
		const res = await h.call("list_tasks", {});
		expect(res.isError).toBeFalsy();
		const parsed = JSON.parse(res.content[0]?.text ?? "null") as Array<Record<string, unknown>>;
		const rows = Array.isArray(parsed) ? parsed : [];
		const a = rows.find((r) => r._id === withD._id);
		const b = rows.find((r) => r._id === "k17ccccccccccccccccccccccccccccc");
		expect(a?.deliverableDivergence).toBe("delivered-but-open");
		expect(a).not.toHaveProperty("deliverable");
		expect(Object.keys(b ?? {}).sort()).toEqual(
			["_creationTime", "_id", "assignedTo", "priority", "status", "title"].sort(),
		);
	});

	it("get_task passes the stored deliverable fields and the divergence through", async () => {
		const row = {
			...base,
			deliverable: DELIVERABLE,
			deliverableState: { state: "delivered", version: "1.0.0", checkedAt: 9 },
			deliverableDivergence: "delivered-but-open",
		};
		const h = harness([row]);
		const res = await h.call("get_task", { taskId: row._id });
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(res.content[0]?.text ?? "null")).toMatchObject({
			status: "todo",
			deliverable: DELIVERABLE,
			deliverableState: { state: "delivered", version: "1.0.0" },
			deliverableDivergence: "delivered-but-open",
		});
	});
});

describe("CONTRACT", () => {
	it("MCP requires the contract version Convex serves, and it is 6", () => {
		expect(REQUIRED_CONTRACT_VERSION).toBe(6);
		expect(BACKEND_CONTRACT_VERSION).toBe(6);
	});
});
