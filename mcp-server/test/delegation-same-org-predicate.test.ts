/**
 * Delegation-same-org-predicate — RED-then-GREEN, twice over.
 *
 * Operator ruling (2026-08-21, final): any member of an organisation may
 * delegate work to any member of the SAME organisation. The boundary is the
 * organisation, nothing narrower, and membership is READ FROM DATA — never a
 * list hard-coded in code.
 *
 * ROUND 1 DEFECT (pre-fix): `guardFrom(assignedTo)` — the predicate that
 * answers "may this client SPEAK AS `assignedTo`" (is assignedTo in the
 * caller's fromAllowList) — was wrongly applied to the ASSIGNEE at
 * create_task, update_task, create_recurring_task, update_recurring_task. A
 * non-master client whose fromAllowList holds ONE name could therefore only
 * ever assign to itself — cross-station dispatch was impossible.
 *
 * ROUND 1 FIX: `checkDelegationAllowed` (src/auth.ts) answers the DELEGATION
 * question instead — is `assignedTo` a member of the CALLER's own
 * organisation, read from data (client_org_mapping via
 * convex/orgRoster.ts:getMyOrgRoster) — never guardFrom's fromAllowList.
 *
 * ETA-M15 (round 2 — this file): the round-1 fix added an unconditional
 * `roster.includes("*") → allow` branch. `["*"]` is NOT necessarily the
 * caller's org roster — `selectConvexClientForRequest`
 * (authenticatedConvexClient.ts) forwards the caller's OWN Clerk JWT to
 * Convex ONLY on the Clerk-team org-scoped path (auth.ts case 2.5, sets
 * `oauthCtx.clerkJwt`). Every OTHER non-master path (OAuth-scoped access
 * tokens, DCR `client-generic`, legacy mcpTenants `legacy-tenant-generic`)
 * leaves `clerkJwt` unset, so `getMyOrgRoster` runs on the MCP server's own
 * SERVICE-ACCOUNT Convex client — `withOrgScope`'s
 * `CLERK_SERVICE_ACCOUNT_USER_ID` carve-out resolves THAT identity to
 * `allowedOrchestrators = ["*"]`. That is the SERVICE ACCOUNT's roster, not
 * the caller's — treating it as "an open org" turned "refuse everything"
 * into "allow everything, cross-org included" for `client-generic` and
 * `legacy-tenant-generic`, both of which are supposed to be deny-by-default.
 *
 * ROUND 2 FIX: `checkDelegationAllowed` now refuses LOUDLY (named reason,
 * `getOrgRoster` never called) whenever `ctx.clerkJwt` is absent on a
 * non-master caller. Only the clerkJwt-present (clerk-team) path resolves a
 * roster at all, and only THAT roster's own `"*"` means a genuinely open
 * caller org.
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

// ─────────────────────────────────────────────────────────────────────────────
// OAuthContext builders — mirror the ACTUAL shapes auth.ts's
// bearerAuthMiddleware constructs for each of the four paths (grepped from
// mcp-server/src/auth.ts):
//   (1) master bearer            — isMaster:true,  clerkJwt absent
//   (2.5) Clerk-team org-scoped  — isMaster:false, clerkJwt SET (line ~521)
//   (3) DCR client-generic       — isMaster:false, clerkJwt absent, fromAllowList:[]
//   (4) legacy mcpTenants        — isMaster:false, clerkJwt absent, fromAllowList:[]
// ─────────────────────────────────────────────────────────────────────────────

function buildMasterCtx(): OAuthContext {
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

/**
 * Clerk-team org-scoped ctx (auth.ts case 2.5). `clerkJwt` present — this is
 * the ONLY non-master path whose `getMyOrgRoster` call resolves a genuine
 * per-caller org via the caller's own forwarded Clerk JWT.
 */
