/// <reference types="vite/client" />
// allow-missing-refs: new file this agent creates -- convex/migrations/backfill_recurring_task_actor_ids.ts
/**
 * Module M10h: backfill_recurring_task_actor_ids fills the recurring-task rows written
 * before the schedule doors decided on actor IDs.
 *
 * POLES
 *   DRY RUN   the default writes nothing and prints/returns the PRE-STATE
 *             (rows with / without assignedToId and createdById).
 *   FILL      a label that names exactly one agent in the ROW'S OWN org gets that
 *             agent's _id; the same label in another org is another agent and
 *             never leaks across; an unstamped row resolves in the operator org;
 *             a person ("user:<sub>") is its own ID.
 *   BLOCKED   an ambiguous label (two agents carry it in the row's org) and an
 *             unknown label get NO id guessed: the column stays unset and the
 *             row is listed with its reason.
 *   KEPT      an ID already on a column is never rewritten.
 *   PAGES     cursor + pageSize walk every row exactly once; a second run finds
 *             nothing left to fill.
 *   BAD INPUT pageSize out of range is refused, nothing read.
 */

import type { FunctionReturnType } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);
const run = internal.migrations.backfill_recurring_task_actor_ids.run;
const NOW = 1_700_000_000_000;
const createT = () => convexTest({ schema, modules });
type T = ReturnType<typeof createT>;

type World = {
	fleetEta: Id<"agents">;
	clientEta: Id<"agents">;
	clientTwinA: Id<"agents">;
	clientTwinB: Id<"agents">;
	tasks: Record<string, Id<"recurringTasks">>;
};

// fleet-org (operator): eta.   client-org: eta, twin, twin (two agents, one label).
async function seed(t: T): Promise<World> {
	return await t.run(async (ctx) => {
		for (const [slug, operator] of [
			["fleet-org", true],
			["client-org", false],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		}
		const agent = (name: string, orgSlug: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: name,
				isActive: true,
				createdAt: NOW,
			});
		const fleetEta = await agent("eta", "fleet-org");
		const clientEta = await agent("eta", "client-org");
		const clientTwinA = await agent("twin", "client-org");
		const clientTwinB = await agent("twin", "client-org");
		const task = (title: string, extra: Record<string, unknown>) =>
			ctx.db.insert("recurringTasks", {
				title,
				priority: "low",
				cronExpression: "0 9 * * *",
				nextRunAt: NOW,
				active: true,
				assignedTo: "eta",
				createdBy: "eta",
				createdAt: NOW,
				updatedAt: NOW,
				...extra,
			} as never);
		const tasks = {
			// unstamped (fleet) row: resolves in the operator org
			fleet: await task("fleet", {}),
			// client row: the same label "eta" is ANOTHER agent here
			client: await task("client", { orgId: "client-org" }),
			// two agents carry "twin" in this org: ambiguous, never guessed
			ambiguous: await task("ambiguous", {
				orgId: "client-org",
				assignedTo: "twin",
			}),
			// no agent carries "ghost" in this org
			unknown: await task("unknown", {
				orgId: "client-org",
				assignedTo: "ghost",
			}),
			// a person is its own ID
			person: await task("person", {
				orgId: "client-org",
				createdBy: "user:user_abc",
			}),
			// an ID already on the column is kept
			kept: await task("kept", {
				orgId: "client-org",
				assignedToId: "keep-me",
			}),
		};
		return { fleetEta, clientEta, clientTwinA, clientTwinB, tasks };
	});
}

const row = (t: T, id: Id<"recurringTasks">) => t.run((ctx) => ctx.db.get(id));
const all = (t: T) => t.run((ctx) => ctx.db.query("recurringTasks").collect());

