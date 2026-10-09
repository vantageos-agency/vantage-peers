/**
 * RED reproduction of the R1 audit, MCP side (send_message state tokens,
 * list_messages, search_messages_by_keyword, list_broadcast_status,
 * get_message), main @16f0907. Origin of every case: audit rows 12-16 of
 * scratchpad/audit/doors/defects-R1.jsonl; harness: test/send-message-seat-org.test.ts
 * and test/inbox-doors-consumer-wire.test.ts (tracked paths).
 *
 * Identity: a NON-master OAuth seat of org-a (token row clerkOrgSlug "org-a",
 * fromAllowList ["eta", ...]) whose Convex client is the fleet service account
 * (convex-test, subject = CLERK_SERVICE_ACCOUNT_USER_ID), exactly the production
 * wire of a bearer seat. No claim is forwarded by these read tools.
 */
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";
import type { OAuthContext } from "../../src/auth.js";
import { registerTools } from "../../src/tools.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);

const SERVICE_ACCOUNT_ID = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = 1_700_000_000_000;

type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;

function bridge(t: T) {
	const sa = t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
	return {
		query: (name: string, args: Record<string, unknown>) =>
			sa.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			sa.mutation(
				makeFunctionReference<"mutation">(name) as never,
				args as never,
			),
		action: async () => null,
	};
}

const seatCtx = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "oauth-client-seat",
	userId: "seat-user",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "team-member",
	fromAllowList: ["eta", "a1", "a2"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: ORG_A,
	...over,
});

const masterCtx: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: true,
};

type World = {
	t: T;
	orgBTask: Id<"tasks">;
	m: Record<string, Id<"messages">>;
};

async function seed(extraOrgBNewer = 0): Promise<World> {
	const t = convexTest(schema, modules);
	const w = await t.run(async (ctx) => {
		for (const [slug, names] of [
			[ORG_A, ["eta", "a1", "a2"]],
			[ORG_B, ["eta", "b1"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [...names],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
		}
		for (const role of ["eta", "a1", "a2", "b1"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: role,
				name: role,
				static: { role, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: NOW, sessionCount: 0 },
			});
		}
		const orgBTask = await ctx.db.insert("tasks", {
			title: "ORG-B PRIVATE TASK",
			assignedTo: "b1",
			createdBy: "b1",
			orgId: ORG_B,
			priority: "medium",
			status: "in_progress",
			createdAt: NOW,
			updatedAt: NOW,
		} as never);
		const m: Record<string, Id<"messages">> = {};
		// the org-a rows are OLDER than every org-b row: the newest-N window of the
		// all-tenants master read is full of org-b by the time the MCP filters.
		m.A_ETA = await ctx.db.insert("messages", {
			from: "eta",
			channel: "a1",
			content: "ORGA-ETA probe",
			tenantId: ORG_A,
			createdAt: NOW,
		});
		m.A_TO_ETA = await ctx.db.insert("messages", {
			from: "a2",
			channel: "eta",
			content: "ORGA-TO-ETA probe",
			tenantId: ORG_A,
			createdAt: NOW + 1,
		});
		m.B_ETA = await ctx.db.insert("messages", {
			from: "eta",
			channel: "b1",
			content: "ORGB-ETA probe",
			tenantId: ORG_B,
			createdAt: NOW + 2,
		});
		await ctx.db.insert("messageReceipts", {
			messageId: m.B_ETA,
			recipient: "eta",
			tenantId: ORG_B,
			readAt: undefined,
		});
		for (let i = 0; i < extraOrgBNewer; i++) {
			await ctx.db.insert("messages", {
				from: "b1",
				channel: "b1",
				content: `ORGB-NOISE-${i}`,
				tenantId: ORG_B,
				createdAt: NOW + 10 + i,
			});
		}
		return { orgBTask, m };
	});
	return { t, ...w };
}

function toolsFor(t: T, ctx: OAuthContext) {
	const tools = new Map<string, Tool>();
	const server = {
		tool() {},
		registerTool: (name: string, _config: unknown, handler: Tool) => {
			tools.set(name, handler);
		},
	} as never;
	// biome-ignore lint/suspicious/noExplicitAny: test bridge
	registerTools(server, bridge(t) as any, ctx);
	return async (name: string, args: Record<string, unknown>) => {
		const h = tools.get(name);
		expect(h, name).toBeDefined();
		return (await h?.(args)) as ToolResult;
	};
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const rowsOf = (r: ToolResult): Array<{ content?: string }> => {
	const parsed = JSON.parse(textOf(r));
	return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
};

describe("mcp:send_message — state tokens", () => {
	beforeEach(() => {
		vi.stubEnv("VANTAGE_ACTOR_CREDENTIAL_MODE", "permissive");
		vi.stubEnv("GITHUB_TOKEN", "dummy-token-for-header-presence-only");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("mcp:send_message — {{task:<id>}} of ANOTHER org's task is refused for an org-a seat (OAuth seat org-a)", async () => {
		const w = await seed();
		const call = toolsFor(w.t, seatCtx());
		const r = await call("send_message", {
			from: "a1",
			channel: "a2",
			content: `{{task:${w.orgBTask}}}`,
		});
		const stored = await w.t.run(async (ctx) =>
			(await ctx.db.query("messages").collect()).map((x) => x.content),
		);
		// correct behaviour: refused, and the foreign task's status is never written
		expect(r.isError, textOf(r)).toBe(true);
		expect(stored.join("\n")).not.toContain("in_progress");
	});

	it("mcp:send_message — {{pr:owner/repo#n}} does not send the server's GitHub token for a non-master seat (OAuth seat org-a)", async () => {
		const w = await seed();
		const headers: Array<Record<string, string>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
				headers.push(init?.headers ?? {});
				return new Response(
					JSON.stringify({
						state: "open",
						merged: false,
						head: { sha: "abc123" },
						mergeable_state: "clean",
					}),
					{ status: 200 },
				);
			}),
		);
		const call = toolsFor(w.t, seatCtx());
		await call("send_message", {
			from: "a1",
			channel: "a2",
			content: "{{pr:some-other-owner/private-repo#7}}",
		});
		expect(headers.length).toBeGreaterThan(0); // the stub was reached
		expect(headers.some((h) => "Authorization" in h)).toBe(false);
	});

	it("CONTROL mcp:send_message — the same {{pr:}} through the master bearer DOES carry the token (the instrument can see the header)", async () => {
		const w = await seed();
		const headers: Array<Record<string, string>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
				headers.push(init?.headers ?? {});
				return new Response(
					JSON.stringify({ state: "open", head: { sha: "abc123" } }),
					{ status: 200 },
				);
			}),
		);
		const call = toolsFor(w.t, masterCtx);
		await call("send_message", {
			from: "pi",
			channel: "eta",
			content: "{{pr:some-other-owner/private-repo#7}}",
		});
		expect(headers.some((h) => "Authorization" in h)).toBe(true);
	});
});

