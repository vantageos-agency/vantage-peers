/**
 * Delegation-same-org-predicate — RED-then-GREEN.
 *
 * Operator ruling (2026-08-21, final): any member of an organisation may
 * delegate work to any member of the SAME organisation. The boundary is the
 * organisation, nothing narrower, and membership is READ FROM DATA — never a
 * list hard-coded in code.
 *
 * THE DEFECT (pre-fix): `guardFrom(assignedTo)` — the predicate that answers
 * "may this client SPEAK AS `assignedTo`" (is assignedTo in the caller's
 * fromAllowList) — was wrongly applied to the ASSIGNEE at create_task,
 * update_task, create_recurring_task, update_recurring_task. A non-master
 * client whose fromAllowList holds ONE name could therefore only ever assign
 * to itself — cross-station dispatch was impossible.
 *
 * THE FIX: `checkDelegationAllowed` (src/auth.ts) answers the DELEGATION
 * question instead — is `assignedTo` a member of the CALLER's own
 * organisation, read from data (client_org_mapping via
 * convex/orgRoster.ts:getMyOrgRoster) — never guardFrom's fromAllowList.
 *
 * Litmus: if `checkDelegationAllowed` were deleted (i.e. create_task fell
 * back to guardFrom(assignedTo)), the ALLOW test below would FAIL, because
 * "sigma-peer" is not in the caller's fromAllowList (["prometheus"]). This
 * proves the allow-direction test genuinely exercises the new predicate — a
 * system that refuses everyone would not pass it.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type CapturedTool = {
	name: string;
	handler: (args: Record<string, unknown>) => Promise<unknown>;
};

type ToolResult = {
	content?: Array<{ text?: string }>;
	isError?: boolean;
};

function getText(result: ToolResult): string {
	return result.content?.[0]?.text ?? "";
}

/**
 * Non-master, org-scoped OAuthContext. `fromAllowList` holds exactly ONE
 * name ("prometheus") — the identity-claim allowlist. It deliberately does
 * NOT contain "sigma-peer", so an ALLOW on assignedTo="sigma-peer" can only
 * come from the delegation/org-roster path, never from guardFrom.
 */
function buildPrometheusCtx(
	overrides: Partial<OAuthContext> = {},
): OAuthContext {
	return {
		clientId: "prometheus-client",
		userId: "prometheus-user",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "prometheus-org",
		fromAllowList: ["prometheus"],
		namespaceReadPrefixes: ["orchestrator/prometheus"],
		namespaceWritePrefixes: ["orchestrator/prometheus"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		...overrides,
	};
}

// The caller's org roster, as would be resolved from client_org_mapping via
// convex/orgRoster.ts:getMyOrgRoster. "prometheus" and "sigma-peer" share an
// org; "outsider" does not appear in it at all.
const PROMETHEUS_ORG_ROSTER = ["prometheus", "sigma-peer"];

let createdTaskRow: Record<string, unknown> | null = null;

function buildMockConvex(
	roster: string[] = PROMETHEUS_ORG_ROSTER,
): Parameters<typeof registerTools>[1] {
	return {
		query: async (name: unknown, args: unknown) => {
			if (name === "orgRoster:getMyOrgRoster") {
				return roster;
			}
			if (name === "tasks:getById") {
				// Read-back: prove the write actually landed, not just that no
				// error was thrown.
				const { taskId } = args as { taskId: string };
				if (createdTaskRow && createdTaskRow.taskId === taskId) {
					return createdTaskRow;
				}
				return null;
			}
			return null;
		},
		mutation: async (name: unknown, args: unknown) => {
			if (name === "tasks:create") {
				const taskId = "mock-created-task-id";
				createdTaskRow = { taskId, ...(args as Record<string, unknown>) };
				return taskId;
			}
			return { taskId: "mock-id" };
		},
		action: async () => null,
	} as Parameters<typeof registerTools>[1];
}

function captureTools(
	oauthCtx?: OAuthContext,
	roster: string[] = PROMETHEUS_ORG_ROSTER,
): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const mockServer = {
		tool: (
			name: string,
			_description: string,
			_schema: Record<string, unknown>,
			_annotations: Record<string, unknown>,
			handler: (args: Record<string, unknown>) => Promise<unknown>,
		) => {
			tools.set(name, { name, handler });
		},
		registerTool: (
			name: string,
			_config: { description?: string },
			handler: (args: Record<string, unknown>) => Promise<unknown>,
		) => {
			tools.set(name, { name, handler });
		},
	} as Parameters<typeof registerTools>[0];

	registerTools(mockServer, buildMockConvex(roster), oauthCtx);
	return tools;
}

