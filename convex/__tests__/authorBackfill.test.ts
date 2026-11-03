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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api, internal } from "../_generated/api";
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

	test("an empty derived set throws instead of reporting a clean one", () => {
		expect(() => authoredTables({})).toThrow(/yields no authored table/);
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

// ── stamp: the legacy row becomes erasable by its author, and by nobody else ───────────────
//
// POLES (erase:eraseRow under a seat's verified agent, the fleet service account only being
// the transport):
//   BEFORE   a legacy row (no createdById) is refused to the agent that wrote it
//   AFTER    the same row, once stamped, is served to that agent
//   OTHER    another agent of the same organisation is still refused
//   OTHER ORG a label that names an agent of ANOTHER organisation is never stamped
//   AMBIGUOUS a label that names two active agents of the organisation is never stamped
//   DRY RUN  writes nothing (the default); a second real run stamps 0 (idempotent)

describe("authorBackfill:stamp and erase:eraseRow", () => {
	const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const service = () => t.withIdentity({ subject: SERVICE });
	const eraseAs = async (org: string, orgId: string, agent: string, rowId: string) => {
		try {
			await service().mutation(api.erase.eraseRow, {
				table: "memories",
				rowId,
				__actingOrg: orgId,
				verifiedActor: { agentId: agents[`${org}/${agent}`], orgSlug: org },
			} as never);
			return "SERVED";
		} catch (e) {
			const text = e instanceof ConvexError ? String(e.data) : String(e);
			return /([A-Z][A-Z_]{3,}):/.exec(text)?.[1] ?? `OTHER(${text.slice(0, 120)})`;
		}
	};
	const stamp = (args: Record<string, unknown>) =>
		t.mutation(internal.migrations.authorBackfill.stamp, args as never);
	const stored = (id: string) => t.run((ctx) => ctx.db.get(id as Id<"memories">));

	test("BEFORE / AFTER / OTHER: refused before the stamp, served to the author after, still refused to a colleague", async () => {
		const row = await memoryRow(A_ID, "alice");
		const colleagueRow = await memoryRow(A_ID, "alice");
		expect(await eraseAs(A, A_ID, "alice", row)).toBe("RBAC_DENIED");
		const run = await stamp({ table: "memories", dryRun: false });
		expect(run).toMatchObject({ stamped: 2, resolvable: 2, dryRun: false });
		expect((await stored(row))?.createdById).toBe(agents[`${A}/alice`]);
		expect(await eraseAs(A, A_ID, "carol", colleagueRow)).toBe("RBAC_DENIED");
		expect(await stored(colleagueRow)).not.toBeNull();
		expect(await eraseAs(A, A_ID, "alice", row)).toBe("SERVED");
		expect(await stored(row)).toBeNull();
	});

	test("OTHER ORG: a label that names an agent of another organisation is never stamped", async () => {
		const row = await memoryRow(A_ID, "bob");
		const r = await stamp({ table: "memories", dryRun: false });
		expect(r).toMatchObject({ stamped: 0, unresolvable: 1 });
		expect((await stored(row))?.createdById).toBeUndefined();
		expect(await eraseAs(B, B_ID, "bob", row)).toBe("RBAC_DENIED");
	});

	test("AMBIGUOUS: a label carried by two active agents of the organisation is never stamped", async () => {
		await t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: A,
				clerkOrgId: A_ID,
				name: "ALICE",
				normalizedName: "alice",
				isActive: true,
				createdAt: 1,
			}),
		);
		const row = await memoryRow(A_ID, "alice");
		const r = await stamp({ table: "memories", dryRun: false });
		expect(r).toMatchObject({ stamped: 0, ambiguous: 1 });
		expect((await stored(row))?.createdById).toBeUndefined();
		expect(await eraseAs(A, A_ID, "alice", row)).toBe("RBAC_DENIED");
	});

	test("DRY RUN is the default and writes nothing; the real run is idempotent", async () => {
		const row = await memoryRow(A_ID, "alice");
		const dry = await stamp({ table: "memories" });
		expect(dry).toMatchObject({ dryRun: true, resolvable: 1, stamped: 0 });
		expect((await stored(row))?.createdById).toBeUndefined();
		const first = await stamp({ table: "memories", dryRun: false });
		expect(first.stamped).toBe(1);
		const second = await stamp({ table: "memories", dryRun: false });
		expect(second).toMatchObject({ stamped: 0, withAuthorId: 1, resolvable: 0 });
		expect((await stored(row))?.createdById).toBe(agents[`${A}/alice`]);
	});

	test("a person-labelled row and a row that already has an author ID are never rewritten", async () => {
		const person = await memoryRow(A_ID, "user:user_p1");
		const owned = await memoryRow(A_ID, "alice", agents[`${A}/carol`]);
		const r = await stamp({ table: "memories", dryRun: false });
		expect(r).toMatchObject({ stamped: 0, personLabelled: 1, withAuthorId: 1 });
		expect((await stored(person))?.createdById).toBeUndefined();
		expect((await stored(owned))?.createdById).toBe(agents[`${A}/carol`]);
	});

	test("messages are stamped on fromId", async () => {
		const id = await messageRow(B_ID, "bob");
		const r = await stamp({ table: "messages", dryRun: false });
		expect(r).toMatchObject({ table: "messages", stamped: 1 });
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.fromId).toBe(agents[`${B}/bob`]);
	});

	test("refuses a table that is not authored", async () => {
		await expect(stamp({ table: "issues", dryRun: false })).rejects.toBeInstanceOf(ConvexError);
	});
});
