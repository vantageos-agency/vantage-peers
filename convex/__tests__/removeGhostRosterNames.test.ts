/// <reference types="vite/client" />
//
// remove_ghost_roster_names — drops from `client_org_mapping.allowedOrchestrators`
// the names that resolve to NO agents row in the row's own org (Pi ruling (c),
// task k1778c2hvae8e8vz9f5bbbbbb98g62hw). Hermetic: nothing touches a deployment.
//
// Poles: DRY RUN (lists, changes nothing), WRITE (removes only ghosts, keeps
// resolvable names, "*", and allowedAgentIds), AMBIGUOUS (kept and listed),
// IDEMPOTENT (second run removes nothing), CLEAN ROW (untouched).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);
const NOW = 1_700_000_000_000;
const run =
	internal.migrations.remove_ghost_roster_names.removeGhostRosterNames;

async function world() {
	const t = convexTest(schema, modules);
	const rows: Record<string, Id<"client_org_mapping">> = {};
	const agents: Record<string, Id<"agents">> = {};
	await t.run(async (ctx) => {
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		agents.dirty = await agent("org-dirty", "Eve");
		agents.twin1 = await agent("org-dirty", "twin");
		agents.twin2 = await agent("org-dirty", "Twin");
		agents.clean = await agent("org-clean", "ada");
		// "other" exists only in ANOTHER org: it is a ghost for org-dirty.
		agents.other = await agent("org-clean", "other");
		const mapping = (
			clerkOrgSlug: string,
			allowedOrchestrators: string[],
			allowedAgentIds?: Id<"agents">[],
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug,
				allowedOrchestrators,
				...(allowedAgentIds ? { allowedAgentIds } : {}),
				scopes: ["view-own-tasks"],
				displayName: clerkOrgSlug,
				isActive: true,
				createdAt: NOW,
			});
		rows.dirty = await mapping(
			"org-dirty",
			["eve", "ghost-1", "other", "twin", "*"],
			[agents.dirty],
		);
		rows.clean = await mapping("org-clean", ["ada"], [agents.clean]);
	});
	const snapshot = () =>
		t.run((ctx) => ctx.db.query("client_org_mapping").collect());
	return { t, rows, agents, snapshot };
}

describe("remove_ghost_roster_names", () => {
	test("the dry run lists ghosts per row and changes nothing", async () => {
		const { t, rows, snapshot } = await world();
		const before = await snapshot();
		const report = await t.mutation(run, {});
		expect(report.dryRun).toBe(true);
		expect(report.scanned).toBe(2);
		expect(report.patched).toBe(0);
		expect(report.removedTotal).toBe(2);
		const dirty = report.rows.find((r) => r.rowId === rows.dirty);
		expect(dirty?.removed.sort()).toEqual(["ghost-1", "other"]);
		expect(dirty?.kept).toEqual(["eve", "twin", "*"]);
		expect(await snapshot()).toEqual(before);
	});

	test("the write removes only ghosts and keeps resolvable names and allowedAgentIds", async () => {
		const { t, rows, agents, snapshot } = await world();
		const report = await t.mutation(run, { dryRun: false });
		expect(report.dryRun).toBe(false);
		expect(report.patched).toBe(1);
		expect(report.preState).toEqual([
			{
				rowId: rows.dirty,
				allowedOrchestrators: ["eve", "ghost-1", "other", "twin", "*"],
			},
		]);
		const after = await snapshot();
		const dirty = after.find((r) => r._id === rows.dirty);
		expect(dirty?.allowedOrchestrators).toEqual(["eve", "twin", "*"]);
		expect(dirty?.allowedAgentIds).toEqual([agents.dirty]);
		expect(after).toHaveLength(2);
	});

	test("an ambiguous name is kept and listed", async () => {
		const { t, rows } = await world();
		const report = await t.mutation(run, {});
		expect(report.ambiguous).toEqual([
			{
				rowId: rows.dirty,
				clerkOrgSlug: "org-dirty",
				name: "twin",
				candidates: 2,
			},
		]);
		const dirty = report.rows.find((r) => r.rowId === rows.dirty);
		expect(dirty?.removed).not.toContain("twin");
		expect(dirty?.kept).toContain("twin");
	});

	test("the second run is a no-op", async () => {
		const { t, snapshot } = await world();
		await t.mutation(run, { dryRun: false });
		const afterFirst = await snapshot();
		const second = await t.mutation(run, { dryRun: false });
		expect(second.removedTotal).toBe(0);
		expect(second.patched).toBe(0);
		expect(second.preState).toEqual([]);
		expect(await snapshot()).toEqual(afterFirst);
	});

	test("a row with no ghosts is untouched", async () => {
		const { t, rows, snapshot } = await world();
		const before = (await snapshot()).find((r) => r._id === rows.clean);
		const report = await t.mutation(run, { dryRun: false });
		const entry = report.rows.find((r) => r.rowId === rows.clean);
		expect(entry?.removed).toEqual([]);
		expect(entry?.kept).toEqual(["ada"]);
		const after = (await snapshot()).find((r) => r._id === rows.clean);
		expect(after).toEqual(before);
	});
});