describe("backfill_recurring_task_actor_ids", () => {
	test("DRY RUN is the default: writes nothing and reports the pre-state", async () => {
		const t = createT();
		const w = await seed(t);
		const before = await all(t);
		const r = await t.mutation(run, { pageSize: 100 });
		expect(r.dryRun).toBe(true);
		expect(r.examined).toBe(6);
		// 1 of 6 rows already carries assignedToId; none carries createdById.
		expect(r.preState).toEqual({
			assignedToId: { with: 1, without: 5 },
			createdById: { with: 0, without: 6 },
		});
		expect(r.toFill).toBeGreaterThan(0);
		expect(r.filled).toBe(0);
		expect(r.isDone).toBe(true);
		expect(r.nextCursor).toBeNull();
		expect(await all(t)).toEqual(before);
		expect(w.tasks.fleet).toBeDefined();
	});

	test("FILL: each label resolves in the row's own org; blocked rows are listed, never guessed", async () => {
		const t = createT();
		const w = await seed(t);
		const r = await t.mutation(run, { dryRun: false, pageSize: 100 });
		expect(r.dryRun).toBe(false);
		expect(r.filled).toBeGreaterThan(0);

		const fleet = await row(t, w.tasks.fleet);
		expect(fleet?.assignedToId).toBe(w.fleetEta);
		expect(fleet?.createdById).toBe(w.fleetEta);

		// The same label in another org is another agent: never crossed over.
		const client = await row(t, w.tasks.client);
		expect(client?.assignedToId).toBe(w.clientEta);
		expect(client?.createdById).toBe(w.clientEta);
		expect(client?.assignedToId).not.toBe(w.fleetEta);

		// A person is its own ID.
		expect((await row(t, w.tasks.person))?.createdById).toBe("user:user_abc");

		// An ID already on a column is never rewritten.
		expect((await row(t, w.tasks.kept))?.assignedToId).toBe("keep-me");

		// Ambiguous and unknown: nothing guessed, both listed with the reason.
		expect((await row(t, w.tasks.ambiguous))?.assignedToId).toBeUndefined();
		expect((await row(t, w.tasks.unknown))?.assignedToId).toBeUndefined();
		expect(
			r.blocked
				.filter((b) => b.column === "assignedTo")
				.map((b) => [b.recurringTaskId, b.name, b.reason, b.orgId])
				.sort(),
		).toEqual(
			[
				[w.tasks.ambiguous, "twin", "ambiguousAgent", "client-org"],
				[w.tasks.unknown, "ghost", "unknownAgent", "client-org"],
			].sort(),
		);
		const ambiguousIds = [w.clientTwinA, w.clientTwinB];
		expect(ambiguousIds).not.toContain(
			(await row(t, w.tasks.ambiguous))?.assignedToId,
		);
	});

	test("PAGES: cursor + pageSize walk every row once; a second run has nothing left to fill", async () => {
		const t = createT();
		await seed(t);
		let cursor: string | null = null;
		let examined = 0;
		let pages = 0;
		let filled = 0;
		for (let i = 0; i < 20; i++) {
			const r: FunctionReturnType<typeof run> = await t.mutation(run, {
				dryRun: false,
				pageSize: 2,
				cursor,
			});
			pages++;
			examined += r.examined;
			filled += r.filled;
			if (r.isDone) break;
			cursor = r.nextCursor;
		}
		expect(examined).toBe(6);
		expect(pages).toBe(3);
		expect(filled).toBeGreaterThan(0);

		const again = await t.mutation(run, { dryRun: false, pageSize: 100 });
		expect(again.toFill).toBe(0);
		expect(again.filled).toBe(0);
		// Only the blocked labels are still unresolved.
		expect(again.blocked.map((b) => b.reason).sort()).toEqual([
			"ambiguousAgent",
			"unknownAgent",
		]);
	});

	test("BAD INPUT: pageSize out of range is refused", async () => {
		const t = createT();
		await seed(t);
		await expect(t.mutation(run, { pageSize: 0 })).rejects.toThrow(
			/out of expected range/,
		);
		await expect(t.mutation(run, { pageSize: 501 })).rejects.toThrow(
			/out of expected range/,
		);
	});

	test("ABSENT: an empty tasks table is an empty success", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "fleet-org",
				clerkOrgId: testClerkOrgId("fleet-org"),
				allowedOrchestrators: [],
				scopes: [],
				displayName: "fleet-org",
				isActive: true,
				createdAt: NOW,
				orgKind: "operator",
			});
		});
		const r = await t.mutation(run, {});
		expect(r.examined).toBe(0);
		expect(r.isDone).toBe(true);
		expect(r.blocked).toEqual([]);
		expect(r.preState).toEqual({
			assignedToId: { with: 0, without: 0 },
			createdById: { with: 0, without: 0 },
		});
	});
});
