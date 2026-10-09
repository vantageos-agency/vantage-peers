/**
 * RED reproduction, group R5 — MCP tools (diary, bu, repo mapping, github owner bindings).
 * Harness origin: test/inbox-doors-consumer-wire.test.ts (real registerTools over a bridge that
 * reaches the REAL Convex functions as the service account, exactly as an OAuth seat does in prod).
 * Identity under test: OAuth SEAT of org-a (non-master, clerkOrgSlug org-a, resolved agent credential actor a1).
 */
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";
import schema from "../../../convex/schema";
import type { OAuthContext } from "../../src/auth.js";
import { registerTools } from "../../src/tools.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../../convex/**/*.ts")).filter(
		([p]) => !p.includes("ragSync") && !p.includes("search") && !p.includes("backfill") && !p.includes("Backfill") && !p.includes("__tests__") && !p.endsWith(".test.ts"),
	),
);
const SA = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const NOW = 1_700_000_000_000;
type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (a: Record<string, unknown>) => Promise<ToolResult>;

let t: T;
let tools: Map<string, Tool>;

const buFields = (orchestratorId: string, name: string) => ({
	name, description: "d", purpose: "p", orchestratorId, status: "idea" as const, businessModel: "m",
	targetCustomers: "c", services: [], pricing: "SECRET-PRICING", revenueProjections: { y1: 1, y2: 2, y3: 3 },
	coreTeam: { agents: [], skills: [], hooks: [], plugins: [] }, coreProcesses: [], dependencies: [], kpis: [], managementFee: 10,
});

beforeEach(async () => {
	t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		for (const [slug, names] of [["org-a", ["a1", "eta"]], ["org-b", ["eta", "b1"]]] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug, allowedOrchestrators: [...names],
				scopes: ["view-own-tasks", "manage-repo-mappings"], displayName: slug, isActive: true, createdAt: NOW,
			});
		}
		await ctx.db.insert("memberWriterRoles", { roles: ["org:admin", "org:member"], updatedAt: NOW });
		await ctx.db.insert("diary", { date: "2026-10-01", orchestrator: "eta", content: "ORG-B-DIARY", createdAt: NOW, orgId: "org-b" });
		await ctx.db.insert("businessUnits", { ...buFields("eta", "B-unit"), createdAt: NOW, updatedAt: NOW, orgId: "org-b" });
		await ctx.db.insert("githubRepoMapping", { repo: "org-b/app", orchestrator: "eta", project: "p", active: true, orgId: "org-b" });
		await ctx.db.insert("githubOwnerBindings", { owner: "org-b", orgId: "org-b", installationId: 1, accountType: "Organization", githubUserLogin: "bgh", boundBy: "u", boundAt: NOW, active: true });
		await ctx.db.insert("githubOwnerBindings", { owner: "org-a", orgId: "org-a", installationId: 2, accountType: "Organization", githubUserLogin: "agh", boundBy: "u", boundAt: NOW, active: true });
	});
	const sa = t.withIdentity({ subject: SA });
	const client = {
		query: (n: string, a: Record<string, unknown>) => sa.query(makeFunctionReference<"query">(n) as never, a as never),
		mutation: (n: string, a: Record<string, unknown>) => sa.mutation(makeFunctionReference<"mutation">(n) as never, a as never),
	};
	tools = new Map();
	const server = { tool() {}, registerTool: (n: string, _c: unknown, h: Tool) => void tools.set(n, h) } as never;
	const seat: OAuthContext = {
		clientId: "seat-a", userId: "eta", scopes: ["vantage:read", "vantage:write"], scopeProfile: "seat",
		fromAllowList: ["a1", "eta"], namespaceReadPrefixes: ["team/org-a"], namespaceWritePrefixes: ["team/org-a"],
		expiresAt: Date.now() + 3_600_000, isMaster: false, clerkOrgSlug: "org-a", accessTokenHash: "h", actor: { orgSlug: "org-a", agentName: "a1" },
	};
	// biome-ignore lint/suspicious/noExplicitAny: test bridge
	registerTools(server, client as any, seat);
});

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
	const h = tools.get(name);
	expect(h, name).toBeDefined();
	return (await h?.(args)) as ToolResult;
}
const text = (r: ToolResult) => r.content[0].text;

