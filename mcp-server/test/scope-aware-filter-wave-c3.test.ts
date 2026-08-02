/**
 * S3.1.C Wave C Phase C3 — FINAL BATCH scope-aware filter applied to 8 tools
 * (7 read-path + 1 write `instantiate_template_into_mission`).
 *
 * Sprint    S3.1.C
 * Mission   k57c7s478gw1a3e5gmhdeptg5n87z78n
 * Task      k17fjd4dvp34k9q57t5e1qzrv187zz9n
 * Doctrine  decisions/doctrine-scope-aware-filter-2026-05-26.md (D3 base)
 *           memory j579y6f31g7xzgtgdnpgetdmjx87ztyj (D9-D14 extension)
 *           Eta candidate: scope-aware-migration-inventory-must-be-grep-derived
 * Precedent Wave A SHA 251d183 (list_memories + get_memory)
 *           Wave B SHA 0d1ea94 (list_briefing_notes + list_messages + list_peers)
 *           Wave C0 SHA c516b88 (get_briefing_note)
 *           Wave C1 SHA 03f4d251 (7 reads)
 *           Wave C2 SHA d19897e (7 reads)
 *
 * Tools covered in Wave C3 (authoritative grep-derived inventory of remaining
 * `guardMasterOnly` call sites, excluding L710 `soft_delete_memory` which is
 * intentionally exempt — master-gated destructive, no per-resource RBAC):
 *
 *   1. get_issue                            (tools.ts L4652) — get
 *   2. issue_stats                          (tools.ts L4837) — aggregate
 *   3. search_fix_patterns                  (tools.ts L5060) — list (action)
 *   4. list_fix_patterns                    (tools.ts L5113) — list
 *   5. get_mission_template                 (tools.ts L5202) — get
 *   6. instantiate_template_into_mission    (tools.ts L5364) — write (pre-mutation guard)
 *   7. list_errors                          (tools.ts L5533) — list
 *   8. get_error                            (tools.ts L5571) — get
 *
 * TDD discipline (mirrors C1/C2): at RED, each tool's handler still calls
 * `guardMasterOnly` → non-master scope receives Forbidden envelope. Tests
 * T2 + M1 + M2 assert NOT Forbidden → FAIL at RED. At GREEN, guardMasterOnly
 * is removed and rows pass through scopeFilterList / scopeFilterGet; for
 * `instantiate_template_into_mission` the target mission is fetched and
 * scope-checked BEFORE the instantiate mutation.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders (mirror C1/C2)
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
		scopes: ["vantage:read", "vantage:write"],
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
// Lightweight MCP server + Convex mocks (mirrors C0/C1/C2).
// ─────────────────────────────────────────────────────────────────────────────

type CapturedTool = {
	name: string;
	handler: (args: any) => any;
};

function captureTools(
	queryReturns: Record<string, unknown>,
	oauthCtx?: OAuthContext,
	mutationReturns: Record<string, unknown> = {},
	actionReturns: Record<string, unknown> = {},
): {
	tools: Map<string, CapturedTool>;
	mutationCalls: { path: string; args: any }[];
} {
	const tools = new Map<string, CapturedTool>();
	const mutationCalls: { path: string; args: any }[] = [];
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
		mutation: async (path: string, args: any) => {
			mutationCalls.push({ path, args });
			if (path in mutationReturns) return mutationReturns[path];
			return null;
		},
		action: async (path: string, _args: any) => {
			if (path in actionReturns) return actionReturns[path];
			return null;
		},
	} as any;
	registerTools(mockServer, mockConvex, oauthCtx);
	return { tools, mutationCalls };
}

function isForbiddenResponse(res: any): boolean {
	if (!res || res.isError !== true) return false;
	const text = res.content?.[0]?.text ?? "";
	return typeof text === "string" && text.includes("Forbidden");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 1 — get_issue (Convex query: issues:getByRepoNumber)
// ─────────────────────────────────────────────────────────────────────────────

const alphaIssue = {
	_id: "iss_a",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	title: "alpha issue",
};
const betaIssue = {
	_id: "iss_b",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	title: "beta issue",
};

describe("GISS — get_issue scope-aware", () => {
	it("GISS-T1 master scope → row returned", async () => {
		const { tools } = captureTools(
			{ "issues:getByRepoNumber": alphaIssue },
			masterCtx(),
		);
		const res = await tools
			.get("get_issue")!
			.handler({ repo: "x/y", issueNumber: 1 });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("alpha issue");
	});

	// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8) —
	// INTENDED BEHAVIOR CHANGE mirroring LE-T2/GE-T2 above: issues rows carry
	// NEITHER createdBy NOR namespace in the real schema (convex/schema.ts:421)
	// — this fixture's fields were fictional. Passing unmapped rows through
	// scopeFilterGet refused every non-master caller silently (refus-total),
	// which is what this test previously asserted as acceptable
	// ("NOT Forbidden"). get_issue is now master-only (same table, same
	// reasoning as list_issues/list_errors), so non-master gets an EXPLICIT
	// Forbidden instead of a silent null.
	it("GISS-T2 non-master in-scope → Forbidden (master-only tool, structural fix)", async () => {
		const { tools } = captureTools(
			{ "issues:getByRepoNumber": alphaIssue },
			alphaCtx(),
		);
		const res = await tools
			.get("get_issue")!
			.handler({ repo: "x/y", issueNumber: 1 });
		expect(isForbiddenResponse(res)).toBe(true);
	});

	it("GISS-T3 legacy bearer → row returned", async () => {
		const { tools } = captureTools({
			"issues:getByRepoNumber": betaIssue,
		});
		const res = await tools
			.get("get_issue")!
			.handler({ repo: "x/y", issueNumber: 2 });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("beta issue");
	});

	it("GISS-M1 cross-tenant alpha→beta → Forbidden (master-only, no owner exists)", async () => {
		const { tools } = captureTools(
			{ "issues:getByRepoNumber": betaIssue },
			alphaCtx(),
		);
		const res = await tools
			.get("get_issue")!
			.handler({ repo: "x/y", issueNumber: 2 });
		expect(isForbiddenResponse(res)).toBe(true);
	});

	it("GISS-M2 alpha caller, alpha issue → Forbidden (no client owner for this table)", async () => {
		const { tools } = captureTools(
			{ "issues:getByRepoNumber": alphaIssue },
			alphaCtx(),
		);
		const res = await tools
			.get("get_issue")!
			.handler({ repo: "x/y", issueNumber: 1 });
		expect(isForbiddenResponse(res)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 2 — issue_stats (Convex query: issues:getStats)
// ─────────────────────────────────────────────────────────────────────────────

const STATS_FIXTURE = {
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	open: 3,
	fixed: 2,
};

describe("IST — issue_stats scope-aware", () => {
	it("IST-T1 master scope → stats returned", async () => {
		const { tools } = captureTools(
			{ "issues:getStats": STATS_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("issue_stats")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain('"open": 3');
	});

	// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8) —
	// INTENDED BEHAVIOR CHANGE: issue_stats returns an AGGREGATE counts object
	// (issues:getStats), not per-row data. There is no createdBy/namespace to
	// discriminate on for an aggregate; this fixture's fields were fictional.
	// issue_stats is now master-only, mirroring list_errors' fleet-aggregate
	// reasoning.
	it("IST-T2 non-master in-scope → Forbidden (master-only tool, structural fix)", async () => {
		const { tools } = captureTools(
			{ "issues:getStats": STATS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("issue_stats")!.handler({});
		expect(isForbiddenResponse(res)).toBe(true);
	});

	it("IST-T3 legacy bearer → stats returned", async () => {
		const { tools } = captureTools({
			"issues:getStats": STATS_FIXTURE,
		});
		const res = await tools.get("issue_stats")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain('"open": 3');
	});

	it("IST-M1 cross-tenant beta caller, alpha-owned stats → Forbidden (master-only, no owner exists)", async () => {
		const { tools } = captureTools(
			{ "issues:getStats": STATS_FIXTURE },
			betaCtx(),
		);
		const res = await tools.get("issue_stats")!.handler({});
		expect(isForbiddenResponse(res)).toBe(true);
	});

	it("IST-M2 alpha caller, alpha-owned stats → Forbidden (no client owner for this table)", async () => {
		const { tools } = captureTools(
			{ "issues:getStats": STATS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("issue_stats")!.handler({});
		expect(isForbiddenResponse(res)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 3 — search_fix_patterns (Convex action: search:searchFixPatterns)
// ─────────────────────────────────────────────────────────────────────────────

const FIX_PATTERN_FIXTURE = [
	{
		_id: "fp_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		symptom: "alpha symptom",
	},
	{
		_id: "fp_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		symptom: "beta symptom",
	},
	{
		_id: "fp_g1",
		createdBy: "gamma",
		namespace: "global",
		symptom: "gamma symptom",
	},
];

describe("SFP — search_fix_patterns scope-aware", () => {
	it("SFP-T1 master scope → all 3 patterns visible", async () => {
		const { tools } = captureTools(
			{},
			masterCtx(),
			{},
			{ "search:searchFixPatterns": FIX_PATTERN_FIXTURE },
		);
		const res = await tools
			.get("search_fix_patterns")!
			.handler({ query: "symptom" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("fp_a1");
		expect(res.content[0].text).toContain("fp_b1");
	});

	it("SFP-T2 non-master → NOT Forbidden", async () => {
		const { tools } = captureTools(
			{},
			alphaCtx(),
			{},
			{ "search:searchFixPatterns": FIX_PATTERN_FIXTURE },
		);
		const res = await tools
			.get("search_fix_patterns")!
			.handler({ query: "symptom" });
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("SFP-T3 legacy bearer → all 3 visible", async () => {
		const { tools } = captureTools(
			{},
			undefined,
			{},
			{ "search:searchFixPatterns": FIX_PATTERN_FIXTURE },
		);
		const res = await tools
			.get("search_fix_patterns")!
			.handler({ query: "symptom" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("fp_b1");
	});

	it("SFP-M1 alpha scope → beta pattern filtered out", async () => {
		const { tools } = captureTools(
			{},
			alphaCtx(),
			{},
			{ "search:searchFixPatterns": FIX_PATTERN_FIXTURE },
		);
		const res = await tools
			.get("search_fix_patterns")!
			.handler({ query: "symptom" });
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("fp_b1");
	});

	it("SFP-M2 alpha scope → alpha pattern visible", async () => {
		const { tools } = captureTools(
			{},
			alphaCtx(),
			{},
			{ "search:searchFixPatterns": FIX_PATTERN_FIXTURE },
		);
		const res = await tools
			.get("search_fix_patterns")!
			.handler({ query: "symptom" });
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("fp_a1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 4 — list_fix_patterns (Convex query: fixPatterns:listAll, no project filter)
// ─────────────────────────────────────────────────────────────────────────────

describe("LFP — list_fix_patterns scope-aware", () => {
	it("LFP-T1 master scope → all 3 patterns visible", async () => {
		const { tools } = captureTools(
			{ "fixPatterns:listAll": FIX_PATTERN_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("list_fix_patterns")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("fp_a1");
		expect(res.content[0].text).toContain("fp_b1");
	});

	it("LFP-T2 non-master → NOT Forbidden", async () => {
		const { tools } = captureTools(
			{ "fixPatterns:listAll": FIX_PATTERN_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_fix_patterns")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("LFP-T3 legacy bearer → all 3 visible", async () => {
		const { tools } = captureTools({
			"fixPatterns:listAll": FIX_PATTERN_FIXTURE,
		});
		const res = await tools.get("list_fix_patterns")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("fp_b1");
	});

	it("LFP-M1 alpha scope → beta pattern filtered out", async () => {
		const { tools } = captureTools(
			{ "fixPatterns:listAll": FIX_PATTERN_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_fix_patterns")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("fp_b1");
	});

	it("LFP-M2 alpha scope → alpha pattern visible", async () => {
		const { tools } = captureTools(
			{ "fixPatterns:listAll": FIX_PATTERN_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_fix_patterns")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("fp_a1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 5 — get_mission_template (Convex query: missionTemplates:getByName)
// ─────────────────────────────────────────────────────────────────────────────

const alphaTemplate = {
	_id: "mt_a",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	name: "alpha-template",
};
const betaTemplate = {
	_id: "mt_b",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	name: "beta-template",
};

describe("GMT — get_mission_template scope-aware", () => {
	it("GMT-T1 master scope → template returned", async () => {
		const { tools } = captureTools(
			{ "missionTemplates:getByName": alphaTemplate },
			masterCtx(),
		);
		const res = await tools
			.get("get_mission_template")!
			.handler({ name: "alpha-template" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("alpha-template");
	});

	it("GMT-T2 non-master in-scope → NOT Forbidden", async () => {
		const { tools } = captureTools(
			{ "missionTemplates:getByName": alphaTemplate },
			alphaCtx(),
		);
		const res = await tools
			.get("get_mission_template")!
			.handler({ name: "alpha-template" });
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GMT-T3 legacy bearer → template returned", async () => {
		const { tools } = captureTools({
			"missionTemplates:getByName": betaTemplate,
		});
		const res = await tools
			.get("get_mission_template")!
			.handler({ name: "beta-template" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("beta-template");
	});

	it("GMT-M1 cross-tenant alpha→beta → NOT Forbidden", async () => {
		const { tools } = captureTools(
			{ "missionTemplates:getByName": betaTemplate },
			alphaCtx(),
		);
		const res = await tools
			.get("get_mission_template")!
			.handler({ name: "beta-template" });
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GMT-M2 alpha caller, alpha template → content visible", async () => {
		const { tools } = captureTools(
			{ "missionTemplates:getByName": alphaTemplate },
			alphaCtx(),
		);
		const res = await tools
			.get("get_mission_template")!
			.handler({ name: "alpha-template" });
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("alpha-template");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 6 — instantiate_template_into_mission (WRITE — pre-mutation scope guard)
//   Convex query missions:get → scopeFilterGet → if null reject before
//   the missionTemplates:instantiateTemplateIntoMission mutation runs.
// ─────────────────────────────────────────────────────────────────────────────

const alphaMission = {
	_id: "msn_a",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	title: "alpha mission",
};
const betaMission = {
	_id: "msn_b",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	title: "beta mission",
};

describe("ITM — instantiate_template_into_mission scope-aware (write, pre-mutation)", () => {
	it("ITM-T1 master scope → mutation runs, result returned", async () => {
		const { tools, mutationCalls } = captureTools(
			{ "missions:get": alphaMission },
			masterCtx(),
			{
				"missionTemplates:instantiateTemplateIntoMission": {
					createdTaskIds: ["t1", "t2"],
				},
			},
		);
		const res = await tools
			.get("instantiate_template_into_mission")!
			.handler({ templateName: "alpha-template", missionId: "msn_a" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("t1");
		expect(
			mutationCalls.some(
				(c) =>
					c.path === "missionTemplates:instantiateTemplateIntoMission",
			),
		).toBe(true);
	});

	it("ITM-T2 non-master in-scope → NOT Forbidden, mutation runs", async () => {
		const { tools, mutationCalls } = captureTools(
			{ "missions:get": alphaMission },
			alphaCtx(),
			{
				"missionTemplates:instantiateTemplateIntoMission": {
					createdTaskIds: ["t1"],
				},
			},
		);
		const res = await tools
			.get("instantiate_template_into_mission")!
			.handler({ templateName: "alpha-template", missionId: "msn_a" });
		expect(isForbiddenResponse(res)).toBe(false);
		expect(
			mutationCalls.some(
				(c) =>
					c.path === "missionTemplates:instantiateTemplateIntoMission",
			),
		).toBe(true);
	});

	it("ITM-T3 legacy bearer → mutation runs", async () => {
		const { tools, mutationCalls } = captureTools(
			{ "missions:get": alphaMission },
			undefined,
			{
				"missionTemplates:instantiateTemplateIntoMission": {
					createdTaskIds: ["t1"],
				},
			},
		);
		const res = await tools
			.get("instantiate_template_into_mission")!
			.handler({ templateName: "alpha-template", missionId: "msn_a" });
		expect(res.isError).not.toBe(true);
		expect(
			mutationCalls.some(
				(c) =>
					c.path === "missionTemplates:instantiateTemplateIntoMission",
			),
		).toBe(true);
	});

	it("ITM-M1 cross-tenant alpha→beta mission → mutation BLOCKED before run", async () => {
		const { tools, mutationCalls } = captureTools(
			{ "missions:get": betaMission },
			alphaCtx(),
			{
				"missionTemplates:instantiateTemplateIntoMission": {
					createdTaskIds: ["leaked"],
				},
			},
		);
		const res = await tools
			.get("instantiate_template_into_mission")!
			.handler({ templateName: "x", missionId: "msn_b" });
		// Mutation MUST NOT have run (pre-mutation guard).
		expect(
			mutationCalls.some(
				(c) =>
					c.path === "missionTemplates:instantiateTemplateIntoMission",
			),
		).toBe(false);
		// And the response is an error envelope (not a leaked success).
		expect(res.isError).toBe(true);
	});

	it("ITM-M2 alpha caller, alpha mission → mutation runs, result visible", async () => {
		const { tools, mutationCalls } = captureTools(
			{ "missions:get": alphaMission },
			alphaCtx(),
			{
				"missionTemplates:instantiateTemplateIntoMission": {
					createdTaskIds: ["t1", "t2", "t3"],
				},
			},
		);
		const res = await tools
			.get("instantiate_template_into_mission")!
			.handler({ templateName: "alpha-template", missionId: "msn_a" });
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("t1");
		expect(
			mutationCalls.some(
				(c) =>
					c.path === "missionTemplates:instantiateTemplateIntoMission",
			),
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 7 — list_errors (Convex query: errorMonitor:listErrors)
// ─────────────────────────────────────────────────────────────────────────────

const ERRORS_FIXTURE = [
	{
		_id: "err_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		message: "alpha error",
	},
	{
		_id: "err_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		message: "beta error",
	},
	{
		_id: "err_g1",
		createdBy: "gamma",
		namespace: "global",
		message: "gamma error",
	},
];

describe("LE — list_errors scope-aware", () => {
	it("LE-T1 master scope → all 3 errors visible", async () => {
		const { tools } = captureTools(
			{ "errorMonitor:listErrors": ERRORS_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("list_errors")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("err_a1");
		expect(res.content[0].text).toContain("err_b1");
	});

	// k177617dqg6z5c099p1rdp5rqn8b2rp0 — INTENDED BEHAVIOR CHANGE. errorLogs
	// rows carry NEITHER createdBy NOR namespace in the real schema
	// (convex/schema.ts:895) — this fixture's fields were fictional. Passing
	// unmapped rows through scopeFilterList refused every non-master caller
	// silently (refus-total), which is what this test previously asserted
	// as acceptable ("NOT Forbidden"). The fix is structural: list_errors is
	// now master-only, so non-master gets an EXPLICIT Forbidden instead of a
	// silent empty list.
	it("LE-T2 non-master → Forbidden (master-only tool, structural fix)", async () => {
		const { tools } = captureTools(
			{ "errorMonitor:listErrors": ERRORS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_errors")!.handler({});
		expect(isForbiddenResponse(res)).toBe(true);
	});

	it("LE-T3 legacy bearer → all 3 visible", async () => {
		const { tools } = captureTools({
			"errorMonitor:listErrors": ERRORS_FIXTURE,
		});
		const res = await tools.get("list_errors")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("err_b1");
	});

	// k177617dqg6z5c099p1rdp5rqn8b2rp0 — INTENDED BEHAVIOR CHANGE. See LE-T2
	// note above: errorLogs has no owner field, so there is no "alpha's own
	// error" concept — master-only closes the surface entirely.
	it("LE-M1 alpha scope → Forbidden, beta error never reached", async () => {
		const { tools } = captureTools(
			{ "errorMonitor:listErrors": ERRORS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_errors")!.handler({});
		expect(isForbiddenResponse(res)).toBe(true);
		expect(res.content[0].text).not.toContain("err_b1");
	});

	it("LE-M2 alpha scope → Forbidden (no client owner for this table)", async () => {
		const { tools } = captureTools(
			{ "errorMonitor:listErrors": ERRORS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_errors")!.handler({});
		expect(isForbiddenResponse(res)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 8 — get_error (Convex query: errorMonitor:getError)
// ─────────────────────────────────────────────────────────────────────────────

const alphaError = {
	_id: "err_a",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	message: "alpha error",
};
const betaError = {
	_id: "err_b",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	message: "beta error",
};

describe("GE — get_error scope-aware", () => {
	it("GE-T1 master scope → row returned", async () => {
		const { tools } = captureTools(
			{ "errorMonitor:getError": alphaError },
			masterCtx(),
		);
		const res = await tools.get("get_error")!.handler({ errorId: "err_a" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("alpha error");
	});

	// k177617dqg6z5c099p1rdp5rqn8b2rp0 — INTENDED BEHAVIOR CHANGE, same as
	// LE-T2 above: errorLogs has no client-owner field, get_error is now
	// master-only.
	it("GE-T2 non-master in-scope → Forbidden (master-only tool, structural fix)", async () => {
		const { tools } = captureTools(
			{ "errorMonitor:getError": alphaError },
			alphaCtx(),
		);
		const res = await tools.get("get_error")!.handler({ errorId: "err_a" });
		expect(isForbiddenResponse(res)).toBe(true);
	});

	it("GE-T3 legacy bearer → row returned", async () => {
		const { tools } = captureTools({
			"errorMonitor:getError": betaError,
		});
		const res = await tools.get("get_error")!.handler({ errorId: "err_b" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("beta error");
	});

	it("GE-M1 cross-tenant alpha→beta → Forbidden (master-only, no owner exists)", async () => {
		const { tools } = captureTools(
			{ "errorMonitor:getError": betaError },
			alphaCtx(),
		);
		const res = await tools.get("get_error")!.handler({ errorId: "err_b" });
		expect(isForbiddenResponse(res)).toBe(true);
	});

	it("GE-M2 alpha caller, alpha error → Forbidden (no client owner for this table)", async () => {
		const { tools } = captureTools(
			{ "errorMonitor:getError": alphaError },
			alphaCtx(),
		);
		const res = await tools.get("get_error")!.handler({ errorId: "err_a" });
		expect(isForbiddenResponse(res)).toBe(true);
	});
});

// betaCtx exported via builder for symmetry.
void betaCtx;
