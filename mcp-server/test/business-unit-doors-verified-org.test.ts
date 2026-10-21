/**
 * M10f: the business-unit doors act for the bearer's VERIFIED org.
 *
 * A bearer that is not the fleet master reaches Convex as the fleet service
 * account, whose `ctx.auth` carries no org. Convex now judges a unit by org ID and
 * agent ID, so every door a scoped bearer reaches (create_bu, update_bu, get_bu,
 * list_bus) forwards the bearer's verified org (`verifiedOrg`), exactly as
 * list_tasks does (convex/lib/verifiedOrg.ts). The org comes from the verified
 * oauthContext only, never from a tool argument; a bearer whose org cannot be
 * resolved is refused before Convex. delete_bu stays master-only (the master
 * forwards no org and deletes the fleet's own units; a scoped bearer is refused).
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type Call = { kind: string; fn: string; args: Record<string, unknown> };
type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };

function harness(oauthCtx: OAuthContext) {
	const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
	const calls: Call[] = [];
	const server = {
		tool: (name: string, _d: string, _s: unknown, _a: unknown, h: never) => {
			handlers.set(name, h);
		},
		registerTool: (name: string, _c: unknown, h: never) => {
			handlers.set(name, h);
		},
	} as Parameters<typeof registerTools>[0];
	const record = (kind: string) => async (fn: unknown, args: unknown) => {
		calls.push({ kind, fn: String(fn), args: args as Record<string, unknown> });
		return kind === "query" ? { items: [], nextCursor: null } : "bu-id";
	};
	const convex = {
		query: record("query"),
		mutation: record("mutation"),
		action: record("action"),
	} as Parameters<typeof registerTools>[1];
	registerTools(server, convex, oauthCtx);
	return {
		calls,
		call: async (name: string, args: Record<string, unknown>) => {
			const h = handlers.get(name);
			if (!h) throw new Error(`${name} not registered`);
			return (await h(args)) as ToolResult;
		},
	};
}

const scoped = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "client-a",
	userId: "user-a",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "client-a-seat",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["orchestrator/alpha"],
	namespaceWritePrefixes: ["orchestrator/alpha"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: "org-a",
	// the bearer carries an agent credential, as a seat naming itself does
	actor: { orgSlug: "org-a", agentName: "alpha", agentId: "agent-alpha" },
	...over,
});

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

const createArgs = {
	name: "n",
	description: "d",
	purpose: "p",
	orchestratorId: "alpha",
	status: "idea",
	businessModel: "m",
	targetCustomers: "c",
	services: [],
	pricing: "x",
	revenueProjections: { y1: 1, y2: 2, y3: 3 },
	coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
	coreProcesses: [],
	dependencies: [],
	kpis: [],
};

const doors: Array<[string, string, Record<string, unknown>]> = [
	["create_bu", "businessUnits:create", createArgs],
	["update_bu", "businessUnits:update", { buId: "bu1", callerOrchestrator: "alpha", name: "x" }],
	["get_bu", "businessUnits:get", { buId: "bu1" }],
	["list_bus", "businessUnits:list", {}],
];

describe("a scoped bearer forwards its verified org", () => {
	for (const [tool, fn, args] of doors) {
		it(`${tool} -> ${fn} carries verifiedOrg { orgSlug: org-a }`, async () => {
			const h = harness(scoped());
			const r = await h.call(tool, args);
			expect(r.isError, JSON.stringify(r)).not.toBe(true);
			const call = h.calls.find((c) => c.fn === fn);
			expect(call?.args.verifiedOrg).toEqual({ orgSlug: "org-a" });
		});

		it(`${tool}: the org is never taken from a tool argument`, async () => {
			const h = harness(scoped());
			await h.call(tool, { ...args, verifiedOrg: { orgSlug: "org-b" } });
			const call = h.calls.find((c) => c.fn === fn);
			expect(call?.args.verifiedOrg).toEqual({ orgSlug: "org-a" });
		});
	}

	it("the agent credential's org wins over the token row's (verified actor)", async () => {
		const h = harness(
			scoped({ actor: { agentId: "ag1", orgSlug: "org-actor", agentName: "alpha" } }),
		);
		await h.call("get_bu", { buId: "bu1" });
		expect(h.calls[0]?.args.verifiedOrg).toEqual({ orgSlug: "org-actor" });
	});
});

describe("a bearer whose org cannot be resolved is refused before Convex", () => {
	for (const [tool, , args] of doors.filter(([t]) => t !== "list_bus")) {
		it(`${tool}`, async () => {
			const h = harness(scoped({ clerkOrgSlug: undefined, actor: undefined }));
			const r = await h.call(tool, args);
			expect(r.isError).toBe(true);
			// get_bu reaches the org check itself; the two writes that NAME an agent are
			// stopped even earlier by the credential binding (no agent, so no org).
			expect(r.content?.[0]?.text).toMatch(
				/verified-org-unresolved|AGENT_CREDENTIAL_REQUIRED/,
			);
			expect(h.calls).toHaveLength(0);
		});
	}
});

describe("the fleet master forwards no org", () => {
	for (const [tool, fn, args] of doors) {
		it(`${tool} -> ${fn}`, async () => {
			const h = harness(master());
			await h.call(tool, args);
			const call = h.calls.find((c) => c.fn === fn);
			expect(call).toBeDefined();
			expect(call?.args).not.toHaveProperty("verifiedOrg");
		});
	}

	it("delete_bu reaches businessUnits:remove with no org (the fleet's own units)", async () => {
		const h = harness(master());
		await h.call("delete_bu", { buId: "bu1" });
		expect(h.calls[0]?.fn).toBe("businessUnits:remove");
		expect(h.calls[0]?.args).not.toHaveProperty("verifiedOrg");
	});

	it("delete_bu stays master-only: a scoped bearer is refused and nothing reaches Convex", async () => {
		const h = harness(scoped());
		const r = await h.call("delete_bu", { buId: "bu1" });
		expect(r.isError).toBe(true);
		expect(r.content?.[0]?.text).toMatch(/Forbidden/i);
		expect(h.calls).toHaveLength(0);
	});
});