async function callTool(
	toolName: string,
	args: Record<string, unknown>,
	oauthCtx?: OAuthContext,
	roster: string[] = PROMETHEUS_ORG_ROSTER,
): Promise<ToolResult> {
	const tools = captureTools(oauthCtx, roster);
	const tool = tools.get(toolName);
	if (!tool) throw new Error(`Tool '${toolName}' not registered`);
	return (await tool.handler(args)) as ToolResult;
}

describe("delegation-same-org-predicate — create_task assignee", () => {
	it("ALLOW: caller may delegate to a DIFFERENT identity in the SAME org roster, and the write lands (read-back proves it)", async () => {
		createdTaskRow = null;
		const result = await callTool(
			"create_task",
			{
				title: "Cross-station dispatch",
				createdBy: "prometheus", // in fromAllowList — identity claim OK
				assignedTo: "sigma-peer", // NOT in fromAllowList, IS in org roster
			},
			buildPrometheusCtx(),
		);

		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);

		// Read back the created row to prove the write actually landed.
		expect(createdTaskRow).not.toBeNull();
		expect(createdTaskRow?.assignedTo).toBe("sigma-peer");
	});

	it("REFUSE: caller CANNOT assign to an identity OUTSIDE its org roster", async () => {
		createdTaskRow = null;
		const result = await callTool(
			"create_task",
			{
				title: "Should be refused",
				createdBy: "prometheus",
				assignedTo: "outsider", // not in fromAllowList, not in org roster
			},
			buildPrometheusCtx(),
		);

		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(createdTaskRow).toBeNull();
	});

	it("createdBy (identity claim) still refuses a foreign identity — untouched by this fix", async () => {
		createdTaskRow = null;
		const result = await callTool(
			"create_task",
			{
				title: "Foreign createdBy",
				createdBy: "not-prometheus", // NOT in fromAllowList
				assignedTo: "sigma-peer", // would be allowed by org roster, irrelevant here
			},
			buildPrometheusCtx(),
		);

		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(createdTaskRow).toBeNull();
	});

	it("master scope bypasses the delegation check entirely (no roster query needed)", async () => {
		createdTaskRow = null;
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
		const result = await callTool(
			"create_task",
			{
				title: "Master dispatch",
				createdBy: "anyone",
				assignedTo: "anyone-else-entirely",
			},
			masterCtx,
		);
		expect(result.isError).toBeFalsy();
		expect(createdTaskRow?.assignedTo).toBe("anyone-else-entirely");
	});

	it('WILDCARD ROSTER: non-master caller whose getOrgRoster resolves ["*"] (the clerkJwt-absent service-account-resolved case — see selectConvexClientForRequest) CAN assign to any identity, not just a name literally equal to "*"', async () => {
		createdTaskRow = null;
		const result = await callTool(
			"create_task",
			{
				title: "Service-account-resolved dispatch",
				createdBy: "prometheus", // still an identity CLAIM — must stay in fromAllowList
				assignedTo: "any-other-orchestrator-at-all", // NOT a literal "*", NOT in fromAllowList
			},
			buildPrometheusCtx(),
			["*"], // roster resolved via CLERK_SERVICE_ACCOUNT_USER_ID carve-out
		);

		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
		expect(createdTaskRow?.assignedTo).toBe("any-other-orchestrator-at-all");
	});

	it("WILDCARD ROSTER does not bypass the identity-claim check on createdBy — only the delegation check", async () => {
		createdTaskRow = null;
		const result = await callTool(
			"create_task",
			{
				title: "Wildcard roster, foreign createdBy",
				createdBy: "not-prometheus", // NOT in fromAllowList
				assignedTo: "any-other-orchestrator-at-all",
			},
			buildPrometheusCtx(),
			["*"],
		);

		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(createdTaskRow).toBeNull();
	});
});
