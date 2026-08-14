/**
 * S3.1.C Wave C Phase C1 — scope-aware filter applied to 7 read-path tools.
 *
 * Sprint    S3.1.C
 * Mission   k57c7s478gw1a3e5gmhdeptg5n87z78n
 * Task      k17fjd4dvp34k9q57t5e1qzrv187zz9n
 * Doctrine  decisions/doctrine-scope-aware-filter-2026-05-26.md (D3 base)
 *           memory j579y6f31g7xzgtgdnpgetdmjx87ztyj (D9-D14 extension)
 * Precedent Wave A SHA 251d183 (list_memories + get_memory)
 *           Wave B SHA 0d1ea94 (list_briefing_notes + list_messages + list_peers)
 *           Wave C0 SHA c516b88 (get_briefing_note registration + scope-aware)
 *
 * Tools covered in Wave C1 (first 7 read-path guardMasterOnly call sites in
 * source order, excluding the 6 already handled by Waves A/B/C0):
 *
 *   1. get_profile             (tools.ts L1034) — get
 *   2. list_broadcast_status   (tools.ts L1716) — list
 *   3. list_tasks_by_mission   (tools.ts L2383) — list
 *   4. get_mission             (tools.ts L2585) — get
 *   5. get_diary               (tools.ts L2802) — get
 *   6. list_components         (tools.ts L3266) — list
 *   7. get_component           (tools.ts L3307) — get
 *
 * TDD discipline (mirrors C0 R-tests):
 *   - At RED, each tool's handler still calls `guardMasterOnly` → a non-master
 *     scope receives an `isError: true` envelope with text starting with
 *     "Error: Forbidden: <toolName>". Tests T2 + T4 + T5 assert the response
 *     is NOT that Forbidden envelope → they FAIL at RED.
 *   - At GREEN, `guardMasterOnly` is removed and the post-Convex-query rows
 *     are passed through `scopeFilterList` / `scopeFilterGet` → tests pass.
 *
 * Harness convention (mirrors Wave A/B/C0 § Friction): instead of bootstrapping
 * the full Hono /mcp JSON-RPC envelope, tests use the lightweight duck-typed
 * `McpServer` mock from C0 to capture the registered handler, then invoke it
 * directly with a fixture-returning mocked Convex client.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders (mirror Wave A / Wave B / Wave C0)
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
// Lightweight MCP server + Convex mocks (mirrors C0).
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
		registerTool: (
			name: string,
			_config: Record<string, unknown>,
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
// Tool 1 — get_profile (Convex query: profiles:getProfile)
// Row shape: profiles lack createdBy/namespace natively; we inject synthetic
// scope-filter inputs so the GREEN patch's scopeFilterGet can distinguish.
// ─────────────────────────────────────────────────────────────────────────────

const alphaProfile = {
	_id: "prof_a",
	orchestratorId: "alpha-1",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	name: "Alpha One",
};

const betaProfile = {
	_id: "prof_b",
	orchestratorId: "beta-1",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	name: "Beta One",
};

describe("PROF — get_profile scope-aware", () => {
	it("PROF-T1 master scope → row returned (no isError)", async () => {
		const tools = captureTools(
			{ "profiles:getProfile": alphaProfile },
			masterCtx(),
		);
		const res = await tools.get("get_profile")!.handler({
			orchestratorId: "alpha-1",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("alpha-1");
	});

	it("PROF-T2 non-master in-scope → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "profiles:getProfile": alphaProfile },
			alphaCtx(),
		);
		const res = await tools.get("get_profile")!.handler({
			orchestratorId: "alpha-1",
		});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("PROF-T3 legacy bearer (oauthCtx undefined) → row returned", async () => {
		const tools = captureTools({ "profiles:getProfile": betaProfile });
		const res = await tools.get("get_profile")!.handler({
			orchestratorId: "beta-1",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("beta-1");
	});

	it("PROF-M1 cross-tenant: alpha caller, beta row → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "profiles:getProfile": betaProfile },
			alphaCtx(),
		);
		const res = await tools.get("get_profile")!.handler({
			orchestratorId: "beta-1",
		});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("PROF-M2 in-scope by namespace prefix → row visible (no Forbidden)", async () => {
		const tools = captureTools(
			{ "profiles:getProfile": alphaProfile },
			alphaCtx(),
		);
		const res = await tools.get("get_profile")!.handler({
			orchestratorId: "alpha-1",
		});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("alpha-1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 2 — list_broadcast_status (Convex query: messages:listBroadcastStatus)
//
// Post-incident-fix contract: the backend returns a single status ENVELOPE
// (`{ messageId, from, channel, createdAt, receipts[], truncated }`), never a
// top-level array. Scope filtering applies to the `receipts` array (matched
// on `recipient`), not the envelope — the envelope always survives so a
// scoped caller still learns the broadcast exists.
// ─────────────────────────────────────────────────────────────────────────────

const BROADCAST_ENVELOPE = {
	messageId: "m1",
	from: "gamma",
	channel: "broadcast",
	createdAt: 1000,
	truncated: false,
	receipts: [
		{ _id: "br_a1", recipient: "alpha", readAt: 1 },
		{ _id: "br_b1", recipient: "beta", readAt: 2 },
		{ _id: "br_g1", recipient: "gamma", readAt: 3 },
	],
};

describe("BCAST — list_broadcast_status scope-aware", () => {
	it("BCAST-T1 master scope → all 3 receipts visible", async () => {
		const tools = captureTools(
			{ "messages:listBroadcastStatus": BROADCAST_ENVELOPE },
			masterCtx(),
		);
		const res = await tools.get("list_broadcast_status")!.handler({
			messageId: "m1",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("br_a1");
		expect(res.content[0].text).toContain("br_b1");
		expect(res.content[0].text).toContain("br_g1");
	});

	it("BCAST-T2 non-master in-scope → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "messages:listBroadcastStatus": BROADCAST_ENVELOPE },
			alphaCtx(),
		);
		const res = await tools.get("list_broadcast_status")!.handler({
			messageId: "m1",
		});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("BCAST-T3 legacy bearer → all receipts visible", async () => {
		const tools = captureTools({
			"messages:listBroadcastStatus": BROADCAST_ENVELOPE,
		});
		const res = await tools.get("list_broadcast_status")!.handler({
			messageId: "m1",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("br_b1");
	});

	it("BCAST-M1 alpha scope → beta receipt filtered out", async () => {
		const tools = captureTools(
			{ "messages:listBroadcastStatus": BROADCAST_ENVELOPE },
			alphaCtx(),
		);
		const res = await tools.get("list_broadcast_status")!.handler({
			messageId: "m1",
		});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("br_b1");
	});

	it("BCAST-M2 alpha scope → own alpha receipt still visible, envelope survives", async () => {
		const tools = captureTools(
			{ "messages:listBroadcastStatus": BROADCAST_ENVELOPE },
			alphaCtx(),
		);
		const res = await tools.get("list_broadcast_status")!.handler({
			messageId: "m1",
		});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("br_a1");
		// Envelope metadata is not gated by receipt-level scope filtering.
		expect(res.content[0].text).toContain("m1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 3 — list_tasks_by_mission (Convex query: tasks:listByMission)
// ─────────────────────────────────────────────────────────────────────────────

const TASKS_FIXTURE = [
	{
		_id: "task_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		title: "alpha task",
	},
	{
		_id: "task_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		title: "beta task",
	},
	{
		_id: "task_g1",
		createdBy: "gamma",
		namespace: "global",
		title: "gamma task",
	},
];

describe("LTBM — list_tasks_by_mission scope-aware", () => {
	it("LTBM-T1 master scope → all 3 rows visible", async () => {
		const tools = captureTools(
			{ "tasks:listByMission": TASKS_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("list_tasks_by_mission")!.handler({
			missionId: "m1",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("task_a1");
		expect(res.content[0].text).toContain("task_b1");
	});

	it("LTBM-T2 non-master → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "tasks:listByMission": TASKS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_tasks_by_mission")!.handler({
			missionId: "m1",
		});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("LTBM-T3 legacy bearer → all rows visible", async () => {
		const tools = captureTools({ "tasks:listByMission": TASKS_FIXTURE });
		const res = await tools.get("list_tasks_by_mission")!.handler({
			missionId: "m1",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("task_b1");
	});

	it("LTBM-M1 alpha scope → beta task filtered out", async () => {
		const tools = captureTools(
			{ "tasks:listByMission": TASKS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_tasks_by_mission")!.handler({
			missionId: "m1",
		});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("task_b1");
	});

	it("LTBM-M2 alpha scope → alpha task visible", async () => {
		const tools = captureTools(
			{ "tasks:listByMission": TASKS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_tasks_by_mission")!.handler({
			missionId: "m1",
		});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("task_a1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 4 — get_mission (Convex query: missions:get)
// ─────────────────────────────────────────────────────────────────────────────

const alphaMission = {
	_id: "mis_a",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	name: "Alpha Mission",
};

const betaMission = {
	_id: "mis_b",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	name: "Beta Mission",
};

describe("GMIS — get_mission scope-aware", () => {
	it("GMIS-T1 master scope → row returned", async () => {
		const tools = captureTools({ "missions:get": alphaMission }, masterCtx());
		const res = await tools.get("get_mission")!.handler({ missionId: "mis_a" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Alpha Mission");
	});

	it("GMIS-T2 non-master in-scope → NOT Forbidden", async () => {
		const tools = captureTools({ "missions:get": alphaMission }, alphaCtx());
		const res = await tools.get("get_mission")!.handler({ missionId: "mis_a" });
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GMIS-T3 legacy bearer → row returned", async () => {
		const tools = captureTools({ "missions:get": betaMission });
		const res = await tools.get("get_mission")!.handler({ missionId: "mis_b" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Beta Mission");
	});

	it("GMIS-M1 cross-tenant: alpha caller, beta mission → NOT Forbidden", async () => {
		const tools = captureTools({ "missions:get": betaMission }, alphaCtx());
		const res = await tools.get("get_mission")!.handler({ missionId: "mis_b" });
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GMIS-M2 alpha caller, alpha mission → row content visible (no Forbidden)", async () => {
		const tools = captureTools({ "missions:get": alphaMission }, alphaCtx());
		const res = await tools.get("get_mission")!.handler({ missionId: "mis_a" });
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("Alpha Mission");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 5 — get_diary (Convex query: diary:get)
// ─────────────────────────────────────────────────────────────────────────────

const alphaDiary = {
	_id: "d_a",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	date: "2026-06-03",
	orchestrator: "alpha",
	content: "alpha diary content",
};

const betaDiary = {
	_id: "d_b",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	date: "2026-06-03",
	orchestrator: "beta",
	content: "beta diary content",
};

describe("GDIA — get_diary scope-aware", () => {
	it("GDIA-T1 master scope → row returned", async () => {
		const tools = captureTools({ "diary:get": alphaDiary }, masterCtx());
		const res = await tools.get("get_diary")!.handler({
			date: "2026-06-03",
			orchestrator: "alpha",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("alpha diary content");
	});

	it("GDIA-T2 non-master in-scope → NOT Forbidden", async () => {
		const tools = captureTools({ "diary:get": alphaDiary }, alphaCtx());
		const res = await tools.get("get_diary")!.handler({
			date: "2026-06-03",
			orchestrator: "alpha",
		});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GDIA-T3 legacy bearer → row returned", async () => {
		const tools = captureTools({ "diary:get": betaDiary });
		const res = await tools.get("get_diary")!.handler({
			date: "2026-06-03",
			orchestrator: "beta",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("beta diary content");
	});

	it("GDIA-M1 cross-tenant: alpha caller, beta diary → NOT Forbidden", async () => {
		const tools = captureTools({ "diary:get": betaDiary }, alphaCtx());
		const res = await tools.get("get_diary")!.handler({
			date: "2026-06-03",
			orchestrator: "beta",
		});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GDIA-M2 alpha caller, alpha diary → content visible (no Forbidden)", async () => {
		const tools = captureTools({ "diary:get": alphaDiary }, alphaCtx());
		const res = await tools.get("get_diary")!.handler({
			date: "2026-06-03",
			orchestrator: "alpha",
		});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("alpha diary content");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 6 — list_components (Convex query: components:list)
// ─────────────────────────────────────────────────────────────────────────────

const COMPONENTS_FIXTURE = [
	{
		_id: "c_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		name: "alpha-skill",
		type: "skill",
	},
	{
		_id: "c_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		name: "beta-skill",
		type: "skill",
	},
	{
		_id: "c_g1",
		createdBy: "gamma",
		namespace: "global",
		name: "gamma-skill",
		type: "skill",
	},
];

describe("LCMP — list_components scope-aware", () => {
	it("LCMP-T1 master scope → all 3 rows visible", async () => {
		const tools = captureTools(
			{ "components:list": COMPONENTS_FIXTURE },
			masterCtx(),
		);
		const res = await tools.get("list_components")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("c_a1");
		expect(res.content[0].text).toContain("c_b1");
	});

	it("LCMP-T2 non-master → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "components:list": COMPONENTS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_components")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("LCMP-T3 legacy bearer → all rows visible", async () => {
		const tools = captureTools({ "components:list": COMPONENTS_FIXTURE });
		const res = await tools.get("list_components")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("c_b1");
	});

	it("LCMP-M1 alpha scope → beta component filtered out", async () => {
		const tools = captureTools(
			{ "components:list": COMPONENTS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_components")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).not.toContain("c_b1");
	});

	it("LCMP-M2 alpha scope → alpha component visible", async () => {
		const tools = captureTools(
			{ "components:list": COMPONENTS_FIXTURE },
			alphaCtx(),
		);
		const res = await tools.get("list_components")!.handler({});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("c_a1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 7 — get_component (Convex query: components:get)
// ─────────────────────────────────────────────────────────────────────────────

const alphaComponent = {
	_id: "cmp_a",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	name: "alpha-skill",
	type: "skill",
};

const betaComponent = {
	_id: "cmp_b",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	name: "beta-skill",
	type: "skill",
};

describe("GCMP — get_component scope-aware", () => {
	it("GCMP-T1 master scope → row returned", async () => {
		const tools = captureTools(
			{ "components:get": alphaComponent },
			masterCtx(),
		);
		const res = await tools.get("get_component")!.handler({
			name: "alpha-skill",
			type: "skill",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("alpha-skill");
	});

	it("GCMP-T2 non-master in-scope → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "components:get": alphaComponent },
			alphaCtx(),
		);
		const res = await tools.get("get_component")!.handler({
			name: "alpha-skill",
			type: "skill",
		});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GCMP-T3 legacy bearer → row returned", async () => {
		const tools = captureTools({ "components:get": betaComponent });
		const res = await tools.get("get_component")!.handler({
			name: "beta-skill",
			type: "skill",
		});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("beta-skill");
	});

	it("GCMP-M1 cross-tenant: alpha caller, beta component → NOT Forbidden", async () => {
		const tools = captureTools(
			{ "components:get": betaComponent },
			alphaCtx(),
		);
		const res = await tools.get("get_component")!.handler({
			name: "beta-skill",
			type: "skill",
		});
		expect(isForbiddenResponse(res)).toBe(false);
	});

	it("GCMP-M2 alpha caller, alpha component → content visible (no Forbidden)", async () => {
		const tools = captureTools(
			{ "components:get": alphaComponent },
			alphaCtx(),
		);
		const res = await tools.get("get_component")!.handler({
			name: "alpha-skill",
			type: "skill",
		});
		expect(isForbiddenResponse(res)).toBe(false);
		expect(res.content[0].text).toContain("alpha-skill");
	});
});

// betaCtx exported via builder for symmetry; not asserted directly to keep
// the 35-test envelope tight (5 tests × 7 tools).
void betaCtx;
