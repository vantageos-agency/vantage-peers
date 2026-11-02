/**
 * VantagePeers Cloud — task k170ahhzv5dsczsgsh20mr4fah8hfbk4.
 *
 * A client seat's agent (CGT Alsachimie's Mimir) could not pause, resume or
 * delete the schedules it had itself created: pause_recurring_task,
 * resume_recurring_task and delete_recurring_task carried `guardMasterOnly`,
 * so the MCP refused every non-master caller BEFORE the Convex door that
 * decides by agent ID (convex/recurringTasks.ts, authorizeScheduleActor).
 *
 * The tools now decide nothing: they forward the verified agent (verifiedActor,
 * added by withVerifiedActor) and relay the door's answer unchanged. The fake
 * Convex below answers like that door does (creator / assignee by ID, remove
 * creator-only, another org refused); the door itself is pinned against the
 * real schema in convex/__tests__/recurringTaskSeatDoor.test.ts.
 *
 * Identities: scoped seats (isMaster false, one agent ID each), never the
 * master, except for the MASTER pole that pins the bypass unchanged.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const MIMIR = "agentmimir000000000000000000001";
const VERA = "agentvera0000000000000000000001";
const IVO = "agentivo00000000000000000000001";
const OTHER_MIMIR = "agentmimir000000000000000000002";
const ROUTINE = "kh7112ysazdkp2dvet4msv0c1d8gcd0t";
const ORG = "cgt-alsachimie";
const OTHER_ORG = "other-org";

/** The schedule as stored: created by Mimir, assigned to Vera, stamped ORG. */
const ROW = { createdById: MIMIR, assignedToId: VERA, orgId: ORG };

type Call = { name: string; args: Record<string, unknown> };
type Result = { isError?: boolean; content?: Array<{ text?: string }> };
type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function convexError(data: string): Error {
	return Object.assign(new Error("[Request ID: x] Server Error"), { data });
}

/** Answers the three doors the way authorizeScheduleActor does, by agent ID. */
function doorLikeConvex() {
	const calls: Call[] = [];
	const decide = (door: string, args: Record<string, unknown>) => {
		const actor = args.verifiedActor as
			| { agentId: string; orgSlug: string }
			| undefined;
		if (actor === undefined) return; // the fleet master, unchanged
		if (actor.orgSlug !== ROW.orgId) {
			throw convexError(
				`ORG_MISMATCH: verifiedActor names an agent of another organisation — {"door":"${door}"}`,
			);
		}
		const isCreator = actor.agentId === ROW.createdById;
		const isAssignee = actor.agentId === ROW.assignedToId;
		if (!isCreator && !isAssignee) {
			throw convexError(
				`RBAC_DENIED: the acting agent is not creator or assignee of recurring task ${ROUTINE} — {"door":"${door}","reason":"not-creator-or-assignee-by-id"}`,
			);
		}
		if (door === "recurringTasks:remove" && !isCreator) {
			throw convexError(
				`RBAC_DENIED: the acting agent is not the creator of recurring task ${ROUTINE} — {"door":"${door}","reason":"not-creator-by-id"}`,
			);
		}
	};
	return {
		calls,
		client: {
			query: async (name: string, args: Record<string, unknown>) => {
				calls.push({ name, args });
				return null;
			},
			mutation: async (name: string, args: Record<string, unknown>) => {
				calls.push({ name, args });
				decide(name, args);
				return name === "recurringTasks:remove"
					? { deleted: true }
					: { taskId: ROUTINE, active: name === "recurringTasks:resume" };
			},
			action: async () => null,
		},
	};
}

function seat(agentId: string, orgId: string): OAuthContext {
	return {
		clientId: `client-${agentId}`,
		userId: "user-seat",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: `seat-${orgId}`,
		fromAllowList: ["mimir"],
		namespaceReadPrefixes: ["orchestrator/mimir"],
		namespaceWritePrefixes: ["orchestrator/mimir"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		clerkOrgSlug: orgId,
		seatAgent: { agentId, orgId, agentName: "mimir" },
	};
}

const MASTER: OAuthContext = {
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

async function call(tool: string, ctx: OAuthContext | undefined) {
	const { calls, client } = doorLikeConvex();
	const tools = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		tools.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const server = { tool: reg, registerTool: reg } as unknown as McpServer;
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, ctx);
	const handler = tools.get(tool);
	if (!handler) throw new Error(`tool ${tool} not registered`);
	const result = (await handler({ taskId: ROUTINE })) as Result;
	return {
		refused: result.isError === true,
		text: result.content?.[0]?.text ?? "",
		calls,
	};
}

const DOORS = [
	["pause_recurring_task", "recurringTasks:pause"],
	["resume_recurring_task", "recurringTasks:resume"],
	["delete_recurring_task", "recurringTasks:remove"],
] as const;

for (const [tool, door] of DOORS) {
	describe(`${tool} — the Convex door decides, by agent ID`, () => {
		it("CREATOR seat (scoped, never master) is served, its own agent ID forwarded", async () => {
			const r = await call(tool, seat(MIMIR, ORG));
			expect(r.text).not.toMatch(/requires master scope/);
			expect(r.refused, r.text).toBe(false);
			const sent = r.calls.find((c) => c.name === door);
			expect(sent?.args.verifiedActor).toEqual({
				agentId: MIMIR,
				orgSlug: ORG,
			});
		});

		it("a seat of ANOTHER org is refused with the door's own refusal text", async () => {
			const r = await call(tool, seat(OTHER_MIMIR, OTHER_ORG));
			expect(r.refused).toBe(true);
			expect(r.text).toContain("ORG_MISMATCH");
			expect(r.text).not.toMatch(/requires master scope/);
			expect(r.calls.find((c) => c.name === door)?.args.verifiedActor).toEqual(
				{ agentId: OTHER_MIMIR, orgSlug: OTHER_ORG },
			);
		});

		it("a same-org agent that is neither creator nor assignee is refused by the door", async () => {
			const r = await call(tool, seat(IVO, ORG));
			expect(r.refused).toBe(true);
			expect(r.text).toContain("not-creator-or-assignee-by-id");
		});

		it("MASTER is unchanged: served, no agent forwarded", async () => {
			const r = await call(tool, MASTER);
			expect(r.refused, r.text).toBe(false);
			const sent = r.calls.find((c) => c.name === door);
			expect(sent).toBeDefined();
			expect(sent?.args).not.toHaveProperty("verifiedActor");
		});

		it("no authorization context is refused before Convex (absence is never served)", async () => {
			const r = await call(tool, undefined);
			expect(r.refused).toBe(true);
			expect(r.calls.filter((c) => c.name === door)).toEqual([]);
		});
	});
}

describe("the assignee pauses and resumes; removal stays the creator's", () => {
	it("pause / resume served for the assignee, delete refused with the door's not-creator-by-id", async () => {
		expect((await call("pause_recurring_task", seat(VERA, ORG))).refused).toBe(
			false,
		);
		expect(
			(await call("resume_recurring_task", seat(VERA, ORG))).refused,
		).toBe(false);
		const del = await call("delete_recurring_task", seat(VERA, ORG));
		expect(del.refused).toBe(true);
		expect(del.text).toContain("not-creator-by-id");
	});
});
