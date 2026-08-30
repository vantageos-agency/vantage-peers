/**
 * VantagePeers Cloud — guard the two row-acting `filtered` doors
 * (task k17fcxngeyrfpsh8xrp0fzz9xh8dfkq8, follow-up to #1242).
 *
 * Bipolar (ALLOW + DENY), RED-before / GREEN-after, one door per describe:
 *
 *   list_tasks             — a restricted caller sees its OWN-scope task rows
 *                            (ALLOW) and NOT another scope's rows (DENY). The
 *                            fix applies scopeFilterList(oauthCtx, ...) after
 *                            the Convex read; before the fix all rows leaked.
 *   update_recurring_task  — a caller may update its OWN-scope recurring task
 *                            (ALLOW) and is DENIED a cross-scope one via a
 *                            scopeFilterGet gate on the fetched target row.
 *
 * AUTH_NAMESPACE_DENIED / cross-tenant deny coverage for this auth-touching
 * change (enforce-rag-namespace-deny-test hook): the DENY cases below assert a
 * non-master caller is refused another scope's row/mutation.
 *
 * Harness mirrors test/scope-aware-filter-wave-c1.test.ts: a duck-typed
 * McpServer mock captures the registered handler, invoked directly against a
 * fixture-returning mocked Convex client.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

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

type CapturedTool = { name: string; handler: (args: any) => any };

function captureTools(
	queryReturns: Record<string, unknown>,
	oauthCtx: OAuthContext = masterCtx(),
	mutationReturns: Record<string, unknown> = {},
): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const mockServer = {
		tool: (
			name: string,
			_d: string,
			_s: Record<string, unknown>,
			_a: Record<string, unknown>,
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
		query: async (path: string, _args: any) =>
			path in queryReturns ? queryReturns[path] : null,
		mutation: async (path: string, _args: any) =>
			path in mutationReturns ? mutationReturns[path] : "rt_updated",
		action: async () => null,
	} as any;
	registerTools(mockServer, mockConvex, oauthCtx);
	return tools;
}

function isForbidden(res: any): boolean {
	if (!res || res.isError !== true) return false;
	const text = res.content?.[0]?.text ?? "";
	return typeof text === "string" && text.includes("Forbidden");
}

// ── list_tasks ───────────────────────────────────────────────────────────────
// tasks:list returns full docs (the handler forces fields="full" internally).

const TASKS_FULL = [
	{
		_id: "task_alpha",
		_creationTime: 100,
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		title: "alpha task",
		status: "todo",
		priority: "medium",
		assignedTo: "alpha",
	},
	{
		_id: "task_beta",
		_creationTime: 200,
		createdBy: "beta",
		namespace: "orchestrator/beta",
		title: "beta task",
		status: "todo",
		priority: "high",
		assignedTo: "beta",
	},
];

describe("LT — list_tasks row scoping (filtered door)", () => {
	it("LT-T1 master → both rows visible", async () => {
		const tools = captureTools({ "tasks:list": TASKS_FULL }, masterCtx());
		const res = await tools.get("list_tasks")!.handler({});
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("task_alpha");
		expect(res.content[0].text).toContain("task_beta");
	});

	it("LT-ALLOW alpha caller → own-scope alpha task visible", async () => {
		const tools = captureTools({ "tasks:list": TASKS_FULL }, alphaCtx());
		const res = await tools.get("list_tasks")!.handler({});
		expect(isForbidden(res)).toBe(false);
		expect(res.content[0].text).toContain("task_alpha");
	});

	it("LT-DENY alpha caller → cross-scope beta task NOT leaked", async () => {
		// RED before the fix: list_tasks returned every row → 'task_beta' leaked.
		// GREEN after: scopeFilterList removes the out-of-scope row.
		const tools = captureTools({ "tasks:list": TASKS_FULL }, alphaCtx());
		const res = await tools.get("list_tasks")!.handler({});
		expect(res.content[0].text).not.toContain("task_beta");
	});
});

// ── update_recurring_task ─────────────────────────────────────────────────────
// recurringTasks:getById returns the target row; a cross-scope row is refused.

const ALPHA_RECURRING = {
	_id: "rt_alpha",
	createdBy: "alpha",
	namespace: "orchestrator/alpha",
	assignedTo: "alpha",
	title: "alpha recurring",
};

const BETA_RECURRING = {
	_id: "rt_beta",
	createdBy: "beta",
	namespace: "orchestrator/beta",
	assignedTo: "beta",
	title: "beta recurring",
};

describe("URT — update_recurring_task cross-scope mutation guard", () => {
	it("URT-T1 master → own/any row update allowed", async () => {
		const tools = captureTools(
			{ "recurringTasks:getById": BETA_RECURRING },
			masterCtx(),
		);
		const res = await tools.get("update_recurring_task")!.handler({
			recurringTaskId: "rt_beta",
			priority: "high",
		});
		expect(isForbidden(res)).toBe(false);
	});

	it("URT-ALLOW alpha caller → own-scope recurring task update allowed", async () => {
		const tools = captureTools(
			{ "recurringTasks:getById": ALPHA_RECURRING },
			alphaCtx(),
		);
		const res = await tools.get("update_recurring_task")!.handler({
			recurringTaskId: "rt_alpha",
			priority: "high",
		});
		expect(isForbidden(res)).toBe(false);
		expect(res.content[0].text).toContain("updated");
	});

	it("URT-DENY alpha caller → cross-scope recurring task update refused", async () => {
		// RED before the fix: no scopeFilterGet gate → the mutation ran on
		// beta's template. GREEN after: cross-scope row collapses to null → deny.
		const tools = captureTools(
			{ "recurringTasks:getById": BETA_RECURRING },
			alphaCtx(),
		);
		const res = await tools.get("update_recurring_task")!.handler({
			recurringTaskId: "rt_beta",
			priority: "high",
		});
		expect(isForbidden(res)).toBe(true);
	});
});
