/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, batch F1 (identity by ID, content tables).
//
// DIARY. A diary entry belongs to an AGENT: the row carries the orchestrator's
// `agents` row ID (`agentId`) and every selection and key uses that ID. The label
// a caller types is resolved to an ID in the caller's OWN org; the author filter
// compares the author's ID (`createdById`). A name selects no row.
//
// MEMORIES. The author filter of `memories:listMemories` compares the author's ID
// (`createdById`), and every predicate of the page (the tenant, the type, the
// author) sits in the index range or the query builder BEFORE the bound, so a
// page is never eaten by rows the caller did not ask for (backend standard R-55).
//
// Poles: REFUSED (a label of another org, an unlisted label), ABSENT (nothing to
// read is an empty SUCCESS), PRESENT (the claimed org's own rows), cross-org
// (the same label in another org is another agent).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { memoryPageQuery } from "../memories";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const SERVICE_ACCOUNT = "test-service-account-user-id";
const NOW = 1_780_000_000_000;
const DATE = "2026-10-01";

const OP_SLUG = "fleet-op";
const A_SLUG = "acme-a";
const A_ID = testClerkOrgId(A_SLUG);
const B_SLUG = "acme-b";
const B_ID = testClerkOrgId(B_SLUG);

// A stored memory schedules its RAG indexing; the scheduler is drained under fake
// timers (the RAG module is not part of this harness).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT } as Identity);
const asMember = (t: T, slug: string, subject: string) =>
	t.withIdentity({
		subject,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:member",
	} as Identity);
const claim = (orgSlug: string) => ({ verifiedOrg: { orgSlug } });

type World = { t: T; ids: Record<string, Id<"agents">> };

async function world(): Promise<World> {
	const t = createT();
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
		ids.opPi = await agent(OP_SLUG, testClerkOrgId(OP_SLUG), "pi");
		ids.aSeat = await agent(A_SLUG, A_ID, "seat-x");
		ids.aOther = await agent(A_SLUG, A_ID, "other");
		ids.bSeat = await agent(B_SLUG, B_ID, "seat-x");
		const mapping = (
			slug: string,
			clerkOrgId: string,
			agentIds: Id<"agents">[],
			extra: Record<string, unknown> = {},
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId,
				allowedOrchestrators: [],
				allowedAgentIds: agentIds,
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...extra,
			});
		await mapping(OP_SLUG, testClerkOrgId(OP_SLUG), [ids.opPi], {
			orgKind: "operator",
			fleetWide: true,
		});
		await mapping(A_SLUG, A_ID, [ids.aSeat, ids.aOther]);
		await mapping(B_SLUG, B_ID, [ids.bSeat]);
	});
	return { t, ids };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIARY
// ─────────────────────────────────────────────────────────────────────────────