function buildClerkTeamCtx(
	overrides: Partial<OAuthContext> = {},
): OAuthContext {
	return {
		clientId: "dcr-clerk-org_prometheus",
		userId: "user_prometheus_clerk_sub",
		scopes: ["mcp:full"],
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: ["team/org_prometheus"],
		namespaceWritePrefixes: ["team/org_prometheus"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		clerkJwt: "mock.clerk.jwt",
		...overrides,
	};
}

/** DCR self-registered client — client-generic, deny-by-default, no clerkJwt. */
function buildDcrClientGenericCtx(): OAuthContext {
	return {
		clientId: "dcr:some-client-id",
		userId: "dcr:some-client-id",
		scopes: ["mcp:full"],
		scopeProfile: "client-generic",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

/** Legacy mcpTenants bearer — legacy-tenant-generic, deny-by-default, no clerkJwt. */
function buildLegacyTenantGenericCtx(): OAuthContext {
	return {
		clientId: "legacy:some-tenant",
		userId: "legacy:some-tenant",
		scopes: [],
		scopeProfile: "legacy-tenant-generic",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

/**
 * OAuth-scoped access token ctx (auth.ts case 2) — the shape Pi/prometheus-
 * style peer stations actually use. `fromAllowList` holds ONE name; no
 * clerkJwt. Included so createdBy identity-claim tests have a realistic
 * fromAllowList to check against.
 */
function buildPrometheusOauthScopedCtx(
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

// The CALLER's own org roster, as would be resolved from client_org_mapping
// via convex/orgRoster.ts:getMyOrgRoster when a real Clerk JWT is forwarded.
const PROMETHEUS_ORG_ROSTER = ["prometheus", "sigma-peer"];

let createdTaskRow: Record<string, unknown> | null = null;
let orgRosterQueryCalled = false;
let tokenRosterQueryCalled = false;
let tokenRosterArgs: unknown = undefined;

/** OAuth seat that belongs to an org — clerkJwt ABSENT, accessTokenHash SET. */
function buildOrchAOauthCtx(
	overrides: Partial<OAuthContext> = {},
): OAuthContext {
	return {
		clientId: "client-orch-a",
		userId: "orch-a",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "orch-a-plan-org-alpha",
		fromAllowList: ["orch-a"],
		namespaceReadPrefixes: ["orchestrator/orch-a"],
		namespaceWritePrefixes: ["orchestrator/orch-a"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		accessTokenHash: "hash-of-orch-a-token",
		clerkOrgSlug: "plan-org-alpha",
		...overrides,
	};
}

function buildMockConvex(
	roster: string[] = PROMETHEUS_ORG_ROSTER,
): Parameters<typeof registerTools>[1] {
	return {
		query: async (name: unknown, args: unknown) => {
			if (name === "orgRoster:getMyOrgRoster") {
				orgRosterQueryCalled = true;
				return roster;
			}
			if (name === "orgRoster:getForAccessToken") {
				tokenRosterQueryCalled = true;
				tokenRosterArgs = args;
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
			if (name === "tasks:update") {
				return { taskId: "mock-updated-task-id" };
			}
			if (name === "recurringTasks:update") {
				return { taskId: "mock-updated-recurring-id" };
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
	it("master → allow (bypass, no roster query)", async () => {
		createdTaskRow = null;
		orgRosterQueryCalled = false;
		const result = await callTool(
			"create_task",
			{
				title: "Master dispatch",
				createdBy: "anyone",
				assignedTo: "anyone-else-entirely",
			},
			buildMasterCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(createdTaskRow?.assignedTo).toBe("anyone-else-entirely");
		expect(orgRosterQueryCalled).toBe(false);
	});

	it("clerk-team (clerkJwt present), same-org roster → ALLOW, read the created row back", async () => {
		createdTaskRow = null;
		orgRosterQueryCalled = false;
		const result = await callTool(
			"create_task",
			{
				title: "Cross-station dispatch, same org",
				createdBy: "prometheus", // identity claim — no fromAllowList on this ctx, so createdBy check is a no-op (empty list = legacy fallback allowed by guardFrom's ctx? see next test)
				assignedTo: "sigma-peer", // IS in the caller's own (clerk-resolved) org roster
			},
			buildClerkTeamCtx({ fromAllowList: ["prometheus"] }),
			PROMETHEUS_ORG_ROSTER,
		);

		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
		expect(orgRosterQueryCalled).toBe(true);

		// Read back the created row to prove the write actually landed.
		expect(createdTaskRow).not.toBeNull();
		expect(createdTaskRow?.assignedTo).toBe("sigma-peer");
	});

	it("clerk-team, cross-org (assignedTo not in caller roster) → REFUSE", async () => {
		createdTaskRow = null;
		orgRosterQueryCalled = false;
		const result = await callTool(
			"create_task",
			{
				title: "Should be refused — cross org",
				createdBy: "prometheus",
				assignedTo: "outsider", // not in the caller's own org roster
			},
			buildClerkTeamCtx({ fromAllowList: ["prometheus"] }),
			PROMETHEUS_ORG_ROSTER,
		);

		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(createdTaskRow).toBeNull();
		expect(orgRosterQueryCalled).toBe(true);
	});

	it('clerk-team, caller org roster ["*"] → ALLOW (genuinely open caller org)', async () => {
		createdTaskRow = null;
		orgRosterQueryCalled = false;
		const result = await callTool(
			"create_task",
			{
				title: "Open caller org dispatch",
				createdBy: "prometheus",
				assignedTo: "any-other-orchestrator-at-all",
			},
			buildClerkTeamCtx({ fromAllowList: ["prometheus"] }),
			["*"], // THIS caller's own client_org_mapping row is itself wildcard
		);

		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
		expect(createdTaskRow?.assignedTo).toBe("any-other-orchestrator-at-all");
		expect(orgRosterQueryCalled).toBe(true);
	});

	// Uses update_recurring_task, which registers with `{ kind: "filtered" }`
	// (no wrapper-level pre-check — enforcement is entirely in-handler via
	// guardDelegation on assignedTo only, no callerOrchestrator/createdBy arg
	// exists on this tool at all). create_task/update_task both apply a
	// mandatory-or-wrapper-level guardFrom on a creator/caller arg first,
	// which would short-circuit before guardDelegation ever runs for
	// client-generic/legacy-tenant-generic (fromAllowList:[] always denies),
	// masking the exact leak this test exists to catch.
	it("ETA-M15: DCR client-generic (clerkJwt absent, isMaster false) → REFUSE LOUDLY, never allow — this is the exact leak", async () => {
		orgRosterQueryCalled = false;
		const result = await callTool(
			"update_recurring_task",
			{
				recurringTaskId: "mock-recurring-task-id",
				assignedTo: "any-other-orchestrator-at-all",
			},
			buildDcrClientGenericCtx(),
			// The realistic shape: IF getMyOrgRoster were consulted for this
			// clerkJwt-absent caller, withOrgScope's service-account carve-out
			// would resolve it to ["*"] — the exact value that must NOT be
			// treated as "an open caller org" here.
			["*"],
		);

		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		// Named refusal — not a generic "not a member" roster message, this is
		// the "cannot resolve caller's own org" branch.
		expect(getText(result)).toMatch(
			/cannot be resolved|no verified Clerk session/i,
		);
		// The service-account roster must NEVER be consulted for this path —
		// consulting it and finding "*" is exactly ETA-M15.
		expect(orgRosterQueryCalled).toBe(false);
	});

	it("legacy-tenant-generic (clerkJwt absent, isMaster false) → REFUSE LOUDLY", async () => {
		orgRosterQueryCalled = false;
		const result = await callTool(
			"update_recurring_task",
			{
				recurringTaskId: "mock-recurring-task-id",
				assignedTo: "any-other-orchestrator-at-all",
			},
			buildLegacyTenantGenericCtx(),
			["*"],
		);

		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(
			/cannot be resolved|no verified Clerk session/i,
		);
		expect(orgRosterQueryCalled).toBe(false);
	});

	it("OAuth orch-a (no clerkJwt, token hash set), same-org assignedTo=orch-b → ALLOW, row read back — RED until resolver", async () => {
		createdTaskRow = null;
		orgRosterQueryCalled = false;
		tokenRosterQueryCalled = false;
		tokenRosterArgs = undefined;
		const result = await callTool(
			"create_task",
			{
				title: "plan-acceptance-delegate",
				createdBy: "orch-a",
				assignedTo: "orch-b",
			},
			buildOrchAOauthCtx(),
			["orch-a", "orch-b"],
		);

		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
		expect(createdTaskRow).not.toBeNull();
		expect(createdTaskRow?.assignedTo).toBe("orch-b");
		expect(orgRosterQueryCalled).toBe(false);
		expect(tokenRosterQueryCalled).toBe(true);
		expect(tokenRosterArgs).toEqual({ tokenHash: "hash-of-orch-a-token" });
		expect(tokenRosterArgs).not.toHaveProperty("clerkOrgSlug");
		expect(tokenRosterArgs).not.toHaveProperty("orgId");
	});

	it("OAuth orch-a, assignedTo=outsider → REFUSE membership, not speak-as, not #1215 floor", async () => {
		createdTaskRow = null;
		orgRosterQueryCalled = false;
		tokenRosterQueryCalled = false;
		const result = await callTool(
			"create_task",
			{
				title: "cross-org should fail",
				createdBy: "orch-a",
				assignedTo: "outsider",
			},
			buildOrchAOauthCtx(),
			["orch-a", "orch-b"],
		);

		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/not a member of the caller's organisation/i);
		expect(getText(result)).not.toMatch(/from='outsider' is not in this client's allowlist/i);
		expect(createdTaskRow).toBeNull();
		expect(orgRosterQueryCalled).toBe(false);
		expect(tokenRosterQueryCalled).toBe(true);
	});

	it("ETA-M15 wildcard: DCR + mocked service-account roster ['*'] still REFUSE, getMyOrgRoster never called, getForAccessToken never called", async () => {
		orgRosterQueryCalled = false;
		tokenRosterQueryCalled = false;
		const result = await callTool(
			"update_recurring_task",
			{
				recurringTaskId: "mock-recurring-task-id",
				assignedTo: "any-other-orchestrator-at-all",
			},
			buildDcrClientGenericCtx(),
			["*"],
		);
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(
			/cannot be resolved|no verified Clerk session/i,
		);
		expect(orgRosterQueryCalled).toBe(false);
		expect(tokenRosterQueryCalled).toBe(false);
	});

	it("createdBy (identity claim) still refuses a foreign identity — unchanged by this fix", async () => {
		createdTaskRow = null;
		const result = await callTool(
			"create_task",
			{
				title: "Foreign createdBy",
				createdBy: "not-prometheus", // NOT in fromAllowList
				assignedTo: "sigma-peer",
			},
			buildPrometheusOauthScopedCtx(),
		);

		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(createdTaskRow).toBeNull();
	});
});
