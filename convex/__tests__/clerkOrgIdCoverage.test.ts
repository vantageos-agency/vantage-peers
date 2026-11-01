/// <reference types="vite/client" />
//
// clerkOrgId coverage + backfill (task k1783fk8r6p795x9fxrzyt9evd8hcxm7), run BEFORE
// the slug-class refusal PR makes rows without a permanent org ID refused. Pinned:
//   (a) `count` reports rows with / without clerkOrgId on a seeded mix, counts only;
//   (b) `backfill` dry-run writes nothing and reports the would-fill count;
//   (c) a real run fills rows whose slug names ONE ACTIVE mapping carrying an ID, and
//       lists every other row by _id (absent, inactive, ambiguous, id-less mapping),
//       writing nothing to them;
//   (d) a second run fills 0;
//   (e) an existing clerkOrgId is never overwritten, even when it disagrees with the slug;
//   (f) a row without clerkOrgId is admitted by the ID-comparing gate only AFTER the
//       backfill (the gate here is a stub of the predicate PR #1626 puts in
//       assertRowInVerifiedOrg: sameOrg(orgRefOfRow(row), { id: mapping.clerkOrgId });
//       #1626 is not on main, so the real function is not reachable from this branch).
// Hermetic. Fictitious identifiers only.

import { sameOrg } from "@vantageos/cloud-identity";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { lookupOrgMapping, orgRefOfRow } from "../lib/authOrgMapping";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const NOW = 1_700_000_000_000;
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const count = internal.migrations.clerkOrgIdCoverage.count;
const backfill = internal.migrations.clerkOrgIdCoverage.backfill;

async function seedMappings(t: T) {
	await t.run(async (ctx) => {
		const mapping = (
			slug: string,
			extra: { clerkOrgId?: string; isActive?: boolean },
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: extra.isActive ?? true,
				createdAt: NOW,
				...(extra.clerkOrgId !== undefined
					? { clerkOrgId: extra.clerkOrgId }
					: {}),
			});
		await mapping("acme-hr", { clerkOrgId: "org_ACME1" });
		await mapping("dormant", { clerkOrgId: "org_DORM1", isActive: false });
		await mapping("no-id-yet", {});
		await mapping("twice", { clerkOrgId: "org_TWICE1" });
		await mapping("twice", { clerkOrgId: "org_TWICE2" });
	});
}

const profile = (
	profileId: string,
	slug: string | undefined,
	clerkOrgId?: string,
) => ({
	profileId,
	description: profileId,
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	createdAt: NOW,
	updatedAt: NOW,
	...(slug !== undefined ? { clerkOrgSlug: slug } : {}),
	...(clerkOrgId !== undefined ? { clerkOrgId } : {}),
});

const task = (
	title: string,
	orgId: string | undefined,
	clerkOrgId?: string,
) => ({
	title,
	status: "todo" as const,
	priority: "low" as const,
	assignedTo: "seat-x",
	createdBy: "seat-x",
	createdAt: NOW,
	updatedAt: NOW,
	...(orgId !== undefined ? { orgId } : {}),
	...(clerkOrgId !== undefined ? { clerkOrgId } : {}),
});

type Ids = {
	okProfile: Id<"oauth_scope_profiles">;
	keptProfile: Id<"oauth_scope_profiles">;
	absentProfile: Id<"oauth_scope_profiles">;
	inactiveProfile: Id<"oauth_scope_profiles">;
	ambiguousProfile: Id<"oauth_scope_profiles">;
	noIdProfile: Id<"oauth_scope_profiles">;
	okTask: Id<"tasks">;
	keptTask: Id<"tasks">;
	ghostTask: Id<"tasks">;
	unstampedTask: Id<"tasks">;
};