describe("diary by agent ID", () => {
	test("a renamed agent keeps its entries; the old label names nobody; a new agent that took the label has none", async () => {
		const w = await world();
		await w.t.run(async (ctx) => {
			await ctx.db.insert("diary", {
				date: DATE,
				orchestrator: "seat-x",
				agentId: w.ids.aSeat,
				content: "the veteran's entry",
				createdAt: 1,
				orgId: A_SLUG,
				clerkOrgId: A_ID,
			});
			// The agent is renamed; a NEW agent takes the freed label and is listed.
			await ctx.db.patch(w.ids.aSeat, {
				name: "veteran",
				normalizedName: "veteran",
			});
			const newcomer = await ctx.db.insert("agents", {
				orgSlug: A_SLUG,
				clerkOrgId: A_ID,
				name: "seat-x",
				normalizedName: "seat-x",
				isActive: true,
				createdAt: NOW,
			});
			const mapping = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", A_SLUG))
				.unique();
			await ctx.db.patch(mapping!._id, {
				allowedAgentIds: [w.ids.aSeat, w.ids.aOther, newcomer],
			});
		});
		const svc = asService(w.t);
		const byNewLabel = await svc.query(api.diary.get, {
			date: DATE,
			orchestrator: "veteran",
			...claim(A_SLUG),
		});
		expect(byNewLabel?.content).toBe("the veteran's entry");
		// The freed label now names the newcomer: it has no entry that day.
		expect(
			await svc.query(api.diary.get, {
				date: DATE,
				orchestrator: "seat-x",
				...claim(A_SLUG),
			}),
		).toBeNull();
		expect(
			await svc.query(api.diary.list, {
				orchestrator: "seat-x",
				...claim(A_SLUG),
			}),
		).toEqual([]);
	});

	test("a legacy row with no agent ID is served to nobody by an ID read, and an upsert writes a fresh row beside it", async () => {
		const w = await world();
		const legacy = await w.t.run(async (ctx) =>
			ctx.db.insert("diary", {
				date: DATE,
				orchestrator: "seat-x",
				content: "legacy entry",
				createdAt: 1,
				orgId: A_SLUG,
				clerkOrgId: A_ID,
			}),
		);
		const svc = asService(w.t);
		expect(
			await svc.query(api.diary.get, {
				date: DATE,
				orchestrator: "seat-x",
				...claim(A_SLUG),
			}),
		).toBeNull();
		const written = await svc.mutation(api.diary.write, {
			date: DATE,
			orchestrator: "seat-x",
			content: "fresh entry",
			createdBy: "seat-x",
			...claim(A_SLUG),
		});
		expect(written).not.toBe(legacy);
		const legacyRow = await w.t.run(async (ctx) => ctx.db.get(legacy));
		expect(legacyRow?.content).toBe("legacy entry");
	});

	test("the author filter compares the author's ID: PRESENT own, ABSENT unknown label, cross-org label is another agent", async () => {
		const w = await world();
		await w.t.run(async (ctx) => {
			const row = (
				content: string,
				agentId: Id<"agents">,
				createdById: Id<"agents">,
				slug: string,
				orgId: string,
				date: string,
			) =>
				ctx.db.insert("diary", {
					date,
					orchestrator: "seat-x",
					agentId,
					content,
					createdAt: 1,
					createdBy: "x",
					createdById,
					orgId: slug,
					clerkOrgId: orgId,
				});
			await row("by seat", w.ids.aSeat, w.ids.aSeat, A_SLUG, A_ID, "2026-10-01");
			await row("by other", w.ids.aSeat, w.ids.aOther, A_SLUG, A_ID, "2026-10-02");
			await row("b's", w.ids.bSeat, w.ids.bSeat, B_SLUG, B_ID, "2026-10-01");
		});
		const svc = asService(w.t);
		const bySeat = (await svc.query(api.diary.list, {
			createdBy: "seat-x",
			...claim(A_SLUG),
		})) as { content: string }[];
		expect(bySeat.map((r) => r.content)).toEqual(["by seat"]);
		const byOther = (await svc.query(api.diary.list, {
			createdBy: "other",
			...claim(A_SLUG),
		})) as { content: string }[];
		expect(byOther.map((r) => r.content)).toEqual(["by other"]);
		// ABSENT: a label that names no agent of the org matches no row: empty SUCCESS.
		expect(
			await svc.query(api.diary.list, { createdBy: "ghost", ...claim(A_SLUG) }),
		).toEqual([]);
		// Cross-org: "seat-x" in org B is org B's agent, and org A's rows are not its own.
		const forB = (await svc.query(api.diary.list, {
			createdBy: "seat-x",
			...claim(B_SLUG),
		})) as { content: string }[];
		expect(forB.map((r) => r.content)).toEqual(["b's"]);
	});

	test("the author filter and the cursor sit before the bound: a page is full though newer rows are not the caller's ask", async () => {
		const w = await world();
		await w.t.run(async (ctx) => {
			// 2 old entries by the author asked for, then 30 newer ones by another.
			for (let i = 0; i < 2; i++) {
				await ctx.db.insert("diary", {
					date: `2026-01-0${i + 1}`,
					orchestrator: "seat-x",
					agentId: w.ids.aSeat,
					content: `wanted ${i}`,
					createdAt: 1,
					createdBy: "seat-x",
					createdById: w.ids.aSeat,
					orgId: A_SLUG,
					clerkOrgId: A_ID,
				});
			}
			for (let i = 0; i < 30; i++) {
				await ctx.db.insert("diary", {
					date: `2026-02-${String((i % 28) + 1).padStart(2, "0")}`,
					orchestrator: "seat-x",
					agentId: w.ids.aSeat,
					content: `noise ${i}`,
					createdAt: 2,
					createdBy: "other",
					createdById: w.ids.aOther,
					orgId: A_SLUG,
					clerkOrgId: A_ID,
				});
			}
		});
		const page = (await asService(w.t).query(api.diary.list, {
			orchestrator: "seat-x",
			createdBy: "seat-x",
			limit: 2,
			...claim(A_SLUG),
		})) as { content: string }[];
		expect(page.map((r) => r.content).sort()).toEqual(["wanted 0", "wanted 1"]);
	});

	test("a member's write is stamped with its verified subject as author and the author's ID", async () => {
		const w = await world();
		const id = await asMember(w.t, A_SLUG, "member-1").mutation(api.diary.write, {
			date: DATE,
			orchestrator: "seat-x",
			content: "by a person",
		});
		const row = await w.t.run(async (ctx) => ctx.db.get(id));
		expect(row).toMatchObject({
			createdBy: "user:member-1",
			createdById: "user:member-1",
			agentId: w.ids.aSeat,
		});
		await expect(
			asMember(w.t, A_SLUG, "member-1").mutation(api.diary.write, {
				date: "2026-10-02",
				orchestrator: "seat-x",
				content: "forged",
				createdBy: "user:someone-else",
			}),
		).rejects.toThrow(/author-not-caller/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MEMORIES
// ─────────────────────────────────────────────────────────────────────────────

async function seedRows(
	w: World,
	rows: Array<{
		namespace: string;
		content: string;
		clerkOrgId?: string;
		createdBy: string;
		createdById?: string;
		type?: "project" | "user";
	}>,
): Promise<void> {
	await w.t.run(async (ctx) => {
		for (const r of rows) {
			await ctx.db.insert("memories", {
				namespace: r.namespace,
				type: r.type ?? "project",
				content: r.content,
				createdBy: r.createdBy,
				...(r.createdById === undefined ? {} : { createdById: r.createdById }),
				relations: [],
				isLatest: true,
				...(r.clerkOrgId === undefined ? {} : { clerkOrgId: r.clerkOrgId }),
				createdAt: 1,
				updatedAt: 1,
			});
		}
	});
}

describe("memories listed by ID, before the bound", () => {
	test("the author filter compares the author's ID and a page is full though newer rows are by another author", async () => {
		const w = await world();
		const ns = `team/${A_ID}`;
		await seedRows(w, [
			{ namespace: ns, content: "wanted 1", clerkOrgId: A_ID, createdBy: "seat-x", createdById: w.ids.aSeat },
			{ namespace: ns, content: "wanted 2", clerkOrgId: A_ID, createdBy: "seat-x", createdById: w.ids.aSeat },
			...Array.from({ length: 30 }, (_, i) => ({
				namespace: ns,
				content: `noise ${i}`,
				clerkOrgId: A_ID,
				createdBy: "other",
				createdById: w.ids.aOther,
			})),
		]);
		const svc = asService(w.t);
		const page = await svc.query(api.memories.listMemories, {
			namespace: ns,
			createdBy: "seat-x",
			limit: 5,
			...claim(A_SLUG),
		});
		expect(page.value.map((r) => r.content).sort()).toEqual(["wanted 1", "wanted 2"]);
		// ABSENT: a label that names no agent of the org is an empty page, not an error.
		const none = await svc.query(api.memories.listMemories, {
			namespace: ns,
			createdBy: "ghost",
			...claim(A_SLUG),
		});
		expect(none).toEqual({ value: [], continueCursor: null, isDone: true });
		// Paginated path: same predicate, same page.
		const paged = await svc.query(api.memories.listMemories, {
			namespace: ns,
			createdBy: "seat-x",
			paginationOpts: { numItems: 2, cursor: null },
			...claim(A_SLUG),
		});
		expect(paged.value).toHaveLength(2);
	});

	test("the tenant is an index predicate: another org's rows in a shared legacy namespace never eat the member's page", async () => {
		const w = await world();
		// The legacy label namespace of org A; org B (which once held the label)
		// left 20 NEWER rows there.
		const ns = `team/${A_SLUG}`;
		await seedRows(w, [
			{ namespace: ns, content: "a1", clerkOrgId: A_ID, createdBy: "seat-x" },
			{ namespace: ns, content: "a2", clerkOrgId: A_ID, createdBy: "seat-x" },
			{ namespace: ns, content: "a3", clerkOrgId: A_ID, createdBy: "seat-x" },
			...Array.from({ length: 20 }, (_, i) => ({
				namespace: ns,
				content: `b ${i}`,
				clerkOrgId: B_ID,
				createdBy: "seat-x",
			})),
		]);
		const page = await asService(w.t).query(api.memories.listMemories, {
			namespace: ns,
			limit: 3,
			...claim(A_SLUG),
		});
		expect(page.value.map((r) => r.content).sort()).toEqual(["a1", "a2", "a3"]);
	});

	test("a type filter and a member's tenant range compose in the query builder", async () => {
		const w = await world();
		const ns = `team/${A_ID}`;
		await seedRows(w, [
			{ namespace: ns, content: "project row", clerkOrgId: A_ID, createdBy: "seat-x", type: "project" },
			{ namespace: ns, content: "user row", clerkOrgId: A_ID, createdBy: "seat-x", type: "user" },
		]);
		const page = await asService(w.t).query(api.memories.listMemories, {
			namespace: ns,
			type: "user",
			...claim(A_SLUG),
		});
		expect(page.value.map((r) => r.content)).toEqual(["user row"]);
	});

	test("a person's memory carries the verified subject as the author ID and is found by it", async () => {
		const w = await world();
		const member = asMember(w.t, A_SLUG, "member-9");
		const id = await member.mutation(api.memories.storeMemory, {
			namespace: `team/${A_ID}`,
			type: "project",
			content: "person memory",
		});
		await w.t.finishAllScheduledFunctions(vi.runAllTimers);
		const row = await w.t.run(async (ctx) => ctx.db.get(id));
		expect(row).toMatchObject({
			createdBy: "user:member-9",
			createdById: "user:member-9",
			clerkOrgId: A_ID,
		});
		const page = await member.query(api.memories.listMemories, {
			namespace: `team/${A_ID}`,
			createdBy: "user:member-9",
		});
		expect(page.value.map((r) => r.content)).toEqual(["person memory"]);
	});

	test("REFUSED: a scope that is not the fleet's and carries no org ID owns no range (never read as the fleet's)", async () => {
		const w = await world();
		await seedRows(w, [
			{ namespace: `team/${A_ID}`, content: "a", clerkOrgId: A_ID, createdBy: "seat-x" },
		]);
		await expect(
			w.t.run(async (ctx) =>
				memoryPageQuery(
					ctx,
					{ isMaster: false, fleetWide: false, orgClerkId: undefined },
					{
						namespace: `team/${A_ID}`,
						type: undefined,
						latestOnly: true,
						createdById: undefined,
					},
				).take(5),
			),
		).rejects.toThrow(/org-id-missing/);
	});
});
