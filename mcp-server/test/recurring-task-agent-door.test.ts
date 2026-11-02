/**
 * pause / resume / delete_recurring_task: the MCP relays, the backend decides.
 * VantagePeers Cloud (multi-tenant). Task k170ahhzv5dsczsgsh20mr4fah8hfbk4.
 *
 * Client agent Mimir (CGT Alsachimie) could not pause or delete the schedules it
 * created: the three tools were gated `guardMasterOnly` in the MCP although
 * convex/recurringTasks.ts `authorizeScheduleActor` already admits the creator or
 * assignee BY AGENT ID (delete: the creator) from the forwarded `verifiedActor`.
 * One identity layer: the MCP forwards the verified agent and relays the
 * backend's answer unchanged; it decides nothing.
 *
 * Poles, each through the real tool with a seat that carries its agent:
 *   CREATOR       the creating agent: the door is CALLED with the forwarded
 *                 verifiedActor and its result reaches the caller.
 *   OTHER ORG     an agent of another org: the door's RBAC_DENIED reaches the
 *                 caller verbatim (code and message), not an MCP reinterpretation.
 *   NOT OWNER     a same-org agent that is neither creator nor assignee: the door's
 *                 refusal reaches the caller verbatim.
 *   MASTER        a master bearer with no agent forwards nothing and succeeds.
 */

import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const MIMIR_ID = "r576tx9h4h81ap9gv846cmcan58frk3y";
const PEER_ID = "r576tx9h4h81ap9gv846cmcan58peer1";
const OTHER_ORG_ID = "r576tx9h4h81ap9gv846cmcan58other";
const TASK_ID = "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type Call = { name: string; args: Record<string, unknown> };
type Result = { isError?: boolean; content?: Array<{ text?: string }> };

const seat = (agentId: string, orgId: string, name: string): OAuthContext => ({
	clientId: `client-${name}-${orgId}`,
	userId: "user-x",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: `${name}-${orgId}`,
	fromAllowList: [name],
	namespaceReadPrefixes: [`orchestrator/${name}`],
	namespaceWritePrefixes: [`orchestrator/${name}`],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: orgId,
	seatAgent: { agentId, orgId, agentName: name },
});

const master: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: true,
};

async function call(
	tool: string,
	ctx: OAuthContext,
	refuseWith?: string,
): Promise<{ result: Result; calls: Call[] }> {
	const calls: Call[] = [];
	const tools = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		tools.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const client = {
		query: vi.fn(async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			return null;
		}),
		mutation: vi.fn(async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			// The door refuses with the code it really raises, as a ConvexError.
			if (refuseWith !== undefined) throw new ConvexError(refuseWith);
			return { ok: true };
		}),
		action: vi.fn(async () => null),
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fakes
	registerTools({ tool: reg, registerTool: reg } as any, client as any, ctx);
	const handler = tools.get(tool);
	if (!handler) throw new Error(`tool ${tool} not registered`);
	return { result: (await handler({ taskId: TASK_ID })) as Result, calls };
}

const TOOLS = [
	["pause_recurring_task", "recurringTasks:pause"],
	["resume_recurring_task", "recurringTasks:resume"],
	["delete_recurring_task", "recurringTasks:remove"],
] as const;

for (const [tool, door] of TOOLS) {
	describe(`${tool}: the MCP relays, the backend decides`, () => {
		it("CREATOR: the seat's agent reaches the door with its verified actor", async () => {
			const { result, calls } = await call(
				tool,
				seat(MIMIR_ID, "cgt-alsachimie", "mimir"),
			);
			const mutation = calls.find((c) => c.name === door);
			expect(mutation, JSON.stringify(result)).toBeDefined();
			expect(mutation?.args.verifiedActor).toEqual({
				agentId: MIMIR_ID,
				orgSlug: "cgt-alsachimie",
			});
			expect(result.isError).not.toBe(true);
		});

		it("OTHER ORG: the door's refusal reaches the caller unchanged", async () => {
			const msg = `RBAC_DENIED: caller may not act on recurring task ${TASK_ID} — the schedule does not belong to the caller's organisation — {"door":"${door}"}`;
			const { result, calls } = await call(
				tool,
				seat(OTHER_ORG_ID, "other-org", "mimir"),
				msg,
			);
			expect(calls.some((c) => c.name === door)).toBe(true);
			expect(result.isError).toBe(true);
			expect(result.content?.[0]?.text).toContain("RBAC_DENIED");
			expect(result.content?.[0]?.text).toContain(
				"the schedule does not belong to the caller's organisation",
			);
		});

		it("NOT OWNER: a same-org agent that is neither creator nor assignee gets the door's refusal", async () => {
			const msg = `RBAC_DENIED: the acting agent is not creator or assignee of recurring task ${TASK_ID} — {"reason":"not-creator-or-assignee-by-id"}`;
			const { result, calls } = await call(
				tool,
				seat(PEER_ID, "cgt-alsachimie", "peer"),
				msg,
			);
			const mutation = calls.find((c) => c.name === door);
			expect(mutation?.args.verifiedActor).toEqual({
				agentId: PEER_ID,
				orgSlug: "cgt-alsachimie",
			});
			expect(result.isError).toBe(true);
			expect(result.content?.[0]?.text).toContain(
				"not-creator-or-assignee-by-id",
			);
		});

		it("MASTER: unchanged, no actor forwarded, the call succeeds", async () => {
			const { result, calls } = await call(tool, master);
			const mutation = calls.find((c) => c.name === door);
			expect(mutation).toBeDefined();
			expect(mutation?.args).not.toHaveProperty("verifiedActor");
			expect(result.isError).not.toBe(true);
		});
	});
}
