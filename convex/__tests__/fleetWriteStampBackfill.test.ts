/// <reference types="vite/client" />
//
// migrations/fleetWriteStamp -- the NUMBERS-ONLY count of unstamped rows per table, the
// backfill (dry run first, apply, idempotent) and its reverse path. Task
// k176x68sj2jkwx46nshvtt40e18ht1xh.
//
// IDENTIFICATION RULE (what makes an unstamped row the fleet's): no organisation stamp
// of any kind (no clerkOrgId, no slug), AND its author names an agent of the OPERATOR
// organisation and of no other organisation:
//   - createdById is the _id of an operator-org agent, or
//   - (no createdById) the createdBy label resolves, normalised, to exactly one agents
//     row of the operator org and to NO agents row of any other org.
// A label shared with a client org, a person ("user:..."), an unknown label, a row
// filed in a `team/` namespace (the namespace names an org) are left as they are.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const OP = "fleet-stamp-operator";
const CLIENT = "fleet-stamp-client";
const OP_ID = testClerkOrgId(OP);
const CLIENT_ID = testClerkOrgId(CLIENT);

type Seeded = { sigmaId: Id<"agents">; aliceId: Id<"agents">; ids: Record<string, Id<"memories">>; diaryFleet: Id<"diary"> };

async function seed(t: T): Promise<Seeded> {
	return await t.run(async (ctx) => {
		for (const [slug, kind] of [[OP, "operator"], [CLIENT, undefined]] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: 1,
				...(kind === undefined ? {} : { orgKind: kind }),
			});
		}
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				isActive: true,
				createdAt: 1,
			});
		const sigmaId = await agent(OP, "sigma");
		const aliceId = await agent(CLIENT, "alice");
		await agent(OP, "twin");
		await agent(CLIENT, "twin");
		const mem = (row: {
			createdBy: string;
			createdById?: string;
			namespace?: string;
			clerkOrgId?: string;
		}) =>
			ctx.db.insert("memories", {
				namespace: row.namespace ?? "global",
				type: "project",
				content: "c",
				createdBy: row.createdBy,
				...(row.createdById === undefined ? {} : { createdById: row.createdById }),
				relations: [],
				isLatest: true,
				createdAt: 1,
				updatedAt: 1,
				...(row.clerkOrgId === undefined ? {} : { clerkOrgId: row.clerkOrgId }),
			});
		const ids = {
			byLabel: await mem({ createdBy: "sigma" }),
			byId: await mem({ createdBy: "someone", createdById: sigmaId }),
			client: await mem({ createdBy: "alice" }),
			clientId: await mem({ createdBy: "sigma", createdById: aliceId }),
			ambiguous: await mem({ createdBy: "twin" }),
			person: await mem({ createdBy: "user:user_1" }),
			team: await mem({ createdBy: "sigma", namespace: `team/${CLIENT_ID}` }),
			stamped: await mem({ createdBy: "sigma", clerkOrgId: CLIENT_ID }),
		};
		const diaryFleet = await ctx.db.insert("diary", {
			date: "2026-11-09",
			orchestrator: "sigma",
			content: "d",
			createdBy: "sigma",
			createdAt: 1,
		});
		return { sigmaId, aliceId, ids, diaryFleet };
	});
}

const stampOf = (t: T, id: Id<"memories">) =>
	t.run(async (ctx) => (await ctx.db.get(id))?.clerkOrgId);

describe("count door: numbers only", () => {
	test("unstamped rows per table, and how many are the fleet's", async () => {
		const t = createT();
		await seed(t);
		const r = await t.query(internal.migrations.fleetWriteStamp.count, {
			table: "memories",
		});
		expect(r).toEqual({
			table: "memories",
			examined: 8,
			stamped: 1,
			slugOnly: 0,
			unstamped: 7,
			fleetAttributable: 2,
			unattributed: 5,
			isDone: true,
			nextCursor: null,
		});
		// numbers, booleans and the table name only: no id, label or content leaves
		const text = JSON.stringify(r);
		expect(text).not.toMatch(/sigma|alice|twin|user_1|org_/);
	});
});

