/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, batch F1: the three expand-phase backfills.
//   backfill_diary_agent_ids      diary.agentId (orchestrator label -> agent ID),
//                                 diary.createdById (author label -> author ID)
//   backfill_memory_author_ids    memories.createdById
//   backfill_kb_upload_org_ids    kbUploads.clerkOrgId
//
// Each is a dry run by default, fills only what is decidable within the ROW'S OWN
// org, never guesses (an unknown or ambiguous label is listed and left unset),
// never rewrites a column that already holds an ID, and is idempotent.
//
// Poles: REFUSED (an ambiguous / unknown label is listed, not guessed), ABSENT
// (an empty table is an empty, finished run), PRESENT (the row is filled), plus
// cross-org (the same label in another org is another agent).

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";

// The backfills live under migrations/: unlike the door tests, this file keeps them.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const NOW = 1_780_000_000_000;
const OP_SLUG = "fleet-op";
const OP_ID = testClerkOrgId(OP_SLUG);
const A_SLUG = "acme-a";
const A_ID = testClerkOrgId(A_SLUG);
const B_SLUG = "acme-b";
const B_ID = testClerkOrgId(B_SLUG);

async function world(t: T): Promise<Record<string, Id<"agents">>> {
	const ids: Record<string, Id<"agents">> = {};
	await t.run(async (ctx) => {
		const agent = (orgSlug: string, clerkOrgId: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		ids.opPi = await agent(OP_SLUG, OP_ID, "pi");
		ids.aSeat = await agent(A_SLUG, A_ID, "seat-x");
		ids.bSeat = await agent(B_SLUG, B_ID, "seat-x");
		// An ambiguous label: two agents of org A carry "twin".
		ids.aTwin1 = await agent(A_SLUG, A_ID, "twin");
		ids.aTwin2 = await agent(A_SLUG, A_ID, "twin");
		for (const [slug, id, extra] of [
			[OP_SLUG, OP_ID, { orgKind: "operator" as const, fleetWide: true }],
			[A_SLUG, A_ID, {}],
			[B_SLUG, B_ID, {}],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...extra,
			});
		}
	});
	return ids;
}

describe("backfill_diary_agent_ids", () => {
	const run = (t: T, args: { dryRun?: boolean }) =>
		t.mutation(internal.migrations.backfill_diary_agent_ids.run, args);

	test("a dry run (the default) writes nothing; the write fills agentId and createdById within the row's own org, lists the undecidable, and is idempotent", async () => {
		const t = createT();
		const ids = await world(t);
		const rows = await t.run(async (ctx) => {
			const row = (
				orchestrator: string,
				extra: Record<string, unknown>,
				date: string,
			) =>
				ctx.db.insert("diary", {
					date,
					orchestrator,
					content: orchestrator,
					createdAt: 1,
					...extra,
				});
			return {
				a: await row("seat-x", { orgId: A_SLUG, clerkOrgId: A_ID, createdBy: "seat-x" }, "2026-10-01"),
				b: await row("seat-x", { orgId: B_SLUG, clerkOrgId: B_ID, createdBy: "user:p1" }, "2026-10-01"),
				fleet: await row("pi", {}, "2026-10-01"),
				ghost: await row("ghost", { orgId: A_SLUG, clerkOrgId: A_ID }, "2026-10-02"),
				twin: await row("twin", { orgId: A_SLUG, clerkOrgId: A_ID }, "2026-10-03"),
			};
		});

		const dry = await run(t, {});
		expect(dry.dryRun).toBe(true);
		expect(dry.filled).toBe(0);
		expect(dry.toFill).toBe(5); // 3 agentId + 2 createdById
		expect(dry.blocked.map((b) => `${b.column}:${b.name}:${b.reason}`).sort()).toEqual([
			"agentId:ghost:unknownAgent",
			"agentId:twin:ambiguousAgent",
		]);
		expect((await t.run((ctx) => ctx.db.get(rows.a)))?.agentId).toBeUndefined();

		const wrote = await run(t, { dryRun: false });
		expect(wrote.filled).toBe(5);
		const after = await t.run(async (ctx) => ({
			a: await ctx.db.get(rows.a),
			b: await ctx.db.get(rows.b),
			fleet: await ctx.db.get(rows.fleet),
			ghost: await ctx.db.get(rows.ghost),
			twin: await ctx.db.get(rows.twin),
		}));
		// Cross-org: one label, two orgs, two agents.
		expect(after.a).toMatchObject({ agentId: ids.aSeat, createdById: ids.aSeat });
		expect(after.b).toMatchObject({ agentId: ids.bSeat, createdById: "user:p1" });
		expect(after.fleet?.agentId).toBe(ids.opPi);
		expect(after.ghost?.agentId).toBeUndefined();
		expect(after.twin?.agentId).toBeUndefined();

		const again = await run(t, { dryRun: false });
		expect(again.filled).toBe(0);
		expect(again.preState.with).toBe(3);
	});

	test("ABSENT: an empty diary is an empty, finished run", async () => {
		const t = createT();
		await world(t);
		const out = await run(t, { dryRun: false });
		expect(out).toMatchObject({ examined: 0, filled: 0, isDone: true });
	});
});

