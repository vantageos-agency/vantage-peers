/**
 * S3.1.C Wave C Phase C2 — scope-aware filter applied to 7 read-path tools.
 *
 * Sprint    S3.1.C
 * Mission   k57c7s478gw1a3e5gmhdeptg5n87z78n
 * Task      k17fjd4dvp34k9q57t5e1qzrv187zz9n
 * Doctrine  decisions/doctrine-scope-aware-filter-2026-05-26.md (D3 base)
 *           memory j579y6f31g7xzgtgdnpgetdmjx87ztyj (D9-D14 extension)
 * Precedent Wave A SHA 251d183 (list_memories + get_memory)
 *           Wave B SHA 0d1ea94 (list_briefing_notes + list_messages + list_peers)
 *           Wave C0 SHA c516b88 (get_briefing_note registration + scope-aware)
 *           Wave C1 SHA 03f4d251 (7 read tools: get_profile + list_broadcast_status
 *                                + list_tasks_by_mission + get_mission + get_diary
 *                                + list_components + get_component)
 *
 * Tools covered in Wave C2 (next 7 read-path guardMasterOnly call sites in
 * source order, excluding everything migrated by Waves A/B/C0/C1):
 *
 *   1. search_components       (tools.ts L3451) — list
 *   2. list_recurring_tasks    (tools.ts L3571) — list
 *   3. list_mandates           (tools.ts L4033) — list
 *   4. get_bu                  (tools.ts L4266) — get
 *   5. list_bus                (tools.ts L4319) — list
 *   6. list_repo_mappings      (tools.ts L4459) — list
 *   7. list_issues             (tools.ts L4565) — list
 *
 * TDD discipline (mirrors C1):
 *   - At RED, each tool's handler still calls `guardMasterOnly` → a non-master
 *     scope receives an `isError: true` envelope with text starting with
 *     "Error: Forbidden: <toolName>". Tests T2 + M1 + M2 assert the response
 *     is NOT that Forbidden envelope → they FAIL at RED.
 *   - At GREEN, `guardMasterOnly` is removed and the post-Convex-query rows
 *     are passed through `scopeFilterList` / `scopeFilterGet` → tests pass.
 *
 * Harness convention (mirrors C0/C1 § Friction): instead of bootstrapping
 * the full Hono /mcp JSON-RPC envelope, tests use the lightweight duck-typed
 * `McpServer` mock from C0 to capture the registered handler, then invoke it
 * directly with a fixture-returning mocked Convex client.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders (mirror Wave C1)
// ─────────────────────────────────────────────────────────────────────────────

function masterCtx(): OAuthContext {
	return {
		clientId: "master",
		userId: "master",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	};
}

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
	};
}

function betaCtx(): OAuthContext {
	return {
		clientId: "client-beta",
		userId: "user-beta",
		scopes: ["vantage:read"],
		scopeProfile: "tenant-beta",
		fromAllowList: ["beta"],
		namespaceReadPrefixes: ["orchestrator/beta", "project/beta"],
		namespaceWritePrefixes: ["project/beta"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight MCP server + Convex mocks (mirrors C0/C1).
// queryReturns maps Convex query path (e.g. "missions:get") to a fixed result.
// ─────────────────────────────────────────────────────────────────────────────

type CapturedTool = {
	name: string;
	handler: (args: any) => any;
};

function captureTools(
	queryReturns: Record<string, unknown>,
	oauthCtx?: OAuthContext,
): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const mockServer = {
		tool: (
			name: string,
			_description: string,
			_schema: Record<string, unknown>,
			_annotations: Record<string, unknown>,
			handler: (args: any) => any,
		) => {
			tools.set(name, { name, handler });
		},
	} as any;
	const mockConvex = {
		query: async (queryPath: string, _args: any) => {
			if (queryPath in queryReturns) return queryReturns[queryPath];
			return null;
		},
		mutation: async () => null,
		action: async () => null,
	} as any;
	registerTools(mockServer, mockConvex, oauthCtx);
	return tools;
}

function isForbiddenResponse(res: any): boolean {
	if (!res || res.isError !== true) return false;
	const text = res.content?.[0]?.text ?? "";
	return typeof text === "string" && text.includes("Forbidden");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 1 — search_components (Convex query: components:search)
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_COMPONENTS_FIXTURE = [
	{
		_id: "sc_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		name: "alpha-skill",
		type: "skill",
	},
	{
		_id: "sc_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		name: "beta-skill",
		type: "skill",
	},
	{
		_id: "sc_g1",
		createdBy: "gamma",
		namespace: "global",
		name: "gamma-skill",
		type: "skill",
	},
];

describe("SCMP — search_components scope-aware", () => {
	it("SCMP-T1 master scope → all 3 rows visible", async () => {
		const tools = captureTools(
			{ "components:search": SEARCH_COMPONENTS_FIXTURE },
			masterCtx(),
		);
		const res = await tools
			.get("search_components")!
			.handler({ query: "skill" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("sc_a1");
		expect(res.content[0].text).toContain("sc_b1");
	});

	it("SCMP-T2 non-master in-scope → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "components:search": SEARCH_COMPONENTS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools
			.get("search_components")!
			.handler({ query: "skill" });
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("SCMP-T3 legacy bearer → all rows visible", async () => {
		const tools = captureTools({
			"components:search": SEARCH_COMPONENTS_FIXTURE,
		});
		const res = await tools
			.get("search_components")!
			.handler({ query: "skill" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("sc_b1");
	});

	it("SCMP-M1 alpha scope → beta component filtered out", async () => {
		const tools = captureTools(
			{ "components:search": SEARCH_COMPONENTS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools
			.get("search_components")!
			.handler({ query: "skill" });
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("sc_b1");
	});

	it("SCMP-M2 alpha scope → alpha component visible", async () => {
		const tools = captureTools(
			{ "components:search": SEARCH_COMPONENTS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools
			.get("search_components")!
			.handler({ query: "skill" });
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("sc_a1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 2 — list_recurring_tasks (Convex query: recurringTasks:list)
// ─────────────────────────────────────────────────────────────────────────────

const RECURRING_FIXTURE = [
	{
		_id: "rt_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		title: "alpha recurring",
	},
	{
		_id: "rt_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		title: "beta recurring",
	},
	{
		_id: "rt_g1",
		createdBy: "gamma",
		namespace: "global",
		title: "gamma recurring",
	},
];

describe("LRCT — list_recurring_tasks scope-aware", () => {
	it("LRCT-T1 master scope → all 3 rows visible", async () => {
		const tools = captureTools(
			{ "recurringTasks:list": RECURRING_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("list_recurring_tasks")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("rt_a1");
		expect(res.content[0].text).toContain("rt_b1");
	});

	it("LRCT-T2 non-master → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "recurringTasks:list": RECURRING_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_recurring_tasks")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("LRCT-T3 legacy bearer → all rows visible", async () => {
		const tools = captureTools({ "recurringTasks:list": RECURRING_FIXTURE });
		const res = await tools.get("list_recurring_tasks")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("rt_b1");
	});

	it("LRCT-M1 alpha scope → beta recurring filtered out", async () => {
		const tools = captureTools(
			{ "recurringTasks:list": RECURRING_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_recurring_tasks")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("rt_b1");
	});

	it("LRCT-M2 alpha scope → alpha recurring visible", async () => {
		const tools = captureTools(
			{ "recurringTasks:list": RECURRING_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_recurring_tasks")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("rt_a1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 3 — list_mandates (Convex query: mandates:list)
// ─────────────────────────────────────────────────────────────────────────────

const MANDATES_FIXTURE = [
	{
		_id: "mnd_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		title: "alpha mandate",
	},
	{
		_id: "mnd_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		title: "beta mandate",
	},
	{
		_id: "mnd_g1",
		createdBy: "gamma",
		namespace: "global",
		title: "gamma mandate",
	},
];

describe("LMND — list_mandates scope-aware", () => {
	it("LMND-T1 master scope → all 3 rows visible", async () => {
		const tools = captureTools(
			{ "mandates:list": MANDATES_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("list_mandates")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("mnd_a1");
		expect(res.content[0].text).toContain("mnd_b1");
	});

	it("LMND-T2 non-master → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "mandates:list": MANDATES_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_mandates")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("LMND-T3 legacy bearer → all rows visible", async () => {
		const tools = captureTools({ "mandates:list": MANDATES_FIXTURE });
		const res = await tools.get("list_mandates")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("mnd_b1");
	});

	it("LMND-M1 alpha scope → beta mandate filtered out", async () => {
		const tools = captureTools(
			{ "mandates:list": MANDATES_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_mandates")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("mnd_b1");
	});

	it("LMND-M2 alpha scope → alpha mandate visible", async () => {
		const tools = captureTools(
			{ "mandates:list": MANDATES_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_mandates")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("mnd_a1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 4 — get_bu (Convex query: businessUnits:get)
// ─────────────────────────────────────────────────────────────────────────────

const alphaBu = {
	_id: "bu_a",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	name: "Alpha BU",
};

const betaBu = {
	_id: "bu_b",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	name: "Beta BU",
};

describe("GBU — get_bu scope-aware", () => {
	it("GBU-T1 master scope → row returned", async () => {
		const tools = captureTools(
			{ "businessUnits:get": alphaBu },
			masterCtx(),
		);
		const res = await tools.get("get_bu")!.handler({ buId: "bu_a" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Alpha BU");
	});

	it("GBU-T2 non-master in-scope → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "businessUnits:get": alphaBu },
			alphaCtx(),
		);
		const res = await tools.get("get_bu")!.handler({ buId: "bu_a" });
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GBU-T3 legacy bearer → row returned", async () => {
		const tools = captureTools({ "businessUnits:get": betaBu });
		const res = await tools.get("get_bu")!.handler({ buId: "bu_b" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Beta BU");
	});

	it("GBU-M1 cross-tenant: alpha caller, beta BU → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "businessUnits:get": betaBu },
			alphaCtx(),
		);
		const res = await tools.get("get_bu")!.handler({ buId: "bu_b" });
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GBU-M2 alpha caller, alpha BU → content visible (no Forbidden)", async () => {
		const tools = captureTools(
			{ "businessUnits:get": alphaBu },
			alphaCtx(),
		);
		const res = await tools.get("get_bu")!.handler({ buId: "bu_a" });
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("Alpha BU");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 5 — list_bus (Convex query: businessUnits:list)
// ─────────────────────────────────────────────────────────────────────────────

const BUS_FIXTURE = [
	{
		_id: "bu_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		name: "Alpha BU",
	},
	{
		_id: "bu_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		name: "Beta BU",
	},
	{
		_id: "bu_g1",
		createdBy: "gamma",
		namespace: "global",
		name: "Gamma BU",
	},
];

describe("LBUS — list_bus scope-aware", () => {
	it("LBUS-T1 master scope → all 3 rows visible", async () => {
		const tools = captureTools(
			{ "businessUnits:list": BUS_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("list_bus")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("bu_a1");
		expect(res.content[0].text).toContain("bu_b1");
	});

	it("LBUS-T2 non-master → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "businessUnits:list": BUS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_bus")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("LBUS-T3 legacy bearer → all rows visible", async () => {
		const tools = captureTools({ "businessUnits:list": BUS_FIXTURE });
		const res = await tools.get("list_bus")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("bu_b1");
	});

	it("LBUS-M1 alpha scope → beta BU filtered out", async () => {
		const tools = captureTools(
			{ "businessUnits:list": BUS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_bus")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("bu_b1");
	});

	it("LBUS-M2 alpha scope → alpha BU visible", async () => {
		const tools = captureTools(
			{ "businessUnits:list": BUS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_bus")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("bu_a1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 6 — list_repo_mappings (Convex query: githubRepoMapping:list)
// ─────────────────────────────────────────────────────────────────────────────

const REPO_MAPPINGS_FIXTURE = [
	{
		_id: "rm_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		repo: "alpha/repo",
	},
	{
		_id: "rm_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		repo: "beta/repo",
	},
	{
		_id: "rm_g1",
		createdBy: "gamma",
		namespace: "global",
		repo: "gamma/repo",
	},
];

describe("LRM — list_repo_mappings scope-aware", () => {
	it("LRM-T1 master scope → all 3 rows visible", async () => {
		const tools = captureTools(
			{ "githubRepoMapping:list": REPO_MAPPINGS_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("list_repo_mappings")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("rm_a1");
		expect(res.content[0].text).toContain("rm_b1");
	});

	it("LRM-T2 non-master → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "githubRepoMapping:list": REPO_MAPPINGS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_repo_mappings")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("LRM-T3 legacy bearer → all rows visible", async () => {
		const tools = captureTools({
			"githubRepoMapping:list": REPO_MAPPINGS_FIXTURE,
		});
		const res = await tools.get("list_repo_mappings")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("rm_b1");
	});

	it("LRM-M1 alpha scope → beta repo mapping filtered out", async () => {
		const tools = captureTools(
			{ "githubRepoMapping:list": REPO_MAPPINGS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_repo_mappings")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("rm_b1");
	});

	it("LRM-M2 alpha scope → alpha repo mapping visible", async () => {
		const tools = captureTools(
			{ "githubRepoMapping:list": REPO_MAPPINGS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_repo_mappings")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("rm_a1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 7 — list_issues (Convex query: issues:listByProject when no filters)
// ─────────────────────────────────────────────────────────────────────────────

const ISSUES_FIXTURE = [
	{
		_id: "iss_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		title: "alpha issue",
	},
	{
		_id: "iss_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		title: "beta issue",
	},
	{
		_id: "iss_g1",
		createdBy: "gamma",
		namespace: "global",
		title: "gamma issue",
	},
];

describe("LISS — list_issues scope-aware", () => {
	it("LISS-T1 master scope → all 3 rows visible", async () => {
		const tools = captureTools(
			{ "issues:listByProject": ISSUES_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("list_issues")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("iss_a1");
		expect(res.content[0].text).toContain("iss_b1");
	});

	it("LISS-T2 non-master → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "issues:listByProject": ISSUES_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_issues")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("LISS-T3 legacy bearer → all rows visible", async () => {
		const tools = captureTools({ "issues:listByProject": ISSUES_FIXTURE });
		const res = await tools.get("list_issues")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("iss_b1");
	});

	it("LISS-M1 alpha scope → beta issue filtered out", async () => {
		const tools = captureTools(
			{ "issues:listByProject": ISSUES_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_issues")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("iss_b1");
	});

	it("LISS-M2 alpha scope → alpha issue visible", async () => {
		const tools = captureTools(
			{ "issues:listByProject": ISSUES_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_issues")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("iss_a1");
	});
});

// betaCtx exported via builder for symmetry; not asserted directly to keep
// the 35-test envelope tight (5 tests × 7 tools).
void betaCtx;
