/**
 * get_bulk_complete_run — MCP reader of a live bulk_complete_tasks run's status row (R-31).
 *
 * The MCP server reaches Convex as the fleet service account, so the tenant and
 * creator gates are applied in the tool, on the row, like get_task. Poles:
 *   REGISTERED  the tool exists with its args schema; bulk_complete_tasks still
 *               passes the first call's bulkRunId through untouched (poll key).
 *   OWN         the run's own creator / org reads it, failureReason included.
 *   REFUSED     another org, another creator, an unknown id: "not found", the
 *               same answer for all three (the id is not an oracle).
 *   MASTER      the fleet master reads any run.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import {
	GET_BULK_COMPLETE_RUN_TOOL_NAME,
	getBulkCompleteRunArgsSchema,
	registerTools,
} from "../tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer(): { server: McpServer; handlers: Map<string, ToolHandler> } {
	const handlers = new Map<string, ToolHandler>();
	const reg = (...args: unknown[]): unknown => {
		handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
		return {};
	};
	return {
		server: { tool: reg, registerTool: reg } as unknown as McpServer,
		handlers,
	};
}

const RUN = {
	bulkRunId: "bulk-1-aaaa",
	createdBy: "alpha-role",
	status: "failed",
	closed: 500,
	remaining: true,
	failureReason: "RBAC_DENIED: alpha-role is not creator or assignee of task t1 — bulk close denied",
	startedAt: 1,
	updatedAt: 2,
};

function convexReturning(row: unknown): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue(row),
		mutation: vi.fn().mockResolvedValue({ count: 500, sampleIds: [], bulkRunId: "bulk-1-aaaa", remaining: true }),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

const ACTOR_A: OAuthContext = {
	clientId: "client-a",
	userId: "user-a",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["alpha-role"],
	actor: { orgSlug: "org-a", agentName: "alpha-role" },
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

const MASTER: OAuthContext = {
	clientId: "client-master",
	userId: "user-master",
	scopes: ["mcp:full"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

async function call(ctx: OAuthContext, row: unknown, bulkRunId = "bulk-1-aaaa") {
	const { server, handlers } = buildFakeServer();
	const convex = convexReturning(row);
	registerTools(server, convex, ctx);
	const handler = handlers.get(GET_BULK_COMPLETE_RUN_TOOL_NAME);
	expect(handler, "get_bulk_complete_run must be registered").toBeDefined();
	const result = (await handler?.({ bulkRunId })) as {
		isError?: boolean;
		content: Array<{ text: string }>;
	};
	return { result, convex };
}

describe("get_bulk_complete_run", () => {
	it("is named get_bulk_complete_run and its schema requires a non-empty bulkRunId", () => {
		expect(GET_BULK_COMPLETE_RUN_TOOL_NAME).toBe("get_bulk_complete_run");
		expect(getBulkCompleteRunArgsSchema.parse({ bulkRunId: "bulk-1-aaaa" }).bulkRunId).toBe("bulk-1-aaaa");
		expect(() => getBulkCompleteRunArgsSchema.parse({})).toThrow();
		expect(() => getBulkCompleteRunArgsSchema.parse({ bulkRunId: "" })).toThrow();
	});

	it("OWN: the creator reads its run, failure reason included, via tasks:getBulkCompleteRun", async () => {
		const { result, convex } = await call(ACTOR_A, { ...RUN, orgId: "org-a" });
		expect(result.isError).not.toBe(true);
		const body = JSON.parse(result.content[0].text);
		expect(body.status).toBe("failed");
		expect(body.failureReason).toMatch(/RBAC_DENIED/);
		expect((convex.query as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
			"tasks:getBulkCompleteRun",
			{ bulkRunId: "bulk-1-aaaa" },
		]);
	});

	it("OWN: a run stamped with the caller's own org is readable", async () => {
		const { result } = await call(ACTOR_A, { ...RUN, orgId: "org-a" });
		expect(result.isError).not.toBe(true);
	});

	it("REFUSED: a run stamped with ANOTHER org is 'not found' even when the creator name matches", async () => {
		const { result } = await call(ACTOR_A, { ...RUN, orgId: "org-b" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/not found/i);
	});

	it("REFUSED: another creator's run, and an unknown id, answer the same 'not found'", async () => {
		const other = await call(ACTOR_A, { ...RUN, createdBy: "beta-role" });
		const unknown = await call(ACTOR_A, null);
		expect(other.result.isError).toBe(true);
		expect(unknown.result.isError).toBe(true);
		expect(other.result.content[0].text).toBe(unknown.result.content[0].text);
	});

	it("MASTER: the fleet master reads any run", async () => {
		const { result } = await call(MASTER, { ...RUN, orgId: "org-b", createdBy: "beta-role" });
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.content[0].text).bulkRunId).toBe("bulk-1-aaaa");
	});

	it("bulk_complete_tasks passes the first call's bulkRunId (the poll key) through unchanged", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = convexReturning(null);
		registerTools(server, convex, MASTER);
		const out = (await handlers.get("bulk_complete_tasks")?.({
			filter: { status: "todo" },
			dryRun: false,
			callerOrchestrator: "system",
		})) as { content: Array<{ text: string }> };
		const body = JSON.parse(out.content[0].text);
		expect(body.bulkRunId).toBe("bulk-1-aaaa");
		expect(body.remaining).toBe(true);
	});

	it("REFUSED: a non-master caller never reads an org-less run (a run with no verified org is not served on a creator name alone)", async () => {
		const { result } = await call(ACTOR_A, RUN);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/not found/i);
	});

	it("REFUSED: an org-b client is refused an org-a run even when its allow-list names the same creator", async () => {
		const orgB: OAuthContext = {
			...ACTOR_A,
			clientId: "client-b",
			actor: { orgSlug: "org-b", agentName: "alpha-role" },
			namespaceReadPrefixes: ["team/org-b"],
		};
		const { result } = await call(orgB, { ...RUN, orgId: "org-a" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/not found/i);
	});

	it("REFUSED: a seat token with no actor reads by its token-row org (clerkOrgSlug), not by name", async () => {
		const seatB: OAuthContext = {
			...ACTOR_A,
			actor: undefined,
			clerkOrgSlug: "org-b",
			accessTokenHash: "h",
		};
		const denied = await call(seatB, { ...RUN, orgId: "org-a" });
		expect(denied.result.isError).toBe(true);
		const seatA: OAuthContext = { ...seatB, clerkOrgSlug: "org-a" };
		const served = await call(seatA, { ...RUN, orgId: "org-a" });
		expect(served.result.isError).not.toBe(true);
	});

	describe("bulk_complete_tasks forwards the VERIFIED org (and only that)", () => {
		async function dispatch(ctx: OAuthContext) {
			const { server, handlers } = buildFakeServer();
			const convex = convexReturning(null);
			registerTools(server, convex, ctx);
			await handlers.get("bulk_complete_tasks")?.({
				filter: { assignedTo: "alpha-role" },
				dryRun: false,
				callerOrchestrator: "alpha-role",
			});
			return (convex.mutation as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Record<string, unknown> | undefined;
		}

		it("an org-a agent forwards verifiedOrg {orgSlug:'org-a'} from its verified actor", async () => {
			const args = await dispatch(ACTOR_A);
			expect(args?.verifiedOrg).toEqual({ orgSlug: "org-a" });
		});

		it("a seat token with no actor forwards the org on its token row", async () => {
			const args = await dispatch({ ...ACTOR_A, actor: undefined, clerkOrgSlug: "org-c", accessTokenHash: "h" });
			expect(args?.verifiedOrg).toEqual({ orgSlug: "org-c" });
		});

		it("the fleet master forwards none", async () => {
			const args = await dispatch({ ...MASTER });
			expect(args?.verifiedOrg).toBeUndefined();
		});

		it("a Clerk-JWT caller forwards none (Convex already sees its own org)", async () => {
			const args = await dispatch({ ...ACTOR_A, clerkJwt: "jwt" });
			expect(args?.verifiedOrg).toBeUndefined();
		});
	});
});