describe("backfill_memory_author_ids", () => {
	const run = (t: T, args: { dryRun?: boolean }) =>
		t.mutation(internal.migrations.backfill_memory_author_ids.run, args);

	test("fills the author ID within the row's own org (the fleet for an unstamped row), lists the undecidable, never rewrites", async () => {
		const t = createT();
		const ids = await world(t);
		const rows = await t.run(async (ctx) => {
			const row = (
				createdBy: string,
				namespace: string,
				extra: Record<string, unknown>,
			) =>
				ctx.db.insert("memories", {
					namespace,
					type: "project",
					content: createdBy,
					createdBy,
					relations: [],
					isLatest: true,
					createdAt: 1,
					updatedAt: 1,
					...extra,
				});
			return {
				a: await row("seat-x", `team/${A_ID}`, { clerkOrgId: A_ID }),
				b: await row("seat-x", `team/${B_ID}`, { clerkOrgId: B_ID }),
				person: await row("user:p2", `team/${A_ID}`, { clerkOrgId: A_ID }),
				fleet: await row("pi", "global", {}),
				ghost: await row("ghost", `team/${A_ID}`, { clerkOrgId: A_ID }),
				done: await row("seat-x", `team/${A_ID}`, {
					clerkOrgId: A_ID,
					createdById: "already",
				}),
			};
		});
		const dry = await run(t, {});
		expect(dry.filled).toBe(0);
		expect(dry.toFill).toBe(4);
		expect(dry.alreadySet).toBe(1);
		expect(dry.blocked.map((b) => b.name)).toEqual(["ghost"]);
		const wrote = await run(t, { dryRun: false });
		expect(wrote.filled).toBe(4);
		const after = await t.run(async (ctx) => ({
			a: (await ctx.db.get(rows.a))?.createdById,
			b: (await ctx.db.get(rows.b))?.createdById,
			person: (await ctx.db.get(rows.person))?.createdById,
			fleet: (await ctx.db.get(rows.fleet))?.createdById,
			ghost: (await ctx.db.get(rows.ghost))?.createdById,
			done: (await ctx.db.get(rows.done))?.createdById,
		}));
		expect(after).toEqual({
			a: ids.aSeat,
			b: ids.bSeat,
			person: "user:p2",
			fleet: ids.opPi,
			ghost: undefined,
			done: "already",
		});
		expect((await run(t, { dryRun: false })).filled).toBe(0);
	});
});

describe("backfill_kb_upload_org_ids", () => {
	const run = (t: T, args: { dryRun?: boolean }) =>
		t.mutation(internal.migrations.backfill_kb_upload_org_ids.run, args);

	test("a label binding and an ID binding are filled with the org's permanent ID; an unknown key is listed, not guessed", async () => {
		const t = createT();
		await world(t);
		const rows = await t.run(async (ctx) => {
			const bind = async (orgId: string, extra: Record<string, unknown> = {}) => {
				const storageId = await ctx.storage.store(new Blob([orgId]));
				return ctx.db.insert("kbUploads", {
					storageId,
					orgId,
					createdAt: 1,
					...extra,
				});
			};
			return {
				byLabel: await bind(A_SLUG),
				byId: await bind(B_ID),
				unknown: await bind("no-such-org"),
				done: await bind(A_SLUG, { clerkOrgId: A_ID }),
			};
		});
		const dry = await run(t, {});
		expect(dry.filled).toBe(0);
		expect(dry.toFill).toBe(2);
		expect(dry.alreadyFilled).toBe(1);
		expect(dry.undecidable.map((u) => u.key)).toEqual(["no-such-org"]);
		const wrote = await run(t, { dryRun: false });
		expect(wrote.filled).toBe(2);
		const after = await t.run(async (ctx) => ({
			byLabel: (await ctx.db.get(rows.byLabel))?.clerkOrgId,
			byId: (await ctx.db.get(rows.byId))?.clerkOrgId,
			unknown: (await ctx.db.get(rows.unknown))?.clerkOrgId,
		}));
		expect(after).toEqual({ byLabel: A_ID, byId: B_ID, unknown: undefined });
		expect((await run(t, { dryRun: false })).filled).toBe(0);
	});

	test("ABSENT: a deployment with no bindings is an empty, finished run", async () => {
		const t = createT();
		await world(t);
		expect(await run(t, { dryRun: false })).toMatchObject({
			examined: 0,
			filled: 0,
			isDone: true,
		});
	});
});
