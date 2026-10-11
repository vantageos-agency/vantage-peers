/// <reference types="vite/client" />
// allow-missing-refs: new file this agent creates
//
// migrations/namespace_by_org_id rewrites stored `team/<orgSlug>` namespaces to
// `team/<clerkOrgId>`. Pinned in both directions: it reports the pre-state before
// writing, a dry run writes nothing, a real run rewrites exactly the mapped rows,
// an unmapped slug is refused and listed (never guessed), a second run writes
// nothing, and the read-back reports zero remaining.
// Hermetic. Fictitious identifiers only.

import type { FunctionReturnType } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const run = internal.migrations.namespace_by_org_id.run;
const inventory = internal.migrations.namespace_by_org_id.inventory;
const readBack = internal.migrations.namespace_by_org_id.readBack;
type RunResult = FunctionReturnType<typeof run>;

// A real run schedules RAG re-indexing; freeze time so it is queued, not run.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const NOW = 1_700_000_000_000;
const ACME = { slug: "acme-hr", id: "org_ACME1" };
const BETA = { slug: "beta-co", id: "org_BETA1" };

async function seedMappings(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const mapping = (slug: string, clerkOrgId?: string) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["seat-x"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(clerkOrgId !== undefined ? { clerkOrgId } : {}),
			});
		await mapping(ACME.slug, ACME.id);
		await mapping(BETA.slug, BETA.id);
		await mapping("not-filled-yet");
		await mapping("twice", "org_TWICE1");
		await mapping("twice", "org_TWICE2");
	});
}

const memory = (namespace: string, content: string, isLatest = true) => ({
	namespace,
	type: "project" as const,
	content,
	createdBy: "seat-x",
	relations: [],
	isLatest,
	createdAt: NOW,
	updatedAt: NOW,
});

async function seedMemories(t: T) {
	return await t.run(async (ctx) => ({
		acme: await ctx.db.insert("memories", memory(`team/${ACME.slug}`, "a")),
		acmeSub: await ctx.db.insert(
			"memories",
			memory(`team/${ACME.slug}/docs/d1`, "a-sub"),
		),
		acmeOld: await ctx.db.insert(
			"memories",
			memory(`team/${ACME.slug}`, "a-superseded", false),
		),
		beta: await ctx.db.insert("memories", memory(`team/${BETA.slug}`, "b")),
		byId: await ctx.db.insert("memories", memory(`team/${ACME.id}`, "kept")),
		ghost: await ctx.db.insert("memories", memory("team/ghost-org", "g")),
		notFilled: await ctx.db.insert(
			"memories",
			memory("team/not-filled-yet", "nf"),
		),
		twice: await ctx.db.insert("memories", memory("team/twice", "tw")),
		// Not team namespaces: never touched.
		global: await ctx.db.insert("memories", memory("global", "glob")),
		project: await ctx.db.insert("memories", memory("project/acme-hr", "proj")),
		teamLike: await ctx.db.insert("memories", memory("teams/acme-hr", "tl")),
	}));
}

const nsOf = (t: T, id: string) =>
	t.run(async (ctx) => {
		const doc = (await ctx.db.get(id as never)) as unknown as {
			namespace: string;
		};
		return doc.namespace;
	});

async function walk(
	t: T,
	table:
		| "memories"
		| "oauth_access_tokens"
		| "oauth_scope_profiles"
		| "kbUploads"
		| "uploadTickets",
	dryRun: boolean,
	pageSize?: number,
) {
	const total = {
		examined: 0,
		alreadyById: 0,
		toRewrite: 0,
		rewritten: 0,
		ragReindexScheduled: 0,
		unmappedRows: [] as RunResult["unmappedRows"],
	};
	let cursor: string | null = null;
	for (let guard = 0; guard < 100; guard++) {
		const r: RunResult = await t.mutation(run, {
			table,
			dryRun,
			cursor,
			pageSize,
		});
		total.examined += r.examined;
		total.alreadyById += r.alreadyById;
		total.toRewrite += r.toRewrite;
		total.rewritten += r.rewritten;
		total.ragReindexScheduled += r.ragReindexScheduled;
		total.unmappedRows.push(...r.unmappedRows);
		if (r.isDone) return total;
		cursor = r.nextCursor;
	}
	throw new Error("walk did not terminate");
}

