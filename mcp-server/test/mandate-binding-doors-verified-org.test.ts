/**
 * validate_mandate_spending and get_github_owner_bindings forward the bearer's
 * VERIFIED org (task k17e1twdq22k9311yygkfgx9d58hcsws).
 *
 * A non-master bearer reaches Convex as the fleet service account (master +
 * fleetWide), so a door gated on "fleet read" served it every org's data. The
 * org comes from the verified oauthContext only, never from a tool argument; the
 * master forwards none (unchanged); a bearer whose org cannot be resolved is
 * refused before Convex.
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


const MANDATE_ID = "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const doors: Array<[string, string, Record<string, unknown>]> = [
	["validate_mandate_spending", "mandates:validateSpending", { mandateId: MANDATE_ID, proposedAmount: 5 }],
	["get_github_owner_bindings", "githubOwnerBinding:listBindings", {}],
];

describe("a scoped bearer forwards its verified org", () => {
	for (const [tool, fn, args] of doors) {
		it(`${tool} -> ${fn} carries verifiedOrg { orgSlug: org-a }`, async () => {
			const h = harness(scoped());
			const r = await h.call(tool, args);
			expect(r.isError, JSON.stringify(r)).not.toBe(true);
			expect(h.calls.find((c) => c.fn === fn)?.args.verifiedOrg).toEqual({
				orgSlug: "org-a",
			});
		});
		it(`${tool}: the org is never taken from a tool argument`, async () => {
			const h = harness(scoped());
			await h.call(tool, { ...args, verifiedOrg: { orgSlug: "org-b" } });
			expect(h.calls.find((c) => c.fn === fn)?.args.verifiedOrg).toEqual({
				orgSlug: "org-a",
			});
		});
		it(`${tool}: the master forwards no org (unchanged)`, async () => {
			const h = harness(master());
			await h.call(tool, args);
			expect(h.calls.find((c) => c.fn === fn)?.args).not.toHaveProperty("verifiedOrg");
		});
		it(`${tool}: a bearer whose org cannot be resolved is refused before Convex`, async () => {
			const h = harness(scoped({ clerkOrgSlug: undefined, actor: undefined }));
			const r = await h.call(tool, args);
			expect(r.isError).toBe(true);
			expect(r.content?.[0]?.text).toMatch(/verified-org-unresolved/);
			expect(h.calls.filter((c) => c.fn === fn)).toEqual([]);
		});
	}
});

describe("listUnprovenMappings: master-only call, narrowed when an org rides it", () => {
	it("the master reads it with no org", async () => {
		const h = harness(master());
		await h.call("get_github_owner_bindings", {});
		const c = h.calls.find((x) => x.fn === "githubOwnerBinding:listUnprovenMappings");
		expect(c).toBeDefined();
		expect(c?.args).not.toHaveProperty("verifiedOrg");
	});
	it("a scoped bearer never reaches it", async () => {
		const h = harness(scoped());
		await h.call("get_github_owner_bindings", {});
		expect(
			h.calls.find((x) => x.fn === "githubOwnerBinding:listUnprovenMappings"),
		).toBeUndefined();
	});
});