// Profiles: 1 resolvable, 1 already filled, 4 unresolvable. Tasks: 1 resolvable,
// 1 already filled (with an ID that DISAGREES with its slug), 1 absent slug, 1 no slug.
async function seedRows(t: T): Promise<Ids> {
	return await t.run(async (ctx) => ({
		okProfile: await ctx.db.insert(
			"oauth_scope_profiles",
			profile("p-ok", "acme-hr"),
		),
		keptProfile: await ctx.db.insert(
			"oauth_scope_profiles",
			profile("p-kept", "acme-hr", "org_ACME1"),
		),
		absentProfile: await ctx.db.insert(
			"oauth_scope_profiles",
			profile("p-absent", "ghost-org"),
		),
		inactiveProfile: await ctx.db.insert(
			"oauth_scope_profiles",
			profile("p-inactive", "dormant"),
		),
		ambiguousProfile: await ctx.db.insert(
			"oauth_scope_profiles",
			profile("p-twice", "twice"),
		),
		noIdProfile: await ctx.db.insert(
			"oauth_scope_profiles",
			profile("p-noid", "no-id-yet"),
		),
		okTask: await ctx.db.insert("tasks", task("ok", "acme-hr")),
		keptTask: await ctx.db.insert(
			"tasks",
			task("kept", "acme-hr", "org_OTHER9"),
		),
		ghostTask: await ctx.db.insert("tasks", task("ghost", "ghost-org")),
		unstampedTask: await ctx.db.insert("tasks", task("fleet", undefined)),
	}));
}

async function walk<R extends { done: boolean; cursor: string | null }>(
	step: (cursor: string | null) => Promise<R>,
): Promise<R[]> {
	const pages: R[] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 50; i++) {
		const page = await step(cursor);
		pages.push(page);
		if (page.done) return pages;
		cursor = page.cursor;
	}
	throw new Error("walk did not finish");
}

const sum = <R,>(pages: R[], pick: (p: R) => number) =>
	pages.reduce((n, p) => n + pick(p), 0);

describe("clerkOrgIdCoverage:count", () => {
	test("(a) counts rows with and without clerkOrgId, over several pages, counts only", async () => {
		const t = createT();
		await seedMappings(t);
		await seedRows(t);
		const profiles = await walk((cursor) =>
			t.query(count, { table: "oauth_scope_profiles", cursor, pageSize: 2 }),
		);
		expect(profiles.length).toBeGreaterThan(1);
		expect(sum(profiles, (p) => p.withId)).toBe(1);
		expect(sum(profiles, (p) => p.withoutId)).toBe(5);
		const tasks = await walk((cursor) =>
			t.query(count, { table: "tasks", cursor, pageSize: 3 }),
		);
		expect(sum(tasks, (p) => p.withId)).toBe(1);
		expect(sum(tasks, (p) => p.withoutId)).toBe(3);
		// counts only: no row content leaves the query
		expect(Object.keys(tasks[0]).sort()).toEqual(
			["cursor", "done", "examined", "table", "withId", "withoutId"].sort(),
		);
	});

	test("an empty table is a real zero, done in one page", async () => {
		const t = createT();
		const [page] = await walk((cursor) =>
			t.query(count, { table: "tasks", cursor }),
		);
		expect(page).toMatchObject({ withId: 0, withoutId: 0, done: true });
	});
});