describe("namespace_by_org_id", () => {
	test("inventory reports the pre-state (slug -> ID map, rows per segment) and writes nothing", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedMemories(t);

		const inv = await t.query(inventory, { table: "memories" });
		expect(inv.isDone).toBe(true);
		// 8 rows sit on a `team/` namespace; global, project/ and teams/ do not.
		expect(inv.rowsOnTeamNamespace).toBe(8);
		const seg = Object.fromEntries(inv.bySegment.map((s) => [s.segment, s]));
		expect(seg[ACME.slug]).toMatchObject({
			form: "slug",
			clerkOrgId: ACME.id,
			rows: 3,
		});
		expect(seg[BETA.slug]).toMatchObject({ form: "slug", rows: 1 });
		expect(seg[ACME.id]).toMatchObject({ form: "id", rows: 1 });
		expect(seg["ghost-org"]).toMatchObject({ form: "unmapped", rows: 1 });
		expect(inv.unmappedRows.map((u) => u.segment).sort()).toEqual([
			"ghost-org",
			"not-filled-yet",
			"twice",
		]);
		const slugMap = Object.fromEntries(
			inv.slugToClerkOrgId.map((m) => [m.slug, m.clerkOrgId]),
		);
		expect(slugMap[ACME.slug]).toBe(ACME.id);
		expect(slugMap["not-filled-yet"]).toBeNull();
		expect(await nsOf(t, ids.acme)).toBe(`team/${ACME.slug}`);
	});

	test("DRY RUN (the default) counts what it would rewrite and writes nothing", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedMemories(t);

		const r = await t.mutation(run, { table: "memories" });
		expect(r.dryRun).toBe(true);
		expect(r.toRewrite).toBe(4);
		expect(r.rewritten).toBe(0);
		expect(r.ragReindexScheduled).toBe(0);
		expect(await nsOf(t, ids.acme)).toBe(`team/${ACME.slug}`);
		expect(await nsOf(t, ids.beta)).toBe(`team/${BETA.slug}`);
	});

	test("REAL RUN rewrites mapped slugs to the ID form; unmapped, ambiguous and unfilled are refused and listed", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedMemories(t);

		const r = await walk(t, "memories", false, 3);
		expect(r.rewritten).toBe(4);
		// A rewritten memory moves later in the namespace index, so a multi-page walk
		// meets it again as already-migrated: the count is a floor, not exact.
		expect(r.alreadyById).toBeGreaterThanOrEqual(1);
		expect(r.ragReindexScheduled).toBe(4);

		expect(await nsOf(t, ids.acme)).toBe(`team/${ACME.id}`);
		expect(await nsOf(t, ids.acmeSub)).toBe(`team/${ACME.id}/docs/d1`);
		expect(await nsOf(t, ids.acmeOld)).toBe(`team/${ACME.id}`);
		expect(await nsOf(t, ids.beta)).toBe(`team/${BETA.id}`);
		expect(await nsOf(t, ids.byId)).toBe(`team/${ACME.id}`);

		// Never guessed: the three undecidable rows are untouched and listed.
		expect(await nsOf(t, ids.ghost)).toBe("team/ghost-org");
		expect(await nsOf(t, ids.notFilled)).toBe("team/not-filled-yet");
		expect(await nsOf(t, ids.twice)).toBe("team/twice");
		const reasons = Object.fromEntries(
			r.unmappedRows.map((u) => [u.segment, u.reason]),
		);
		expect(reasons).toEqual({
			"ghost-org": "orgUnmapped",
			"not-filled-yet": "mappingHasNoClerkId",
			twice: "ambiguousMapping",
		});

		// Not team namespaces: untouched.
		expect(await nsOf(t, ids.global)).toBe("global");
		expect(await nsOf(t, ids.project)).toBe("project/acme-hr");
		expect(await nsOf(t, ids.teamLike)).toBe("teams/acme-hr");
	});

	test("IDEMPOTENT: a second real run writes nothing", async () => {
		const t = createT();
		await seedMappings(t);
		await seedMemories(t);
		await walk(t, "memories", false);
		const again = await walk(t, "memories", false);
		expect(again.toRewrite).toBe(0);
		expect(again.rewritten).toBe(0);
		expect(again.ragReindexScheduled).toBe(0);
		expect(again.alreadyById).toBe(5);
	});

	test("READ-BACK reports what remains, and zero once everything is migrated", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedMemories(t);

		const before = await t.query(readBack, { table: "memories" });
		expect(before.remainingOnSlug).toBe(4);
		expect(before.unmapped).toBe(3);
		expect(before.clean).toBe(false);

		await walk(t, "memories", false);
		const mid = await t.query(readBack, { table: "memories" });
		expect(mid.remainingOnSlug).toBe(0);
		expect(mid.onIdForm).toBe(5);
		// The three refused rows keep it from being clean until a person decides them.
		expect(mid.unmapped).toBe(3);
		expect(mid.clean).toBe(false);

		await t.run(async (ctx) => {
			await ctx.db.delete(ids.ghost);
			await ctx.db.delete(ids.notFilled);
			await ctx.db.delete(ids.twice);
		});
		const after = await t.query(readBack, { table: "memories" });
		expect(after).toMatchObject({
			remainingOnSlug: 0,
			unmapped: 0,
			clean: true,
		});
	});

	test("oauth prefix arrays are rewritten whole; a row with ANY refused prefix is not written at all", async () => {
		const t = createT();
		await seedMappings(t);
		const { ok, mixed } = await t.run(async (ctx) => {
			const profile = (profileId: string, read: string[], write: string[]) =>
				ctx.db.insert("oauth_scope_profiles", {
					profileId,
					description: profileId,
					fromAllowList: [],
					namespaceReadPrefixes: read,
					namespaceWritePrefixes: write,
					createdAt: NOW,
					updatedAt: NOW,
				});
			return {
				ok: await profile(
					"p-ok",
					[`team/${ACME.slug}`, "project/acme-hr"],
					[`team/${ACME.slug}`],
				),
				mixed: await profile(
					"p-mixed",
					[`team/${ACME.slug}`, "team/ghost-org"],
					[`team/${ACME.slug}`],
				),
			};
		});

		const r = await walk(t, "oauth_scope_profiles", false);
		expect(r.rewritten).toBe(1);
		expect(r.unmappedRows.map((u) => u.id)).toEqual([mixed]);
		const read = async (id: string) =>
			t.run(async (ctx) => {
				const doc = (await ctx.db.get(id as never)) as unknown as {
					namespaceReadPrefixes: string[];
					namespaceWritePrefixes: string[];
				};
				return doc;
			});
		expect(await read(ok)).toMatchObject({
			namespaceReadPrefixes: [`team/${ACME.id}`, "project/acme-hr"],
			namespaceWritePrefixes: [`team/${ACME.id}`],
		});
		expect(await read(mixed)).toMatchObject({
			namespaceReadPrefixes: [`team/${ACME.slug}`, "team/ghost-org"],
			namespaceWritePrefixes: [`team/${ACME.slug}`],
		});
	});

	test("a pageSize out of range is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(run, { table: "memories", pageSize: 0 }),
		).rejects.toThrow("out of expected range");
		await expect(
			t.mutation(run, { table: "memories", pageSize: 501 }),
		).rejects.toThrow("out of expected range");
	});

	test("after the migration the org reads its migrated rows under its ID, and a renamed slug no longer matters", async () => {
		const t = createT();
		await seedMappings(t);
		await seedMemories(t);
		await walk(t, "memories", false);

		// Acme is renamed; its session carries the new slug and the same ID.
		await t.run(async (ctx) => {
			const rows = await ctx.db.query("client_org_mapping").collect();
			const acme = rows.find((r) => r.clerkOrgId === ACME.id);
			if (acme === undefined) throw new Error("no acme mapping");
			await ctx.db.patch(acme._id, { clerkOrgSlug: "acme-renamed" });
		});
		const asAcme = t.withIdentity({
			subject: "user-acme",
			organizationId: "acme-renamed",
			org_slug: "acme-renamed",
			org_id: ACME.id,
		} as Parameters<T["withIdentity"]>[0]);
		const page = await asAcme.query(api.memories.listMemories, {
			namespace: `team/${ACME.id}`,
		});
		expect(page.value.map((m) => m.content).sort()).toEqual(["a", "kept"]);
	});
});