describe("MCP seat of org-a (OAuth, non-master)", () => {
	it("mcp:list_diaries — org-a seat 'eta' does not receive org-b's diary entries for the same name (identity: OAuth seat org-a)", async () => {
		const r = await call("list_diaries", { orchestrator: "eta" });
		expect(text(r)).not.toContain("ORG-B-DIARY");
	});
	it("mcp:create_bu — a BU written by an org-a seat is stamped org-a (identity: OAuth seat org-a)", async () => {
		const r = await call("create_bu", { ...buFields("a1", "A-made") });
		expect(r.isError, text(r)).toBeFalsy();
		const row = await t.run((ctx) => ctx.db.query("businessUnits").filter((q) => q.eq(q.field("name"), "A-made")).first());
		expect(row?.orgId).toBe("org-a");
	});
	it("mcp:update_bu — an org-a seat cannot update org-b's BU (identity: OAuth seat org-a)", async () => {
		// org-b's BU is led by a name ('a1') that org-a's seat also holds (same-name class).
		const bId = await t.run((ctx) => ctx.db.insert("businessUnits", { ...buFields("a1", "B-a1-unit"), createdAt: NOW, updatedAt: NOW, orgId: "org-b" }));
		const r = await call("update_bu", { buId: bId, callerOrchestrator: "a1", name: "HIJACKED" });
		const after = await t.run((ctx) => ctx.db.get(bId));
		expect(after?.name).toBe("B-a1-unit");
		expect(r.isError, text(r)).toBe(true);
	});
	it("mcp:get_bu — an org-a seat holding roster name 'eta' cannot read org-b's BU (identity: OAuth seat org-a)", async () => {
		const b = await t.run((ctx) => ctx.db.query("businessUnits").first());
		const r = await call("get_bu", { buId: b?._id });
		expect(text(r)).not.toContain("SECRET-PRICING");
	});
	it("mcp:list_bus — an org-a seat does not list org-b's BU (identity: OAuth seat org-a)", async () => {
		const r = await call("list_bus", {});
		expect(text(r)).not.toContain("B-unit");
	});
	it("mcp:add_repo_mapping — an org-a seat cannot map org-b's repo (identity: OAuth seat org-a)", async () => {
		const r = await call("add_repo_mapping", { repo: "org-b/app", orchestrator: "a1", project: "hijack" });
		const row = await t.run((ctx) => ctx.db.query("githubRepoMapping").first());
		expect(row?.orchestrator).toBe("eta");
		expect(r.isError, text(r)).toBe(true);
	});
	it("mcp:list_repo_mappings — an org-a seat does not list org-b's mapping (identity: OAuth seat org-a)", async () => {
		const r = await call("list_repo_mappings", {});
		expect(text(r)).not.toContain("org-b/app");
	});
	it("mcp:remove_repo_mapping — an org-a seat cannot delete org-b's mapping (identity: OAuth seat org-a)", async () => {
		const r = await call("remove_repo_mapping", { repo: "org-b/app" });
		const row = await t.run((ctx) => ctx.db.query("githubRepoMapping").first());
		expect(row).not.toBeNull();
		expect(r.isError, text(r)).toBe(true);
	});
	it("mcp:get_github_owner_bindings — an org-a seat sees only org-a's bindings (identity: OAuth seat org-a)", async () => {
		const r = await call("get_github_owner_bindings", { limit: 100 });
		expect(text(r)).not.toContain("org-b");
	});
	it("mcp:get_repo_mapping — an org-a seat holding roster name 'eta' cannot read org-b's mapping (identity: OAuth seat org-a)", async () => {
		const r = await call("get_repo_mapping", { repo: "org-b/app" });
		expect(r.isError, text(r)).toBe(true);
	});
});
