/// <reference types="vite/client" />
// allow-missing-refs: new file
/**
 * Module M10e, step 1: backfill_mission_actor_ids fills the mission rows
 * written before the mission doors decided on actor IDs.
 *
 * POLES
 *   DRY RUN   the default writes nothing and returns the PRE-STATE.
 *   FILL      a label naming exactly one agent in the ROW'S OWN org gets that
 *             agent's _id; the same label in another org is another agent; an
 *             unstamped row resolves in the operator org; a person is its own ID.
 *   BLOCKED   an ambiguous or unknown label gets NO id guessed: the column stays
 *             unset and the row is listed. `agentIds` is written only when EVERY
 *             participant label resolves.
 *   KEPT      an ID already on a column is never rewritten.
 *   SERVED    after the backfill an org member reads the row (it was withheld
 *             before: a row without IDs names nobody).
 *   BAD INPUT pageSize out of range is refused.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(Object.entries(import.meta.glob("../**/*.ts")));
const run = internal.migrations.backfill_mission_actor_ids.run;
const NOW = 1_700_000_000_000;
const createT = () => convexTest({ schema, modules });
type T = ReturnType<typeof createT>;

async function seed(t: T) {
	return await t.run(async (ctx) => {
		for (const [slug, operator] of [
			["fleet-org", true],
			["client-org", false],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: ["view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		}
		const agent = (name: string, orgSlug: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name,
				isActive: true,
				createdAt: NOW,
			});
		const fleetEta = await agent("eta", "fleet-org");
		const clientEta = await agent("eta", "client-org");
		await agent("twin", "client-org");
		await agent("twin", "client-org");
		const mission = (name: string, extra: Record<string, unknown>) =>
			ctx.db.insert("missions", {
				name,
				project: "p",
				status: "execute",
				priority: "low",
				pilot: "eta",
				agents: ["eta"],
				createdBy: "eta",
				createdAt: NOW,
				updatedAt: NOW,
				...extra,
			} as never);
		const missions = {
			fleet: await mission("fleet", {}),
			client: await mission("client", {
				orgId: "client-org",
				clerkOrgId: testClerkOrgId("client-org"),
			}),
			ambiguous: await mission("ambiguous", {
				orgId: "client-org",
				pilot: "twin",
				agents: ["eta", "twin"],
			}),
			unknown: await mission("unknown", {
				orgId: "client-org",
				pilot: "ghost",
			}),
			person: await mission("person", {
				orgId: "client-org",
				createdBy: "user:user_abc",
			}),
			kept: await mission("kept", { orgId: "client-org", pilotId: "keep-me" }),
		};
		return { fleetEta, clientEta, missions };
	});
}

const row = (t: T, id: Id<"missions">) => t.run((ctx) => ctx.db.get(id));

describe("backfill_mission_actor_ids", () => {
	test("DRY RUN is the default: nothing is written, the pre-state is returned", async () => {
		const t = createT();
		const w = await seed(t);
		const r = await t.mutation(run, {});
		expect(r.dryRun).toBe(true);
		expect(r.examined).toBe(6);
		expect(r.preState.pilotId).toEqual({ with: 1, without: 5 });
		expect(r.toFill).toBeGreaterThan(0);
		expect(r.filled).toBe(0);
		expect((await row(t, w.missions.fleet))?.pilotId).toBeUndefined();
	});

	test("FILL: each label resolves in the row's own org; a person is its own ID", async () => {
		const t = createT();
		const w = await seed(t);
		await t.mutation(run, { dryRun: false });
		const fleet = await row(t, w.missions.fleet);
		expect(fleet?.pilotId).toBe(w.fleetEta);
		expect(fleet?.createdById).toBe(w.fleetEta);
		expect(fleet?.agentIds).toEqual([w.fleetEta]);
		const client = await row(t, w.missions.client);
		expect(client?.pilotId).toBe(w.clientEta);
		expect(client?.pilotId).not.toBe(w.fleetEta);
		const person = await row(t, w.missions.person);
		expect(person?.createdById).toBe("user:user_abc");
	});

	test("BLOCKED: ambiguous and unknown labels are listed, never guessed", async () => {
		const t = createT();
		const w = await seed(t);
		const r = await t.mutation(run, { dryRun: false });
		const reasons = r.blocked.map((b) => `${b.column}:${b.name}:${b.reason}`).sort();
		expect(reasons).toEqual([
			"agents:twin:ambiguousAgent",
			"pilot:ghost:unknownAgent",
			"pilot:twin:ambiguousAgent",
		]);
		const ambiguous = await row(t, w.missions.ambiguous);
		expect(ambiguous?.pilotId).toBeUndefined();
		expect(ambiguous?.agentIds).toBeUndefined();
		expect((await row(t, w.missions.unknown))?.pilotId).toBeUndefined();
	});

	test("KEPT: an ID already on a column is never rewritten; a second run fills nothing", async () => {
		const t = createT();
		const w = await seed(t);
		await t.mutation(run, { dryRun: false });
		expect((await row(t, w.missions.kept))?.pilotId).toBe("keep-me");
		const again = await t.mutation(run, { dryRun: false });
		expect(again.filled).toBe(0);
	});

	test("PAGES: cursor and pageSize walk every row exactly once", async () => {
		const t = createT();
		await seed(t);
		let cursor: string | null = null;
		let examined = 0;
		for (let i = 0; i < 10; i++) {
			const r: { examined: number; isDone: boolean; nextCursor: string | null } =
				await t.mutation(run, { pageSize: 2, cursor });
			examined += r.examined;
			if (r.isDone) break;
			cursor = r.nextCursor;
		}
		expect(examined).toBe(6);
	});

	test("SERVED: a member reads the row only after the backfill", async () => {
		const t = createT();
		const w = await seed(t);
		await t.run(async (ctx) => {
			const mapping = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "client-org"))
				.unique();
			if (mapping)
				await ctx.db.patch(mapping._id, {
					allowedOrchestrators: ["eta"],
					allowedAgentIds: [w.clientEta],
				});
		});
		const member = t.withIdentity({
			subject: "user-client",
			organizationId: "client-org",
			org_id: testClerkOrgId("client-org"),
		} as Parameters<T["withIdentity"]>[0]);
		const before = await member.query(api.missions.get, {
			missionId: w.missions.client,
		});
		expect(before).toBeNull();
		await t.mutation(run, { dryRun: false });
		const after = await member.query(api.missions.get, {
			missionId: w.missions.client,
		});
		expect(after?._id).toBe(w.missions.client);
	});

	test("BAD INPUT: pageSize out of range is refused", async () => {
		const t = createT();
		await seed(t);
		await expect(t.mutation(run, { pageSize: 0 })).rejects.toThrow(/out of expected range/);
		await expect(t.mutation(run, { pageSize: 501 })).rejects.toThrow(/out of expected range/);
	});
});
