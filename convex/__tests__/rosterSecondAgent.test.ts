/// <reference types="vite/client" />
//
// Task k170pt4msvafayrz9qx7qv11bs8h7bwz (VantagePeers Cloud, client onboarding).
// Adding a SECOND agent (a new name) to an EXISTING client org. The onboarding script
// (scripts/provision-client-org-agents.mjs) drives these doors in this order:
//   clientOrgMapping:getByClerkSlug -> agents:listAgentsByOrg -> [roster gate]
//   -> agents:registerAgent -> (operator) clientOrgMapping:addRosterMembers.
// The gate used to refuse a name absent from allowedOrchestrators BEFORE registerAgent,
// but the only write path (addRosterMembers) takes an agent ID that registerAgent
// creates: a deadlock (ROSTER_MISSING with no way forward).

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { planRoster } from "../../scripts/lib/roster-plan.mjs";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const ORG = "client-a";
const OTHER = "client-b";
const SERVICE_ACCOUNT_USER_ID = "test-service-account-user-id";

const asAdmin = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Identity);
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:member",
	} as Identity);
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_USER_ID } as Identity);

async function seedOrgWithFirstAgent(t: T, slug: string, first: string) {
	return await t.run(async (ctx) => {
		const agentId = await ctx.db.insert("agents", {
			orgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			name: first,
			normalizedName: first,
			isActive: true,
			createdAt: Date.now(),
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			orgKind: "client",
			allowedOrchestrators: [first],
			allowedAgentIds: [agentId],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
		return agentId;
	});
}

describe("second agent on an existing client org", () => {
	test("script order: the gate plans a registration, the ID path completes the roster", async () => {
		const t = createT();
		const neo = await seedOrgWithFirstAgent(t, ORG, "neo");

		// 1. what the script reads
		const mapping = await asService(t).query(api.clientOrgMapping.getByClerkSlug, { orgSlug: ORG });
		expect(mapping?.allowedOrchestrators).toEqual(["neo"]);
		const rows = await asAdmin(t, ORG).query(api.agents.listAgentsByOrg, {});

		// 2. the gate must not dead-end: hal is unregistered and off the roster -> register it
		const plan = planRoster({ mapping: mapping!, agents: ["neo", "hal"], rows });
		expect(plan.missing).toEqual(["hal"]);
		expect(plan.toRegister).toEqual(["hal"]);

		// 3. register by ID, then the operator appends the ID
		const hal = await asAdmin(t, ORG).mutation(api.agents.registerAgent, { name: "hal" });
		const appended = await t.mutation(internal.clientOrgMapping.addRosterMembers, {
			clerkOrgSlug: ORG,
			agentIds: [hal],
		});
		expect(appended.current).toEqual([neo, hal]);

		// 4. the re-run finds nothing missing
		const again = await asService(t).query(api.clientOrgMapping.getByClerkSlug, { orgSlug: ORG });
		const rows2 = await asAdmin(t, ORG).query(api.agents.listAgentsByOrg, {});
		const plan2 = planRoster({ mapping: again!, agents: ["neo", "hal"], rows: rows2 });
		expect(plan2.missing).toEqual([]);
		expect(plan2.toRegister).toEqual([]);
	});

	test("an agent registered but not yet on the roster is planned for the roster step only", async () => {
		const t = createT();
		await seedOrgWithFirstAgent(t, ORG, "neo");
		await asAdmin(t, ORG).mutation(api.agents.registerAgent, { name: "hal" });
		const mapping = await asService(t).query(api.clientOrgMapping.getByClerkSlug, { orgSlug: ORG });
		const rows = await asAdmin(t, ORG).query(api.agents.listAgentsByOrg, {});
		const plan = planRoster({ mapping: mapping!, agents: ["neo", "hal"], rows });
		expect(plan.missing).toEqual(["hal"]);
		expect(plan.toRegister).toEqual([]);
	});

	test("a capitalised --agents name matches the lowercase label addRosterMembers stored, so the re-run proceeds", () => {
		const plan = planRoster({
			mapping: { allowedOrchestrators: ["neo", "hal"] },
			agents: ["Neo", " HAL "],
			rows: [{ name: "neo" }, { name: "hal" }],
		});
		expect(plan.missing).toEqual([]);
		expect(plan.toRegister).toEqual([]);
	});

	test("a seat-only run never plans a roster step", () => {
		const plan = planRoster({ mapping: { allowedOrchestrators: [] }, agents: ["relay"], rows: [], seatOnly: true });
		expect(plan.missing).toEqual([]);
		expect(plan.toRegister).toEqual([]);
	});

	test("DENY: an ordinary member cannot register the second agent", async () => {
		const t = createT();
		await seedOrgWithFirstAgent(t, ORG, "neo");
		await expect(asMember(t, ORG).mutation(api.agents.registerAgent, { name: "hal" })).rejects.toThrow(
			/RBAC_DENIED|org:admin|admin/i,
		);
	});

	test("DENY: an ordinary member cannot read the mapping the script gates on", async () => {
		const t = createT();
		await seedOrgWithFirstAgent(t, ORG, "neo");
		await expect(
			asMember(t, ORG).query(api.clientOrgMapping.getByClerkSlug, { orgSlug: ORG }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("DENY: another org's agent ID cannot join this org's roster", async () => {
		const t = createT();
		await seedOrgWithFirstAgent(t, ORG, "neo");
		await seedOrgWithFirstAgent(t, OTHER, "zed");
		const foreign: Id<"agents"> = await asAdmin(t, OTHER).mutation(api.agents.registerAgent, { name: "hal" });
		await expect(
			t.mutation(internal.clientOrgMapping.addRosterMembers, { clerkOrgSlug: ORG, agentIds: [foreign] }),
		).rejects.toThrow(/AGENT_NOT_IN_ORG/);
		const mapping = await asService(t).query(api.clientOrgMapping.getByClerkSlug, { orgSlug: ORG });
		expect(mapping?.allowedOrchestrators).toEqual(["neo"]);
	});
});
