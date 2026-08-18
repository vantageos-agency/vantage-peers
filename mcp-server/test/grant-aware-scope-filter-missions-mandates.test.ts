/**
 * cloud-identity 0.5.0 consumer upgrade — grant-aware scope filter proven
 * against the REAL MCP tool handlers (get_mission, get_mandate,
 * list_mandates, get_task, list_tasks_by_mission,
 * search_tasks_by_keyword) — not the package predicate in isolation.
 *
 * Task k174y9ra7pp8zed3bcczk6xaed8cpynp.
 *
 * Eta REVISE on PR #1204 (first pass): the original suite imported
 * scopeFilterGet/scopeFilterList from @vantageos/cloud-identity directly and
 * passed grantFields itself — re-proving the predicate (already proven 3x
 * in #11) instead of proving anything the CONSUMER owns. Eta's proof:
 * removing the ["pilot","agents"] argument at the real get_mission call
 * site (src/tools.ts ~L5109) left that suite GREEN 10/10 — the litmus test
 * ("could each assertion still pass if the grant-consulting code were
 * deleted?") was FALSE.
 *
 * This rewrite drives registerTools() end-to-end via the lightweight
 * duck-typed McpServer + Convex mocks (same harness as
 * test/scope-aware-filter-wave-c1.test.ts's captureTools) and invokes the
 * REAL registered handlers. Every "grantee reads" assertion checks BOTH
 * `res.isError !== true` AND that the response body contains a field value
 * unique to the row's content (e.g. its title/name/service string) — never
 * just the row's own `_id`, since a "not found: <id>" error message also
 * contains the id and would make a broken assertion pass vacuously (this
 * was the exact defect in the first draft of this rewrite, caught while
 * proving RED below).
 *
 * Litmus test for THIS suite: could each "grantee reads" assertion still
 * pass if the grant-consulting code (the grantFields array literal at the
 * real call site) were deleted? No — every grantee fixture below carries
 * NEITHER createdBy NOR any namespace matching the scoped identity's
 * namespaceReadPrefixes, so with grantFields unconsulted the handler's own
 * scopeFilterGet/List call falls back to createdBy/namespace-only matching,
 * which finds nothing, and the read fails closed (get_* returns an
 * isError:true "not found" envelope with none of the row's content;
 * list_* omits the row's content entirely).
 *
 * RED→GREEN transcript (get_task, the real call site at src/tools.ts
 * ~L9564-9579):
 *   RED   — grantFields arg removed: `scopeFilterGet(oauthCtx ?? LEGACY_WILDCARD_CTX, row)`
 *           → "non-creator assignee reads their own task via get_task" FAILS
 *             (isError:true, body is "Error: Task not found: task_a", no
 *             "Assigned to alice, created by bob" title text present).
 *   GREEN — grantFields restored: `scopeFilterGet(oauthCtx ?? LEGACY_WILDCARD_CTX, row, ["assignedTo"])`
 *           → same test PASSES (isError undefined, title text present).
 * Command: `npx vitest run test/grant-aware-scope-filter-missions-mandates.test.ts`
 * Reproduced by orchestrator before commit; see task completion note for
 * the literal RED failure output.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Harness — mirrors test/scope-aware-filter-wave-c1.test.ts's captureTools:
// a duck-typed McpServer that records `registerTool(name, config, handler)`
// calls, plus a Convex mock keyed by "table:query" path. registerTools() is
// the REAL production function — nothing here re-implements grant logic.
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

// SCOPED identity under test: "alice" — a real OAuthContext (as consumed by
// the MCP server), NOT the package-level OAuthCtx. Non-master, and NEVER the
// row's creator/namespace owner — every fixture below carries a `createdBy`/
// `namespace` value belonging to someone else, so a passing "grantee reads"
// assertion is decided purely by the grantFields path in the real handler.
function aliceCtx(): OAuthContext {
	return {
		clientId: "client-alice",
		userId: "user-alice",
		scopes: ["vantage:read"],
		scopeProfile: "tenant-alice",
		fromAllowList: ["alice"],
		namespaceReadPrefixes: ["orchestrator/alice"],
		namespaceWritePrefixes: ["project/alice"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// MISSIONS — get_mission (real call site: src/tools.ts ~L5109, grantFields
// ["pilot", "agents"]). Rows carry no createdBy/namespace.
// ─────────────────────────────────────────────────────────────────────────────

describe("MISSION — get_mission drives the real handler (pilot, agents grants)", () => {
	it("named as pilot (not creator/namespace member) reads the mission — identity: alice", async () => {
		const mission = {
			_id: "mis_pilot",
			pilot: "alice",
			agents: ["bob"],
			name: "Alice-piloted mission",
		};
		const tools = captureTools({ "missions:get": mission }, aliceCtx());
		const res = await tools
			.get("get_mission")!
			.handler({ missionId: "mis_pilot" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Alice-piloted mission");
	});

	it("named inside agents, not pilot, reads the mission — identity: alice", async () => {
		const mission = {
			_id: "mis_agent",
			pilot: "bob",
			agents: ["carol", "alice"],
			name: "Bob-piloted, Alice as agent",
		};
		const tools = captureTools({ "missions:get": mission }, aliceCtx());
		const res = await tools
			.get("get_mission")!
			.handler({ missionId: "mis_agent" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Bob-piloted, Alice as agent");
	});

	it("named nowhere on the row is denied — identity: alice", async () => {
		const mission = {
			_id: "mis_other",
			pilot: "bob",
			agents: ["carol", "dave"],
			name: "No alice anywhere",
		};
		const tools = captureTools({ "missions:get": mission }, aliceCtx());
		const res = await tools
			.get("get_mission")!
			.handler({ missionId: "mis_other" });
		expect(res.content[0].text).not.toContain("No alice anywhere");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MANDATES — get_mandate (real call site ~L9655) + list_mandates (real call
// site ~L7155), grantFields ["requestedBy", "fulfilledBy"]. Rows carry no
// createdBy/namespace.
// ─────────────────────────────────────────────────────────────────────────────

describe("MANDATE — get_mandate/list_mandates drive the real handlers (requestedBy, fulfilledBy grants)", () => {
	it("named as requestedBy reads the mandate via get_mandate — identity: alice", async () => {
		const mandate = {
			_id: "man_req",
			requestedBy: "alice",
			fulfilledBy: "bob",
			service: "grant-carries-requestedBy-seo",
		};
		const tools = captureTools({ "mandates:get": mandate }, aliceCtx());
		const res = await tools
			.get("get_mandate")!
			.handler({ mandateId: "man_req" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("grant-carries-requestedBy-seo");
	});

	it("named as fulfilledBy (not requestedBy) reads the mandate via get_mandate — identity: alice", async () => {
		const mandate = {
			_id: "man_ful",
			requestedBy: "bob",
			fulfilledBy: "alice",
			service: "grant-carries-fulfilledBy-dev",
		};
		const tools = captureTools({ "mandates:get": mandate }, aliceCtx());
		const res = await tools
			.get("get_mandate")!
			.handler({ mandateId: "man_ful" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("grant-carries-fulfilledBy-dev");
	});

	it("named on neither side is denied via get_mandate — identity: alice", async () => {
		const mandate = {
			_id: "man_none",
			requestedBy: "bob",
			fulfilledBy: "carol",
			service: "grant-carries-neither-ads",
		};
		const tools = captureTools({ "mandates:get": mandate }, aliceCtx());
		const res = await tools
			.get("get_mandate")!
			.handler({ mandateId: "man_none" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).not.toContain("grant-carries-neither-ads");
	});

	it("list_mandates returns both grantee rows and drops the non-grantee — identity: alice", async () => {
		const fixture = [
			{
				_id: "man_req",
				requestedBy: "alice",
				fulfilledBy: "bob",
				service: "grant-list-requestedBy-seo",
			},
			{
				_id: "man_ful",
				requestedBy: "bob",
				fulfilledBy: "alice",
				service: "grant-list-fulfilledBy-dev",
			},
			{
				_id: "man_none",
				requestedBy: "bob",
				fulfilledBy: "carol",
				service: "grant-list-neither-ads",
			},
		];
		const tools = captureTools({ "mandates:list": fixture }, aliceCtx());
		const res = await tools.get("list_mandates")!.handler({});
		expect(res.content[0].text).toContain("grant-list-requestedBy-seo");
		expect(res.content[0].text).toContain("grant-list-fulfilledBy-dev");
		expect(res.content[0].text).not.toContain("grant-list-neither-ads");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TASKS — get_task (real call site ~L9564), list_tasks_by_mission (real
// call site ~L4823), search_tasks_by_keyword (real call site ~L4196).
// grantFields ["assignedTo"]. Fixtures carry createdBy belonging to someone
// else so the assertion is decided purely by assignedTo.
// ─────────────────────────────────────────────────────────────────────────────

describe("TASK — get_task/list_tasks_by_mission/search_tasks_by_keyword drive the real handlers (assignedTo grant)", () => {
	it("non-creator assignee reads their own task via get_task — identity: alice", async () => {
		const task = {
			_id: "task_a",
			createdBy: "bob",
			assignedTo: "alice",
			title: "grant-carries-assignedTo-alice",
		};
		const tools = captureTools({ "tasks:getById": task }, aliceCtx());
		const res = await tools.get("get_task")!.handler({ taskId: "task_a" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("grant-carries-assignedTo-alice");
	});

	it("caller named nowhere on the task (not creator, not assignee) is denied via get_task — identity: alice", async () => {
		const task = {
			_id: "task_b",
			createdBy: "bob",
			assignedTo: "carol",
			title: "grant-carries-assignedTo-carol",
		};
		const tools = captureTools({ "tasks:getById": task }, aliceCtx());
		const res = await tools.get("get_task")!.handler({ taskId: "task_b" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).not.toContain("grant-carries-assignedTo-carol");
	});

	it("list_tasks_by_mission surfaces a task assigned to (not created by) the caller — identity: alice", async () => {
		const tasksFixture = [
			{
				_id: "task_a",
				createdBy: "bob",
				assignedTo: "alice",
				missionId: "mis_x",
				title: "grant-list-assignedTo-alice",
			},
			{
				_id: "task_b",
				createdBy: "bob",
				assignedTo: "carol",
				missionId: "mis_x",
				title: "grant-list-assignedTo-carol",
			},
		];
		const tools = captureTools(
			{ "tasks:listByMission": tasksFixture },
			aliceCtx(),
		);
		const res = await tools
			.get("list_tasks_by_mission")!
			.handler({ missionId: "mis_x" });
		expect(res.content[0].text).toContain("grant-list-assignedTo-alice");
		expect(res.content[0].text).not.toContain("grant-list-assignedTo-carol");
	});

	it("search_tasks_by_keyword surfaces a task assigned to (not created by) the caller — identity: alice", async () => {
		const tasksFixture = [
			{
				_id: "task_a",
				createdBy: "bob",
				assignedTo: "alice",
				title: "grant-search-assignedTo-alice",
				status: "in_progress",
			},
			{
				_id: "task_b",
				createdBy: "bob",
				assignedTo: "carol",
				title: "grant-search-assignedTo-carol",
				status: "in_progress",
			},
		];
		const tools = captureTools(
			{ "tasks:searchTasksByKeyword": tasksFixture },
			aliceCtx(),
		);
		const res = await tools
			.get("search_tasks_by_keyword")!
			.handler({ query: "grant-search" });
		expect(res.content[0].text).toContain("grant-search-assignedTo-alice");
		expect(res.content[0].text).not.toContain("grant-search-assignedTo-carol");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED — master and legacy-bearer paths are unchanged by the grant
// wiring above (regression guard).
// ─────────────────────────────────────────────────────────────────────────────

describe("FAIL-CLOSED — master/legacy bearer paths unchanged by grant wiring", () => {
	it("master scope still sees a mission it is not named on", async () => {
		const mission = {
			_id: "mis_other",
			pilot: "bob",
			agents: ["carol"],
			name: "grant-master-sees-everything",
		};
		const masterCtx: OAuthContext = {
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
		const tools = captureTools({ "missions:get": mission }, masterCtx);
		const res = await tools
			.get("get_mission")!
			.handler({ missionId: "mis_other" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("grant-master-sees-everything");
	});

	it("legacy bearer (no oauthCtx) still sees a task it is not named on", async () => {
		const task = {
			_id: "task_legacy",
			createdBy: "bob",
			assignedTo: "carol",
			title: "grant-legacy-bearer-sees-everything",
		};
		const tools = captureTools({ "tasks:getById": task });
		const res = await tools
			.get("get_task")!
			.handler({ taskId: "task_legacy" });
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain(
			"grant-legacy-bearer-sees-everything",
		);
	});
});