describe("backfill", () => {
	test("dry run (the default) lists counts and writes nothing", async () => {
		const t = createT();
		const s = await seed(t);
		const r = await t.mutation(internal.migrations.fleetWriteStamp.run, {
			table: "memories",
		});
		expect(r.dryRun).toBe(true);
		expect(r.toStamp).toBe(2);
		expect(r.stamped).toBe(0);
		expect(r.stampedIds).toEqual([]);
		expect(await stampOf(t, s.ids.byLabel)).toBeUndefined();
	});

	test("apply stamps the fleet's rows with the operator org ID and nothing else; a second apply stamps 0", async () => {
		const t = createT();
		const s = await seed(t);
		const r = await t.mutation(internal.migrations.fleetWriteStamp.run, {
			table: "memories",
			dryRun: false,
		});
		expect(r.stamped).toBe(2);
		expect([...r.stampedIds].sort()).toEqual([s.ids.byLabel, s.ids.byId].sort());
		expect(await stampOf(t, s.ids.byLabel)).toBe(OP_ID);
		expect(await stampOf(t, s.ids.byId)).toBe(OP_ID);
		for (const left of ["client", "clientId", "ambiguous", "person", "team"] as const) {
			expect(await stampOf(t, s.ids[left])).toBeUndefined();
		}
		expect(await stampOf(t, s.ids.stamped)).toBe(CLIENT_ID);
		const again = await t.mutation(internal.migrations.fleetWriteStamp.run, {
			table: "memories",
			dryRun: false,
		});
		expect(again.stamped).toBe(0);
	});

	test("diary is covered by the same rule", async () => {
		const t = createT();
		const s = await seed(t);
		const r = await t.mutation(internal.migrations.fleetWriteStamp.run, {
			table: "diary",
			dryRun: false,
		});
		expect(r.stamped).toBe(1);
		expect((await t.run((ctx) => ctx.db.get(s.diaryFleet)))?.clerkOrgId).toBe(OP_ID);
	});

	test("refuses to run when there is no single operator organisation with an ID", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "only-client",
				clerkOrgId: testClerkOrgId("only-client"),
				allowedOrchestrators: [],
				scopes: [],
				displayName: "c",
				isActive: true,
				createdAt: 1,
			});
		});
		await expect(
			t.mutation(internal.migrations.fleetWriteStamp.run, { table: "memories" }),
		).rejects.toThrow(/operator/);
	});
});

describe("reverse path", () => {
	test("revert restores exactly the rows the apply returned; a row stamped since is left alone", async () => {
		const t = createT();
		const s = await seed(t);
		const applied = await t.mutation(internal.migrations.fleetWriteStamp.run, {
			table: "memories",
			dryRun: false,
		});
		// one of the two was re-stamped by something else after the apply
		await t.run((ctx) => ctx.db.patch(s.ids.byId, { clerkOrgId: CLIENT_ID }));
		const dry = await t.mutation(internal.migrations.fleetWriteStamp.revert, {
			table: "memories",
			ids: applied.stampedIds,
		});
		expect(dry).toMatchObject({ dryRun: true, reverted: 0, revertible: 1, changedSince: 1 });
		expect(await stampOf(t, s.ids.byLabel)).toBe(OP_ID);
		const done = await t.mutation(internal.migrations.fleetWriteStamp.revert, {
			table: "memories",
			ids: applied.stampedIds,
			dryRun: false,
		});
		expect(done).toMatchObject({ dryRun: false, reverted: 1, changedSince: 1 });
		expect(await stampOf(t, s.ids.byLabel)).toBeUndefined();
		expect(await stampOf(t, s.ids.byId)).toBe(CLIENT_ID);
	});
});
