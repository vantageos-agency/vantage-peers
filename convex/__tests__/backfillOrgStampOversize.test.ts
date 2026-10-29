/// <reference types="vite/client" />
//
// backfill_org_stamp — oversize rows (task k17b1p18fy59p4z96wedb54f7s8h68t2).
// Prod, briefingNotes: a page of large notes exceeded the 16 MiB read cap, and a
// note already near the 1 MiB document limit could not take the two stamp
// fields, so the walk could never pass it. Pi ruling: an oversize row is
// EXEMPTED and LISTED, never trimmed.

import type { FunctionReturnType } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import schema from "../schema";

const lookupSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../lib/authOrgMapping", async (importOriginal) => {
	const real = await importOriginal<typeof import("../lib/authOrgMapping")>();
	return {
		...real,
		lookupOrgMapping: (...a: Parameters<typeof real.lookupOrgMapping>) => {
			lookupSpy.calls++;
			return real.lookupOrgMapping(...a);
		},
	};
});

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);
const run = internal.migrations.backfill_org_stamp.run;
const NOW = 1_700_000_000_000;
const createT = () => convexTest({ schema, modules });
type T = ReturnType<typeof createT>;

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "fleet-org",
			clerkOrgId: testClerkOrgId("fleet-org"),
			allowedOrchestrators: [],
			scopes: [],
			displayName: "fleet-org",
			isActive: true,
			createdAt: NOW,
			orgKind: "operator" as const,
		});
		await ctx.db.insert("agents", {
			orgSlug: "fleet-org",
			clerkOrgId: testClerkOrgId("fleet-org"),
			name: "sigma",
			normalizedName: "sigma",
			isActive: true,
			createdAt: NOW,
		});
	});
}

async function note(t: T, title: string, size: number) {
	return await t.run(async (ctx) =>
		ctx.db.insert("briefingNotes", {
			title,
			topic: "t",
			participants: [],
			content: "x".repeat(size),
			createdBy: "sigma",
			createdAt: NOW,
		}),
	);
}

type Result = FunctionReturnType<typeof run>;

async function walkNotes(t: T, dryRun: boolean, pageSize?: number) {
	let cursor: string | null = null;
	const pages: Result[] = [];
	for (let guard = 0; guard < 100; guard++) {
		const r: Result = await t.mutation(run, {
			table: "briefingNotes",
			dryRun,
			cursor,
			pageSize,
		});
		pages.push(r);
		if (r.isDone) return pages;
		cursor = r.nextCursor;
	}
	throw new Error("walk did not terminate");
}

const orgOf = (t: T, id: Awaited<ReturnType<typeof note>>) =>
	t.run(async (ctx) => (await ctx.db.get(id))?.orgId ?? null);

describe("backfill_org_stamp oversize row", () => {
	test("backfill_org_stamp oversize row: real run stamps the normal notes, skips and lists the oversize one", async () => {
		const t = createT();
		await seedOrgs(t);
		const a = await note(t, "a", 1_000);
		const big = await note(t, "big", 1_040_000);
		const b = await note(t, "b", 1_000);
		const pages = await walkNotes(t, false);
		expect(await orgOf(t, a)).toBe("fleet-org");
		expect(await orgOf(t, b)).toBe("fleet-org");
		expect(await orgOf(t, big)).toBeNull();
		const ids = pages.flatMap((p) => p.oversizeIds);
		expect(ids).toEqual([big]);
		expect(pages.reduce((n, p) => n + p.oversize, 0)).toBe(1);
		expect(pages.reduce((n, p) => n + p.stamped, 0)).toBe(2);
		expect(pages[pages.length - 1].isDone).toBe(true);
	});

	test("backfill_org_stamp oversize row: dry run lists the same ids and writes nothing", async () => {
		const t = createT();
		await seedOrgs(t);
		const a = await note(t, "a", 1_000);
		const big = await note(t, "big", 1_040_000);
		const pages = await walkNotes(t, true);
		expect(pages.flatMap((p) => p.oversizeIds)).toEqual([big]);
		expect(pages.reduce((n, p) => n + p.stamped, 0)).toBe(0);
		expect(await orgOf(t, a)).toBeNull();
		expect(await orgOf(t, big)).toBeNull();
	});

	test("backfill_org_stamp oversize row: a page of large notes is bounded by bytes, the cursor skips no row", async () => {
		const t = createT();
		await seedOrgs(t);
		const ids = [];
		for (let i = 0; i < 14; i++) ids.push(await note(t, `n${i}`, 700_000));
		const pages = await walkNotes(t, false, 20);
		expect(pages.length).toBeGreaterThan(1);
		expect(pages[0].isDone).toBe(false);
		expect(pages[0].examined).toBeLessThan(14);
		expect(pages.reduce((n, p) => n + p.examined, 0)).toBe(14);
		for (const id of ids) expect(await orgOf(t, id)).toBe("fleet-org");
	});

	test("backfill_org_stamp oversize row: the org mapping is read once per page, not once per stamped row", async () => {
		const reads = async (n: number) => {
			const t = createT();
			await seedOrgs(t);
			for (let i = 0; i < n; i++) await note(t, `n${i}`, 100);
			lookupSpy.calls = 0;
			await walkNotes(t, false, 20);
			return lookupSpy.calls;
		};
		const one = await reads(1);
		const six = await reads(6);
		expect(six).toBe(one);
	});
});
