/// <reference types="vite/client" />
//
// VantagePeers Cloud — task k172caqyjb46az1fhbd4vcn9sx8hdr4f. A new station agent is
// registered in the OPERATOR org and was never put on its roster, so send_message
// refused it ("ne correspond a aucun destinataire de l'organisation").
// clientOrgMapping:addRosterMembers refuses the operator org; setOrgRoster replaces
// whole lists. clientOrgMapping:addOperatorRosterMember is the append-only door.
//
// Poles:
//   ADD        the agent's id and exact stored name are appended; entries already there untouched, in order
//   AGAIN      a second run changes nothing (added: false)
//   LABELONLY  id present, label missing -> only the label is appended
//   EXACT      a label equal to the stored name is not duplicated
//   CASE       a label differing only in case is not duplicated
//   OTHERORG   an agent of a client org is refused, roster untouched
//   INACTIVE   an inactive agent is refused, roster untouched
//   MISSING    an id naming no agent is refused
//   NOOPERATOR no operator org -> refused

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const OPERATOR = "operator-org";
const CLIENT = "client-org";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const seedOrg = (
	t: T,
	slug: string,
	kind: "operator" | "client",
	allowedOrchestrators: string[],
	allowedAgentIds: Id<"agents">[],
) =>
	t.run(async (ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			orgKind: kind,
			allowedOrchestrators,
			allowedAgentIds,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		}),
	);

const seedAgent = (t: T, slug: string, name: string, isActive = true) =>
	t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			name,
			normalizedName: name.toLowerCase(),
			isActive,
			createdAt: Date.now(),
		}),
	);

const rosterOf = (t: T, slug: string) =>
	t.run(async (ctx) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.unique();
		return {
			labels: row?.allowedOrchestrators,
			ids: row?.allowedAgentIds,
		};
	});

const add = (t: T, agentId: Id<"agents">) =>
	t.mutation(internal.clientOrgMapping.addOperatorRosterMember, { agentId });

describe("clientOrgMapping:addOperatorRosterMember", () => {
	test("ADD: id and exact name appended, existing entries untouched and in order", async () => {
		const t = createT();
		const old = await seedAgent(t, OPERATOR, "Eta");
		await seedOrg(t, OPERATOR, "operator", ["Eta", "pi"], [old]);
		const angelia = await seedAgent(t, OPERATOR, "Angelia");
		const r = await add(t, angelia);
		expect(r.added).toBe(true);
		expect(r.previous).toEqual([old]);
		expect(r.current).toEqual([old, angelia]);
		expect(await rosterOf(t, OPERATOR)).toEqual({
			labels: ["Eta", "pi", "Angelia"],
			ids: [old, angelia],
		});
	});

	test("AGAIN: a second run is a no-op", async () => {
		const t = createT();
		await seedOrg(t, OPERATOR, "operator", ["pi"], []);
		const angelia = await seedAgent(t, OPERATOR, "Angelia");
		await add(t, angelia);
		const before = await rosterOf(t, OPERATOR);
		const again = await add(t, angelia);
		expect(again.added).toBe(false);
		expect(await rosterOf(t, OPERATOR)).toEqual(before);
		expect(before.ids).toEqual([angelia]);
	});

	test("LABELONLY: id on the roster, label missing -> label appended, id not duplicated", async () => {
		const t = createT();
		const angelia = await seedAgent(t, OPERATOR, "Angelia");
		await seedOrg(t, OPERATOR, "operator", ["pi"], [angelia]);
		const r = await add(t, angelia);
		expect(r.added).toBe(true);
		expect(await rosterOf(t, OPERATOR)).toEqual({
			labels: ["pi", "Angelia"],
			ids: [angelia],
		});
	});

	test("EXACT: a label equal to the stored name is not duplicated, the id is still appended", async () => {
		const t = createT();
		const angelia = await seedAgent(t, OPERATOR, "Angelia");
		await seedOrg(t, OPERATOR, "operator", ["Angelia"], []);
		await add(t, angelia);
		expect(await rosterOf(t, OPERATOR)).toEqual({
			labels: ["Angelia"],
			ids: [angelia],
		});
	});

	test("CASE: roster label Kairos + agent kairos (id listed) -> added false, labels unchanged", async () => {
		const t = createT();
		const kairos = await seedAgent(t, OPERATOR, "kairos");
		await seedOrg(t, OPERATOR, "operator", ["Kairos"], [kairos]);
		const r = await add(t, kairos);
		expect(r.added).toBe(false);
		expect(await rosterOf(t, OPERATOR)).toEqual({
			labels: ["Kairos"],
			ids: [kairos],
		});
	});

	test("OTHERORG: an agent of a client org is refused and nothing is written", async () => {
		const t = createT();
		await seedOrg(t, OPERATOR, "operator", ["pi"], []);
		await seedOrg(t, CLIENT, "client", [], []);
		const stranger = await seedAgent(t, CLIENT, "Stranger");
		await expect(add(t, stranger)).rejects.toThrow(/AGENT_NOT_IN_ORG/);
		expect(await rosterOf(t, OPERATOR)).toEqual({ labels: ["pi"], ids: [] });
		expect((await rosterOf(t, CLIENT)).ids).toEqual([]);
	});

	test("INACTIVE: an inactive agent is refused", async () => {
		const t = createT();
		await seedOrg(t, OPERATOR, "operator", ["pi"], []);
		const gone = await seedAgent(t, OPERATOR, "Gone", false);
		await expect(add(t, gone)).rejects.toThrow(/AGENT_NOT_IN_ORG/);
		expect(await rosterOf(t, OPERATOR)).toEqual({ labels: ["pi"], ids: [] });
	});

	test("MISSING: an id naming no agent is refused", async () => {
		const t = createT();
		await seedOrg(t, OPERATOR, "operator", ["pi"], []);
		const ghost = await seedAgent(t, OPERATOR, "Ghost");
		await t.run((ctx) => ctx.db.delete(ghost));
		await expect(add(t, ghost)).rejects.toThrow(/AGENT_NOT_IN_ORG/);
	});

	test("NOOPERATOR: with no operator org the call is refused", async () => {
		const t = createT();
		await seedOrg(t, CLIENT, "client", [], []);
		const a = await seedAgent(t, CLIENT, "Aria");
		await expect(add(t, a)).rejects.toThrow(/OPERATOR_ORG_NOT_FOUND/);
	});
});