describe("mcp read tools — a seat of org-a (fromAllowList eta) is not served org-b rows", () => {
	it("mcp:list_messages — an org-b row whose sender name collides with the allow-list is not returned (OAuth seat org-a)", async () => {
		const w = await seed();
		const r = await toolsFor(w.t, seatCtx())("list_messages", {});
		expect(r.isError, textOf(r)).toBeFalsy();
		expect(rowsOf(r).map((x) => x.content)).not.toContain("ORGB-ETA probe");
	});

	it("mcp:list_messages — a rightful reader is not starved by newer rows of other tenants (OAuth seat org-a, 25 newer org-b rows)", async () => {
		const w = await seed(25);
		const r = await toolsFor(w.t, seatCtx())("list_messages", { limit: 5 });
		expect(r.isError, textOf(r)).toBeFalsy();
		expect(rowsOf(r).map((x) => x.content)).toContain("ORGA-ETA probe");
	});

	it("mcp:list_messages — a message ADDRESSED to the seat's agent (sender outside the allow-list) is returned (OAuth seat org-a)", async () => {
		const w = await seed();
		const r = await toolsFor(w.t, seatCtx())("list_messages", {});
		expect(rowsOf(r).map((x) => x.content)).toContain("ORGA-TO-ETA probe");
	});

	it("mcp:search_messages_by_keyword — an org-b row whose sender name collides with the allow-list is not returned (OAuth seat org-a)", async () => {
		const w = await seed();
		const r = await toolsFor(w.t, seatCtx())("search_messages_by_keyword", {
			query: "probe",
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		expect(rowsOf(r).map((x) => x.content)).not.toContain("ORGB-ETA probe");
	});

	it("mcp:search_messages_by_keyword — a message ADDRESSED to the seat's agent is returned (OAuth seat org-a)", async () => {
		const w = await seed();
		const r = await toolsFor(w.t, seatCtx())("search_messages_by_keyword", {
			query: "probe",
		});
		expect(rowsOf(r).map((x) => x.content)).toContain("ORGA-TO-ETA probe");
	});

	it("mcp:list_broadcast_status — another org's message is refused for an org-a seat, envelope and receipts (OAuth seat org-a)", async () => {
		const w = await seed();
		const r = await toolsFor(w.t, seatCtx())("list_broadcast_status", {
			messageId: w.m.B_ETA,
		});
		expect(r.isError, textOf(r)).toBe(true);
	});

	it("mcp:get_message — another org's message is not returned to an org-a seat (OAuth seat org-a)", async () => {
		const w = await seed();
		const r = await toolsFor(w.t, seatCtx())("get_message", {
			messageId: w.m.B_ETA,
		});
		expect(r.isError, textOf(r)).toBe(true);
		expect(textOf(r)).not.toContain("ORGB-ETA probe");
	});

	it("mcp:get_message — a message ADDRESSED to the seat's agent (sender outside the allow-list) is returned (OAuth seat org-a)", async () => {
		const w = await seed();
		const r = await toolsFor(w.t, seatCtx())("get_message", {
			messageId: w.m.A_TO_ETA,
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		expect(textOf(r)).toContain("ORGA-TO-ETA probe");
	});

	it("CONTROL mcp:get_message/list_messages — the seat reads its own org's message from an allow-listed sender", async () => {
		const w = await seed();
		const call = toolsFor(w.t, seatCtx());
		const g = await call("get_message", { messageId: w.m.A_ETA });
		expect(g.isError, textOf(g)).toBeFalsy();
		expect(textOf(g)).toContain("ORGA-ETA probe");
		const l = await call("list_messages", {});
		expect(rowsOf(l).map((x) => x.content)).toContain("ORGA-ETA probe");
	});
});
