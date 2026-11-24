/// <reference types="vite/client" />
/**
 * Task k1789re9sxkhd8t0jbk7c994q58jvc8k (VantagePeers Cloud + Self-host backend).
 *
 * `toolUsage:getToolUsage` and `toolUsage:usageByOwner` admit the fleet service
 * account by `verifiedActor` exactly as the task doors do (`requireClaimedCaller`,
 * convex/lib/taskDoorClaim.ts): the acting agent is judged BY ID as an agent of
 * the operator organisation. A master-scope MCP bearer resolves no organisation,
 * so before this change an operator seat reading its own tool usage was refused.
 *
 * Poles:
 *   OPERATOR    the service account + the verifiedActor of an ACTIVE operator-org
 *               agent                                   -> served, both doors;
 *   CLIENT      the service account + the verifiedActor of a CLIENT-org agent
 *                                                       -> RBAC_DENIED, both doors;
 *   CLAIMLESS   the service account with no claim at all
 *                                                       -> RBAC_DENIED
 *               `claimless-service-account`;
 *   NO WIDENING an admitted operator agent reads the operator organisation only
 *               (never a client organisation's rows) unless it also carries a
 *               verifiedOrg, exactly as the task doors narrow a verifiedActor;
 *   UNCHANGED   verifiedOrg alone, a Clerk session and an inactive operator agent
 *               behave as before.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { findAgentId } from "../../tests/lib/agentIdOf";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("search") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const CLIENT = "usage-client-org";
const CLIENT_ID = testClerkOrgId(CLIENT);
const OWNER = "owner-sub-1";

type Row = { tool: string; firstAt: number; lastAt: number; count: number };

async function fixture() {
	const t = createT();
	const fleet = await seedFleetAgents(t, ["sigma", "eta"]);
	const operatorSlug = await t.run(async (ctx) => {
		const m = (await ctx.db.query("client_org_mapping").collect()).find(
			(r) => r.orgKind === "operator",
		);
		return m?.clerkOrgSlug as string;
	});
	const operatorId = testClerkOrgId(operatorSlug);
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: CLIENT,
			clerkOrgId: CLIENT_ID,
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			displayName: CLIENT,
			isActive: true,
			createdAt: 1,
			orgKind: "client",
		});
		await ctx.db.insert("agents", {
			orgSlug: CLIENT,
			clerkOrgId: CLIENT_ID,
			name: "mimir",
			normalizedName: "mimir",
			isActive: true,
			createdAt: 1,
		});
		// A personal agent of OWNER in the operator org (usageByOwner membership).
		await ctx.db.insert("agents", {
			orgSlug: operatorSlug,
			clerkOrgId: operatorId,
			name: "owner-seat",
			normalizedName: "owner-seat",
			isActive: true,
			createdAt: 1,
			personalAgentOf: OWNER,
		});
		const usage = (org: string, id: string, key: string, tool: string, n: number) =>
			ctx.db.insert("tool_usage", {
				orgSlug: org,
				clerkOrgId: id,
				callerKey: key,
				tool,
				firstAt: 10,
				lastAt: 20,
				count: n,
			});
		await usage(operatorSlug, operatorId, `agent:${fleet.sigma}`, "op_tool", 3);
		await usage(operatorSlug, operatorId, `user:${OWNER}`, "owner_tool", 2);
		await usage(CLIENT, CLIENT_ID, "user:client-user", "client_tool", 7);
	});
	const clientAgent = (await findAgentId(t, CLIENT, "mimir")) as Id<"agents">;
	const svc = t.withIdentity({ subject: "test-service-account-user-id" });
	return { t, svc, fleet, clientAgent, operatorSlug, operatorId };
}

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		const m = /([A-Z][A-Z_]{3,}):/.exec(text);
		const reason = /"reason":"([^"]+)"/.exec(text);
		return m
			? `${m[1]}${reason ? `/${reason[1]}` : ""}`
			: `OTHER(${text.slice(0, 120)})`;
	}
}

describe("toolUsage doors admit verifiedActor of an operator-org agent", () => {
	test("OPERATOR: getToolUsage serves the operator organisation's rows", async () => {
		const { svc, fleet, operatorSlug } = await fixture();
		const got = (await svc.query(api.toolUsage.getToolUsage, {
			caller: `agent:${fleet.sigma}`,
			verifiedActor: { agentId: fleet.sigma, orgSlug: operatorSlug },
		})) as Row[];
		expect(got).toEqual([{ tool: "op_tool", firstAt: 10, lastAt: 20, count: 3 }]);
	});

	test("OPERATOR: usageByOwner serves the operator organisation's owner rows", async () => {
		const { svc, fleet, operatorSlug } = await fixture();
		const got = (await svc.query(api.toolUsage.usageByOwner, {
			ownerUserId: OWNER,
			verifiedActor: { agentId: fleet.sigma, orgSlug: operatorSlug },
		})) as Row[];
		expect(got).toEqual([{ tool: "owner_tool", firstAt: 10, lastAt: 20, count: 2 }]);
	});

	test("CLIENT: a client-org agent's verifiedActor is RBAC_DENIED at both doors", async () => {
		const { svc, clientAgent } = await fixture();
		const actor = { agentId: clientAgent, orgSlug: CLIENT };
		expect(
			await code(
				svc.query(api.toolUsage.getToolUsage, {
					caller: "user:client-user",
					verifiedActor: actor,
				}),
			),
		).toMatch(/^RBAC_DENIED/);
		expect(
			await code(
				svc.query(api.toolUsage.usageByOwner, {
					ownerUserId: "client-user",
					verifiedActor: actor,
				}),
			),
		).toMatch(/^RBAC_DENIED/);
	});

	test("INACTIVE: an inactive operator agent is not admitted", async () => {
		const { t, svc, fleet, operatorSlug } = await fixture();
		await t.run((ctx) => ctx.db.patch(fleet.eta, { isActive: false }));
		expect(
			await code(
				svc.query(api.toolUsage.getToolUsage, {
					caller: `agent:${fleet.eta}`,
					verifiedActor: { agentId: fleet.eta, orgSlug: operatorSlug },
				}),
			),
		).toMatch(/^RBAC_DENIED/);
	});

	test("CLAIMLESS: the service account with no claim is still refused claimless-service-account", async () => {
		const { svc } = await fixture();
		expect(
			await code(svc.query(api.toolUsage.getToolUsage, { caller: "user:x" })),
		).toBe("RBAC_DENIED/claimless-service-account");
		expect(
			await code(svc.query(api.toolUsage.usageByOwner, { ownerUserId: OWNER })),
		).toBe("RBAC_DENIED/claimless-service-account");
	});

	test("NO WIDENING: an operator agent never reads a client organisation's rows without a verifiedOrg", async () => {
		const { svc, fleet, operatorSlug } = await fixture();
		const actor = { agentId: fleet.sigma, orgSlug: operatorSlug };
		// The client's caller key, read under the operator organisation: no rows.
		expect(
			await svc.query(api.toolUsage.getToolUsage, {
				caller: "user:client-user",
				verifiedActor: actor,
			}),
		).toEqual([]);
	});

	test("verifiedActor + verifiedOrg: narrowed to that organisation, as the task doors do", async () => {
		const { svc, fleet, operatorSlug } = await fixture();
		const got = (await svc.query(api.toolUsage.getToolUsage, {
			caller: "user:client-user",
			verifiedActor: { agentId: fleet.sigma, orgSlug: operatorSlug },
			verifiedOrg: { orgSlug: CLIENT, orgId: CLIENT_ID },
		})) as Row[];
		expect(got).toEqual([{ tool: "client_tool", firstAt: 10, lastAt: 20, count: 7 }]);
	});

	test("UNCHANGED: verifiedOrg alone (no actor) is still served for that organisation", async () => {
		const { svc } = await fixture();
		const got = (await svc.query(api.toolUsage.getToolUsage, {
			caller: "user:client-user",
			verifiedOrg: { orgSlug: CLIENT, orgId: CLIENT_ID },
		})) as Row[];
		expect(got).toHaveLength(1);
		expect(got[0].tool).toBe("client_tool");
	});

	test("UNCHANGED: a Clerk member reads its own rows, and a verifiedActor from a non-service caller is refused", async () => {
		const { t, fleet, operatorSlug } = await fixture();
		const member = t.withIdentity({
			subject: "client-user",
			org_slug: CLIENT,
			org_id: CLIENT_ID,
			org_role: "org:member",
		});
		const own = (await member.query(api.toolUsage.getToolUsage, {})) as Row[];
		expect(own.map((r) => r.tool)).toEqual(["client_tool"]);
		expect(
			await code(
				member.query(api.toolUsage.getToolUsage, {
					verifiedActor: { agentId: fleet.sigma, orgSlug: operatorSlug },
				}),
			),
		).toMatch(/^RBAC_DENIED/);
	});
});