describe("clerkOrgIdCoverage:backfill", () => {
	test("(b) dry run (the default) writes nothing and reports the would-fill count", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedRows(t);
		const pages = await walk((cursor) =>
			t.mutation(backfill, { table: "oauth_scope_profiles", cursor }),
		);
		expect(pages.every((p) => p.dryRun)).toBe(true);
		expect(sum(pages, (p) => p.toFill)).toBe(1);
		expect(sum(pages, (p) => p.filled)).toBe(0);
		const row = await t.run((ctx) => ctx.db.get(ids.okProfile));
		expect(row?.clerkOrgId).toBeUndefined();
	});

	test("(c) fills the resolvable profile; lists the four unresolvable by _id, unwritten", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedRows(t);
		const pages = await walk((cursor) =>
			t.mutation(backfill, {
				table: "oauth_scope_profiles",
				dryRun: false,
				cursor,
				pageSize: 2,
			}),
		);
		expect(sum(pages, (p) => p.filled)).toBe(1);
		expect(sum(pages, (p) => p.unresolved)).toBe(4);
		const listed = pages.flatMap((p) => p.unresolvedIds);
		expect([...listed].sort()).toEqual(
			[
				ids.absentProfile,
				ids.inactiveProfile,
				ids.ambiguousProfile,
				ids.noIdProfile,
			].sort(),
		);
		expect({
			absentSlug: sum(pages, (p) => p.unresolvedByReason.absentSlug),
			inactiveMapping: sum(pages, (p) => p.unresolvedByReason.inactiveMapping),
			ambiguousSlug: sum(pages, (p) => p.unresolvedByReason.ambiguousSlug),
			mappingHasNoClerkId: sum(
				pages,
				(p) => p.unresolvedByReason.mappingHasNoClerkId,
			),
		}).toEqual({
			absentSlug: 1,
			inactiveMapping: 1,
			ambiguousSlug: 1,
			mappingHasNoClerkId: 1,
		});
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.okProfile))?.clerkOrgId).toBe("org_ACME1");
			for (const id of listed) {
				const row = await ctx.db.get(id as Id<"oauth_scope_profiles">);
				expect(row?.clerkOrgId).toBeUndefined();
			}
		});
	});

	test("tasks resolve from their own orgId stamp; an unstamped task is never invented an org", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedRows(t);
		const pages = await walk((cursor) =>
			t.mutation(backfill, { table: "tasks", dryRun: false, cursor }),
		);
		expect(sum(pages, (p) => p.filled)).toBe(1);
		expect(sum(pages, (p) => p.noSlug)).toBe(1);
		expect(pages.flatMap((p) => p.unresolvedIds)).toEqual([ids.ghostTask]);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.okTask))?.clerkOrgId).toBe("org_ACME1");
			expect(
				(await ctx.db.get(ids.unstampedTask))?.clerkOrgId,
			).toBeUndefined();
		});
	});

	test("the unresolved id list is capped, the count is not", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < 6; i++) {
				await ctx.db.insert(
					"oauth_scope_profiles",
					profile(`g-${i}`, "ghost-org"),
				);
			}
		});
		const [page] = await walk((cursor) =>
			t.mutation(backfill, {
				table: "oauth_scope_profiles",
				cursor,
				unresolvedIdCap: 2,
			}),
		);
		expect(page.unresolved).toBe(6);
		expect(page.unresolvedIds).toHaveLength(2);
	});

	test("(d) a second real run fills 0 and leaves the same rows unresolved", async () => {
		const t = createT();
		await seedMappings(t);
		await seedRows(t);
		const run = () =>
			walk((cursor) =>
				t.mutation(backfill, {
					table: "oauth_scope_profiles",
					dryRun: false,
					cursor,
				}),
			);
		const first = await run();
		const second = await run();
		expect(sum(first, (p) => p.filled)).toBe(1);
		expect(sum(second, (p) => p.filled)).toBe(0);
		expect(sum(second, (p) => p.toFill)).toBe(0);
		expect(sum(second, (p) => p.unresolved)).toBe(4);
	});

	test("(e) never overwrites an existing clerkOrgId, even one that disagrees with the slug", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedRows(t);
		await walk((cursor) =>
			t.mutation(backfill, { table: "tasks", dryRun: false, cursor }),
		);
		await walk((cursor) =>
			t.mutation(backfill, {
				table: "oauth_scope_profiles",
				dryRun: false,
				cursor,
			}),
		);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.keptTask))?.clerkOrgId).toBe("org_OTHER9");
			expect((await ctx.db.get(ids.keptProfile))?.clerkOrgId).toBe("org_ACME1");
		});
	});

	test("rejects an out-of-range pageSize", async () => {
		const t = createT();
		await expect(
			t.mutation(backfill, { table: "tasks", pageSize: 0 }),
		).rejects.toThrow(/out of expected range/);
	});
});

describe("(f) the ID-comparing gate admits a row only after the backfill", () => {
	// Stub of the predicate #1626 puts in assertRowInVerifiedOrg: the row's org is its
	// permanent ID, compared with the ID of the verified org's mapping; a row with no ID
	// matches nobody.
	const admitted = async (
		t: T,
		taskId: Id<"tasks">,
		verifiedSlug: string,
	): Promise<boolean> =>
		await t.run(async (ctx) => {
			const row = await ctx.db.get(taskId);
			const mapping = await lookupOrgMapping(ctx, verifiedSlug);
			if (row === null || mapping === null) return false;
			return sameOrg(orgRefOfRow(row), { id: mapping.clerkOrgId });
		});

	test("refused before the backfill, admitted after; a row of another org is still refused", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedRows(t);
		expect(await admitted(t, ids.okTask, "acme-hr")).toBe(false);
		await walk((cursor) =>
			t.mutation(backfill, { table: "tasks", dryRun: false, cursor }),
		);
		expect(await admitted(t, ids.okTask, "acme-hr")).toBe(true);
		// the row that kept a DIFFERENT ID is not admitted for acme-hr
		expect(await admitted(t, ids.keptTask, "acme-hr")).toBe(false);
		// the unresolvable row stays refused
		expect(await admitted(t, ids.ghostTask, "acme-hr")).toBe(false);
	});
});
