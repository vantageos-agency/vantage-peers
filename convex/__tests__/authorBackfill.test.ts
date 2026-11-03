/// <reference types="vite/client" />
//
// migrations/authorBackfill — the rows written before the author ID was stored. Task
// k175zndttv4brzgwj529qgsr1h8hha22.
//
// COUNT (read-only): per authored erase table, how many rows have an author ID, and among
// those without one how many an agent label ties to EXACTLY ONE active agent of the row's own
// organisation (resolvable), to several (ambiguous), to none or to an agent of ANOTHER
// organisation or to a retired agent (unresolvable), or to a person (personLabelled).

import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ERASE_COVERED } from "../lib/eraseRow";
import { authoredTables } from "../migrations/authorBackfill";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const A = "backfill-org-a";
const B = "backfill-org-b";
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);

let t: T;
let agents: Record<string, Id<"agents">>;

beforeEach(async () => {
	t = createT();
	await t.run(async (ctx) => {
		// the fleet resolver (backfill_actor_ids) requires exactly one active operator org
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "backfill-operator",
			clerkOrgId: testClerkOrgId("backfill-operator"),
			allowedOrchestrators: [],
			scopes: ["vantage:read", "vantage:write"],
			displayName: "operator",
			isActive: true,
			orgKind: "operator",
			createdAt: 1,
		});
		for (const [slug, roster] of [
			[A, ["alice", "carol"]],
			[B, ["bob"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...roster],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	agents = await seedRosterAgents(t);
});

const memoryRow = (org: string, createdBy: string, createdById?: string) =>
	t.run((ctx) =>
		ctx.db.insert("memories", {
			namespace: `team/${org}`,
			clerkOrgId: org,
			type: "reference",
			content: "legacy",
			createdBy,
			...(createdById === undefined ? {} : { createdById }),
			relations: [],
			isLatest: true,
			createdAt: 1,
			updatedAt: 1,
		}),
	);

const messageRow = (org: string, from: string, fromId?: string) =>
	t.run((ctx) =>
		ctx.db.insert("messages", {
			from,
			...(fromId === undefined ? {} : { fromId }),
			channel: "someone",
			content: "legacy",
			tenantId: org,
			tenantOrgId: org,
			createdAt: 1,
		}),
	);

const count = (table: string, extra: Record<string, unknown> = {}) =>
	t.query(internal.migrations.authorBackfill.count, { table, ...extra } as never);

describe("authorBackfill:count", () => {
	test("the table list is derived from the erase policy, not typed", () => {
		const derived = authoredTables().map((d) => d.table);
		const expected = Object.entries(ERASE_COVERED)
			.filter(([, p]) => p.authorField !== null && p.labelField !== null)
			.map(([table]) => table);
		expect(derived).toEqual(expected);
		expect(derived).toContain("memories");
		expect(derived).toContain("messages");
		expect(derived).not.toContain("issues");
	});

	test("classifies every row of a table into disjoint classes that sum", async () => {
		const alice = agents[`${A}/alice`];
		await memoryRow(A_ID, "alice", alice); // has an author ID
		await memoryRow(A_ID, "alice"); // resolvable
		await memoryRow(A_ID, "Alice "); // resolvable (normalised label)
		await memoryRow(A_ID, "user:user_p1"); // personLabelled
		await memoryRow(A_ID, "nobody"); // unresolvable: no such agent
		await memoryRow(A_ID, "bob"); // unresolvable: bob is an agent of the OTHER org
		const dup = await t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: A,
				clerkOrgId: A_ID,
				name: "ALICE",
				normalizedName: "alice",
				isActive: true,
				createdAt: 1,
			}),
		);
		expect(dup).toBeTruthy();
		await memoryRow(A_ID, "carol"); // resolvable (carol is unique)
		const r = await count("memories");
		expect(r).toMatchObject({
			table: "memories",
			examined: 7,
			withAuthorId: 1,
			withoutAuthorId: 6,
			resolvable: 1,
			ambiguous: 2,
			unresolvable: 2,
			personLabelled: 1,
			isDone: true,
		});
		expect(r.resolvable + r.ambiguous + r.unresolvable + r.personLabelled).toBe(
			r.withoutAuthorId,
		);
		expect(r.withAuthorId + r.withoutAuthorId).toBe(r.examined);
	});

	test("a retired agent does not count; a row with no org ID is unresolvable", async () => {
		await t.run((ctx) => ctx.db.patch(agents[`${A}/carol`], { isActive: false }));
		await memoryRow(A_ID, "carol");
		await t.run((ctx) =>
			ctx.db.insert("memories", {
				namespace: "team/none",
				type: "reference",
				content: "no org",
				createdBy: "alice",
				relations: [],
				isLatest: true,
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		const r = await count("memories");
		expect(r).toMatchObject({ examined: 2, withoutAuthorId: 2, unresolvable: 2, resolvable: 0 });
	});

	test("messages are read through tenantOrgId / from / fromId", async () => {
		await messageRow(B_ID, "bob"); // resolvable in B
		await messageRow(A_ID, "bob"); // unresolvable: bob is not in A
		await messageRow(A_ID, "alice", agents[`${A}/alice`]); // has an author ID
		const r = await count("messages");
		expect(r).toMatchObject({
			table: "messages",
			examined: 3,
			withAuthorId: 1,
			resolvable: 1,
			unresolvable: 1,
		});
	});

	test("paginates by cursor; pages sum to the table", async () => {
		for (let i = 0; i < 5; i++) await memoryRow(A_ID, "alice");
		const first = await count("memories", { limit: 2 });
		expect(first.examined).toBe(2);
		expect(first.isDone).toBe(false);
		expect(first.continueCursor).not.toBeNull();
		let seen = first.examined;
		let cursor = first.continueCursor;
		let guard = 0;
		while (cursor !== null && guard++ < 10) {
			const page = await count("memories", { limit: 2, cursor });
			seen += page.examined;
			cursor = page.continueCursor;
			if (page.isDone) break;
		}
		expect(seen).toBe(5);
	});

	test("returns numbers only: no row content, label or id leaves the door", async () => {
		await memoryRow(A_ID, "alice");
		const r = await count("memories");
		for (const [key, value] of Object.entries(r)) {
			expect(["string", "number", "boolean"].includes(typeof value) || value === null).toBe(true);
			expect(["table", "continueCursor"].includes(key) || typeof value !== "string").toBe(true);
		}
		expect(JSON.stringify(r)).not.toContain("alice");
	});

	test("refuses a table that is not authored, a bad limit, and a missing table", async () => {
		for (const bad of [{ table: "issues" }, { table: "agents" }, { table: "memories", limit: 0 }]) {
			await expect(
				t.query(internal.migrations.authorBackfill.count, bad as never),
			).rejects.toBeInstanceOf(ConvexError);
		}
		await expect(
			t.query(internal.migrations.authorBackfill.count, {} as never),
		).rejects.toThrow();
	});

	test("writes nothing", async () => {
		const id = await memoryRow(A_ID, "alice");
		await count("memories");
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.createdById).toBeUndefined();
	});
});
