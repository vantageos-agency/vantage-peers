/**
 * scope-bound-after-filter.test.ts — task k179f1mq0sp896p0jp183b5yks8b12qj.
 *
 * THE CLASS: a bound (page-full test, receipt cap) is evaluated AFTER the
 * scope filter narrowed the population it describes, so a scoped caller whose
 * rows were removed reads a shorter list that is byte-identical to an empty
 * population ("you may not" == "there is nothing"), and the continuation
 * cursor is lost because the filtered page no longer looks full.
 *
 * Each tool is pinned by three poles:
 *   NEGATIVE  scoped caller, a population that EXISTS but is removed by the
 *             scope filter -> output DISTINCT from the same caller on an empty
 *             population (carries `scopeFiltered`, and keeps the cursor when
 *             the raw page was full).
 *   ABSENT    scoped caller, empty population -> bare empty array, no flag.
 *   PRESENT   scoped caller, rows inside its reach, page not full -> unchanged
 *             bare shape, no `scopeFiltered` key.
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

function alphaCtx(): OAuthContext {
	return {
		clientId: "client-alpha",
		userId: "user-alpha",
		scopes: ["vantage:read"],
		scopeProfile: "tenant-alpha",
		fromAllowList: ["alpha"],
		namespaceReadPrefixes: ["orchestrator/alpha", "project/alpha"],
		namespaceWritePrefixes: ["project/alpha"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		clerkOrgSlug: "org-fixture-alpha",
	};
}

type Handler = (args: any) => Promise<any>;

function capture(
	queryReturns: Record<string, unknown>,
	ctx: OAuthContext,
): Map<string, Handler> {
	const tools = new Map<string, Handler>();
	const server = {
		tool: (name: string, ...rest: any[]) => {
			tools.set(name, rest[rest.length - 1]);
		},
		registerTool: (name: string, ...rest: any[]) => {
			tools.set(name, rest[rest.length - 1]);
		},
	} as any;
	const convex = {
		query: async (path: string) =>
			path in queryReturns ? queryReturns[path] : null,
		mutation: async () => null,
		action: async () => null,
	} as any;
	registerTools(server, convex, ctx);
	return tools;
}

async function call(
	queryPath: string,
	rows: unknown,
	tool: string,
	args: Record<string, unknown>,
): Promise<any> {
	const tools = capture({ [queryPath]: rows }, alphaCtx());
	const res = await tools.get(tool)!(args);
	expect(res.isError).not.toBe(true);
	return JSON.parse(res.content[0].text);
}

const items = (parsed: any): any[] =>
	Array.isArray(parsed)
		? parsed
		: (parsed.items ?? parsed.issues ?? parsed.receipts ?? []);

interface Site {
	tool: string;
	path: string;
	args: Record<string, unknown>;
	mine: (n: number) => Record<string, unknown>;
	foreign: (n: number) => Record<string, unknown>;
}

const SITES: Site[] = [
	{
		tool: "list_recurring_tasks",
		path: "recurringTasks:list",
		args: { limit: 2 },
		mine: (n) => ({ _id: `r${n}`, _creationTime: 100 - n, createdBy: "alpha" }),
		foreign: (n) => ({ _id: `r${n}`, _creationTime: 100 - n, createdBy: "beta" }),
	},
	{
		tool: "list_mandates",
		path: "mandates:list",
		args: { limit: 2 },
		mine: (n) => ({
			_id: `m${n}`,
			_creationTime: 100 - n,
			requestedBy: "alpha",
			fulfilledBy: "alpha",
		}),
		foreign: (n) => ({
			_id: `m${n}`,
			_creationTime: 100 - n,
			requestedBy: "beta",
			fulfilledBy: "beta",
		}),
	},
	{
		tool: "list_tasks_by_mission",
		path: "tasks:listByMission",
		args: { missionId: "mission1", limit: 2 },
		mine: (n) => ({
			_id: `t${n}`,
			_creationTime: 100 - n,
			createdBy: "alpha",
			title: "x",
			status: "todo",
			priority: "low",
		}),
		foreign: (n) => ({
			_id: `t${n}`,
			_creationTime: 100 - n,
			createdBy: "beta",
			assignedTo: "beta",
			title: "x",
			status: "todo",
			priority: "low",
		}),
	},
	{
		tool: "list_peers",
		path: "profiles:listProfiles",
		args: { limit: 2 },
		mine: (n) => peer(n, "alpha"),
		foreign: (n) => peer(n, "beta"),
	},
];

function peer(n: number, who: string): Record<string, unknown> {
	return {
		_id: `p${n}`,
		_creationTime: 100 - n,
		orchestratorId: who,
		name: who,
		static: { role: "r", workspace: "w" },
		dynamic: { currentTask: "idle", lastSeen: 1, sessionCount: 1 },
	};
}

describe.each(SITES)("$tool — bound is computed before the scope filter", (s) => {
	it("NEGATIVE: full raw page, every row removed by the filter -> says so and keeps the cursor", async () => {
		const parsed = await call(s.path, [s.foreign(1), s.foreign(2)], s.tool, s.args);
		expect(items(parsed)).toHaveLength(0);
		expect(parsed.scopeFiltered).toBe(2);
		expect(typeof parsed.nextCursor).toBe("string");
	});

	it("NEGATIVE vs ABSENT: the same caller on an empty population gets distinct bytes", async () => {
		const removed = await call(s.path, [s.foreign(1), s.foreign(2)], s.tool, s.args);
		const empty = await call(s.path, [], s.tool, s.args);
		expect(JSON.stringify(removed)).not.toBe(JSON.stringify(empty));
		expect(items(empty)).toHaveLength(0);
		expect(empty.scopeFiltered).toBeUndefined();
		expect(empty.nextCursor).toBeUndefined();
	});

	it("NEGATIVE: a full raw page narrowed to one row still carries the continuation cursor", async () => {
		const parsed = await call(s.path, [s.mine(1), s.foreign(2)], s.tool, s.args);
		expect(items(parsed)).toHaveLength(1);
		expect(parsed.scopeFiltered).toBe(1);
		expect(typeof parsed.nextCursor).toBe("string");
	});

	it("PRESENT: rows inside the caller's reach, page not full -> unchanged shape, no flag", async () => {
		const parsed = await call(s.path, [s.mine(1)], s.tool, s.args);
		expect(items(parsed)).toHaveLength(1);
		expect(parsed.scopeFiltered).toBeUndefined();
		expect(parsed.nextCursor).toBeUndefined();
	});
});

describe("list_broadcast_status — receipts removed by the scope filter after the fetch", () => {
	const envelope = (receipts: Array<Record<string, unknown>>, truncated = false) => ({
		messageId: "m1",
		from: "gamma",
		channel: "broadcast",
		createdAt: 1000,
		truncated,
		receipts,
	});
	const run = async (env: unknown) => {
		const tools = capture({ "messages:listBroadcastStatus": env }, alphaCtx());
		const res = await tools.get("list_broadcast_status")!({ messageId: "m1" });
		expect(res.isError).not.toBe(true);
		return JSON.parse(res.content[0].text);
	};

	it("NEGATIVE: receipts exist but none is in reach -> scopeFiltered names them", async () => {
		const out = await run(
			envelope([
				{ recipient: "beta", read: true },
				{ recipient: "gamma", read: false },
			]),
		);
		expect(out.receipts).toEqual([]);
		expect(out.scopeFiltered).toBe(2);
	});

	it("NEGATIVE vs ABSENT: same caller, empty population -> distinct bytes", async () => {
		const removed = await run(envelope([{ recipient: "beta", read: true }]));
		const empty = await run(envelope([]));
		expect(JSON.stringify(removed)).not.toBe(JSON.stringify(empty));
		expect(empty.scopeFiltered).toBeUndefined();
	});

	it("POSITIVE CONTROL: a receipt whose recipient IS in reach is returned", async () => {
		const out = await run(
			envelope([
				{ recipient: "alpha", read: true, readAt: 5 },
				{ recipient: "beta", read: false },
			]),
		);
		expect(out.receipts).toEqual([{ recipient: "alpha", read: true, readAt: 5 }]);
		expect(out.scopeFiltered).toBe(1);
	});

	it("PRESENT: nothing removed -> no flag", async () => {
		const out = await run(envelope([{ recipient: "alpha", read: false }]));
		expect(out.receipts).toHaveLength(1);
		expect(out.scopeFiltered).toBeUndefined();
	});

	it("truncated is evaluated AFTER the filter: many removed receipts and one visible, limit 1 -> not truncated", async () => {
		const out = await run(
			envelope([
				{ recipient: "beta", read: true },
				{ recipient: "gamma", read: true },
				{ recipient: "alpha", read: false },
			]),
		);
		// default limit 20 here; narrow the limit via args below
		expect(out.truncated).toBe(false);
		const tools = capture(
			{
				"messages:listBroadcastStatus": envelope([
					{ recipient: "beta", read: true },
					{ recipient: "gamma", read: true },
					{ recipient: "alpha", read: false },
				]),
			},
			alphaCtx(),
		);
		const res = await tools.get("list_broadcast_status")!({
			messageId: "m1",
			limit: 1,
		});
		const one = JSON.parse(res.content[0].text);
		expect(one.receipts).toHaveLength(1);
		expect(one.truncated).toBe(false);
	});

	it("truncated stays true when the door cut its own list", async () => {
		const out = await run(envelope([{ recipient: "alpha", read: false }], true));
		expect(out.truncated).toBe(true);
	});

	it("truncated is true when more VISIBLE receipts exist than the caller's limit", async () => {
		const tools = capture(
			{
				"messages:listBroadcastStatus": envelope([
					{ recipient: "alpha", read: false },
					{ recipient: "alpha", read: true },
				]),
			},
			alphaCtx(),
		);
		const res = await tools.get("list_broadcast_status")!({
			messageId: "m1",
			limit: 1,
		});
		const out = JSON.parse(res.content[0].text);
		expect(out.receipts).toHaveLength(1);
		expect(out.truncated).toBe(true);
	});
});

describe.each(SITES)("$tool — a token bound to no organisation", (s) => {
	const noOrg = (): OAuthContext => {
		const { clerkOrgSlug: _drop, ...rest } = alphaCtx();
		return rest as OAuthContext;
	};

	it("gets NO scopeFiltered count but keeps its continuation cursor", async () => {
		const tools = capture({ [s.path]: [s.foreign(1), s.foreign(2)] }, noOrg());
		const res = await tools.get(s.tool)!(s.args);
		expect(res.isError).not.toBe(true);
		const out = JSON.parse(res.content[0].text);
		expect(out.scopeFiltered).toBeUndefined();
		expect(typeof out.nextCursor).toBe("string");
	});
});
