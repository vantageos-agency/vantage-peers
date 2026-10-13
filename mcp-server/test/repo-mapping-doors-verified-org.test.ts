/**
 * Batch E: the repo-mapping and owner-binding doors act for the bearer's
 * VERIFIED org.
 *
 * A bearer that is not the fleet master reaches Convex as the fleet service
 * account, whose `ctx.auth` carries no org. Without a verified org, a claimless
 * service-account call IS the fleet master: `add_repo_mapping` would write a
 * FLEET row, `get_github_owner_bindings` would list every organisation's
 * bindings. So the four tools a scoped bearer reaches (add_repo_mapping,
 * remove_repo_mapping, get_repo_mapping, get_github_owner_bindings) forward the
 * bearer's verified org (`verifiedOrg`), exactly as list_repo_mappings already
 * does (convex/lib/verifiedOrg.ts). The org comes from the verified oauthContext
 * only, never from a tool argument; a bearer whose org cannot be resolved is
 * refused before Convex; the fleet master forwards no org.
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
		return kind === "query" ? { items: [], nextCursor: null } : "mapping-id";
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
	actor: { orgSlug: "org-a", agentName: "alpha" },
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

const doors: Array<[string, string, Record<string, unknown>]> = [
	[
		"add_repo_mapping",
		"githubRepoMapping:add",
		{ repo: "org-a/app", orchestrator: "alpha", project: "app" },
	],
	["remove_repo_mapping", "githubRepoMapping:remove", { repo: "org-a/app" }],
	["get_repo_mapping", "githubRepoMapping:getByRepo", { repo: "org-a/app" }],
	["get_github_owner_bindings", "githubOwnerBinding:listBindings", { limit: 10 }],
];

describe("a scoped bearer forwards its verified org", () => {
	for (const [tool, fn, args] of doors) {
		it(`${tool} -> ${fn} carries verifiedOrg { orgSlug: org-a }`, async () => {
			const h = harness(scoped());
			await h.call(tool, args);
			const call = h.calls.find((c) => c.fn === fn);
			expect(call, JSON.stringify(h.calls)).toBeDefined();
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
		await h.call("get_repo_mapping", { repo: "org-actor/app" });
		expect(h.calls[0]?.args.verifiedOrg).toEqual({ orgSlug: "org-actor" });
	});

	it("get_github_owner_bindings never reads the master-only unproven mappings for a scoped bearer", async () => {
		const h = harness(scoped());
		await h.call("get_github_owner_bindings", { limit: 10 });
		expect(h.calls.map((c) => c.fn)).toEqual(["githubOwnerBinding:listBindings"]);
	});
});

describe("a bearer whose org cannot be resolved is refused before Convex", () => {
	for (const [tool, , args] of doors) {
		it(`${tool}`, async () => {
			const h = harness(scoped({ clerkOrgSlug: undefined, actor: undefined }));
			const r = await h.call(tool, args);
			expect(r.isError).toBe(true);
			expect(r.content?.[0]?.text).toMatch(/verified-org-unresolved/);
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

	it("get_github_owner_bindings also reads the unproven mappings, claimless", async () => {
		const h = harness(master());
		await h.call("get_github_owner_bindings", { limit: 10 });
		const unproven = h.calls.find(
			(c) => c.fn === "githubOwnerBinding:listUnprovenMappings",
		);
		expect(unproven).toBeDefined();
		expect(unproven?.args).not.toHaveProperty("verifiedOrg");
	});
});
