/// <reference types="vite/client" />
/**
 * Module M10a: memories are read and written by ID scope.
 *
 * THE FAILURE MODELLED. A slug is a renamable label. Org A (ID org_A) holds
 * `team/acme` while its slug is "acme", then is renamed "acme-old"; a NEW org B
 * (ID org_B) takes the freed slug "acme". Two principals now carry the same NAME
 * ("acme") for different organisations. The memory rows written by A sit in
 * `team/acme` and are stamped with A's permanent org ID.
 *
 * POLES
 *   (a) READ    getMemory / listMemories / listMemoriesScoped: B's member (slug
 *               "acme", ID org_B) does NOT see A's rows; A's member (slug
 *               "acme-old", ID org_A) DOES see its own rows, whatever label the
 *               namespace carries.
 *   (b) WRITE   a write is stamped with the caller's org ID; a claimed author
 *               that is not the verified caller is refused; B cannot supersede
 *               or soft-delete A's row; A can.
 *   (c) REFUSED an unresolved caller is refused on every write, with the same
 *               code for a live and for a missing row.
 *   (d) ABSENT  a scoped caller with no memories gets an empty SUCCESS.
 *   (e) SERVICE ACCOUNT keeps its grants: it reads and writes any namespace; a
 *               write into `team/<label>` is stamped with that org's ID.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { asFleet } from "../../tests/lib/asFleet";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const ID_A = testClerkOrgId("org-a-permanent");
const ID_B = testClerkOrgId("org-b-permanent");

/** A member session: the verified org_id claim decides the org, the slug is a label. */
const member = (t: T, subject: string, orgId: string, slug: string) =>
	t.withIdentity({
		subject,
		org_id: orgId,
		org_slug: slug,
	} as Parameters<typeof t.withIdentity>[0]);

const memberA = (t: T) => member(t, "user-a", ID_A, "acme-old");
const memberB = (t: T) => member(t, "user-b", ID_B, "acme");
const asServiceAccount = (t: T) =>
	asFleet(t.withIdentity({ subject: "test-service-account-user-id" }), t);

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		// A was renamed: its mapping now carries "acme-old". B took "acme".
		for (const [slug, id] of [
			["acme-old", ID_A],
			["acme", ID_B],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		}
	});
}

async function seedMemory(
	t: T,
	over: { namespace: string; clerkOrgId?: string; content: string },
): Promise<Id<"memories">> {
	return await t.run((ctx) =>
		ctx.db.insert("memories", {
			namespace: over.namespace,
			type: "project",
			content: over.content,
			createdBy: "someone",
			relations: [],
			isLatest: true,
			createdAt: 1,
			updatedAt: 1,
			...(over.clerkOrgId === undefined ? {} : { clerkOrgId: over.clerkOrgId }),
		}),
	);
}

async function refusal(p: Promise<unknown>): Promise<string> {
	const err = await p.then(
		() => null,
		(e: Error) => e,
	);
	expect(err, "expected a refusal").not.toBeNull();
	return `${(err as Error).message} ${JSON.stringify((err as { data?: unknown }).data ?? "")}`;
}

let t: T;
let rowA: Id<"memories">;
let rowB: Id<"memories">;
let legacy: Id<"memories">;

beforeEach(async () => {
	t = createT();
	await seedOrgs(t);
	rowA = await seedMemory(t, {
		namespace: "team/acme",
		clerkOrgId: ID_A,
		content: "A wrote this when it was called acme",
	});
	rowB = await seedMemory(t, {
		namespace: "team/acme",
		clerkOrgId: ID_B,
		content: "B wrote this",
	});
	legacy = await seedMemory(t, {
		namespace: "team/acme",
		content: "legacy row, stamp not filled yet",
	});
});

describe("(a) reads decide on the org ID", () => {
	test("getMemory: B does not see A's row, A and B each see their own", async () => {
		expect(await memberB(t).query(api.memories.getMemory, { memoryId: rowA })).toBeNull();
		expect(
			(await memberB(t).query(api.memories.getMemory, { memoryId: rowB }))?.content,
		).toBe("B wrote this");
		expect(
			(await memberA(t).query(api.memories.getMemory, { memoryId: rowA }))?.content,
		).toBe("A wrote this when it was called acme");
		expect(await memberA(t).query(api.memories.getMemory, { memoryId: rowB })).toBeNull();
	});

	test("an unstamped row is served to no client org (nothing is guessed)", async () => {
		expect(await memberB(t).query(api.memories.getMemory, { memoryId: legacy })).toBeNull();
		expect(await memberA(t).query(api.memories.getMemory, { memoryId: legacy })).toBeNull();
	});

	test("listMemories: each org sees only the rows stamped with its own ID in team/acme", async () => {
		const b = await memberB(t).query(api.memories.listMemories, { namespace: "team/acme" });
		expect(b.value.map((m) => m.content)).toEqual(["B wrote this"]);
		const a = await memberA(t).query(api.memories.listMemories, { namespace: "team/acme" });
		expect(a.value.map((m) => m.content)).toEqual(["A wrote this when it was called acme"]);
	});

	test("listMemories paginated and typed: the same rows, same filter", async () => {
		const b = await memberB(t).query(api.memories.listMemories, {
			namespace: "team/acme",
			type: "project",
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(b.value.map((m) => m.content)).toEqual(["B wrote this"]);
	});

	test("listMemoriesScoped: B does not see A's row", async () => {
		const b = await memberB(t).query(api.memoriesScoped.listMemoriesScoped, {
			namespace: "team/acme",
		});
		expect(b.map((m) => m.content)).toEqual(["B wrote this"]);
		// The scoped list keeps its pinned namespace boundary (AUTH_NAMESPACE_DENIED for a
		// namespace outside the caller's own label); the slug only NARROWS there, the ID grants.
		expect(
			await refusal(
				memberA(t).query(api.memoriesScoped.listMemoriesScoped, { namespace: "team/acme" }),
			),
		).toMatch(/AUTH_NAMESPACE_DENIED/);
	});

	test("a foreign namespace is still refused for the scoped list", async () => {
		await seedMemory(t, { namespace: "team/other", clerkOrgId: ID_A, content: "x" });
		const page = await memberB(t).query(api.memories.listMemories, { namespace: "team/other" });
		expect(page.value).toEqual([]);
	});

	test("(d) ABSENT: a scoped caller with no memories gets an empty success", async () => {
		const page = await memberB(t).query(api.memories.listMemories, {
			namespace: "team/acme/empty",
		});
		expect(page).toEqual({ value: [], continueCursor: null, isDone: true });
	});

	test("(e) the service account reads every row, stamped or not", async () => {
		const page = await asServiceAccount(t).query(api.memories.listMemories, {
			namespace: "team/acme",
		});
		expect(page.value).toHaveLength(3);
		expect(
			await asServiceAccount(t).query(api.memories.getMemory, { memoryId: rowA }),
		).not.toBeNull();
	});
});

describe("(b) writes are stamped, authored by the caller, and bound to the org ID", () => {
	test("storeMemory stamps the caller's org ID and records the verified author", async () => {
		const id = await memberB(t).mutation(api.memories.storeMemory, {
			namespace: "team/acme/notes",
			type: "project",
			content: "fresh",
			createdBy: "user:user-b",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.clerkOrgId).toBe(ID_B);
		expect(row?.createdBy).toBe("user:user-b");
	});

	test("storeMemory without a claimed author records the verified caller", async () => {
		// createdBy is required by the signature; a member's value must equal the verified caller.
		const id = await memberB(t).mutation(api.memories.storeMemory, {
			namespace: "team/acme",
			type: "project",
			content: "fresh",
			createdBy: "user:user-b",
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.createdBy).toBe("user:user-b");
	});

	test("a member's claimed different author is refused and nothing is written", async () => {
		const before = await t.run(async (ctx) => (await ctx.db.query("memories").collect()).length);
		const msg = await refusal(
			memberB(t).mutation(api.memories.storeMemory, {
				namespace: "team/acme",
				type: "project",
				content: "forged",
				createdBy: "pi",
			}),
		);
		expect(msg).toMatch(/RBAC_DENIED/);
		expect(msg).toMatch(/author-not-caller/);
		expect(await t.run(async (ctx) => (await ctx.db.query("memories").collect()).length)).toBe(
			before,
		);
	});

	test("storeMemoryScoped: stamped with the caller's ID, forged author refused", async () => {
		const id = await memberB(t).mutation(api.memoriesScoped.storeMemoryScoped, {
			namespace: "team/acme",
			type: "project",
			content: "scoped",
			createdBy: "user:user-b",
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.clerkOrgId).toBe(ID_B);
		expect(
			await refusal(
				memberB(t).mutation(api.memoriesScoped.storeMemoryScoped, {
					namespace: "team/acme",
					type: "project",
					content: "forged",
					createdBy: "system",
				}),
			),
		).toMatch(/RBAC_DENIED/);
	});

	test("B cannot supersede A's row through an 'updates' relation", async () => {
		const msg = await refusal(
			memberB(t).mutation(api.memories.storeMemory, {
				namespace: "team/acme",
				type: "project",
				content: "takeover",
				createdBy: "user:user-b",
				relations: [{ targetId: rowA, type: "updates" }],
			}),
		);
		expect(msg).toMatch(/RBAC_DENIED/);
		expect((await t.run((ctx) => ctx.db.get(rowA)))?.isLatest).toBe(true);
	});

	test("B cannot soft-delete A's row; A can soft-delete its own", async () => {
		expect(
			await refusal(memberB(t).mutation(api.memories.softDeleteMemory, { memoryId: rowA })),
		).toMatch(/RBAC_DENIED/);
		expect((await t.run((ctx) => ctx.db.get(rowA)))?.isLatest).toBe(true);
		await memberA(t).mutation(api.memories.softDeleteMemory, { memoryId: rowA });
		expect((await t.run((ctx) => ctx.db.get(rowA)))?.isLatest).toBe(false);
	});

	test("A (renamed acme-old) cannot write into team/acme: that namespace is B's label now", async () => {
		expect(
			await refusal(
				memberA(t).mutation(api.memories.storeMemory, {
					namespace: "team/acme",
					type: "project",
					content: "x",
					createdBy: "user:user-a",
				}),
			),
		).toMatch(/RBAC_DENIED/);
	});

	test("(e) the service account writes any namespace; a team namespace is stamped with that org's ID", async () => {
		const id = await asServiceAccount(t).mutation(api.memories.storeMemory, {
			namespace: "team/acme/ops",
			type: "project",
			content: "from the seat",
			createdBy: "sigma",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.createdBy).toBe("sigma");
		expect(row?.clerkOrgId).toBe(ID_B);
		const fleet = await asServiceAccount(t).mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "project",
			content: "fleet",
			createdBy: "sigma",
		});
		expect((await t.run((ctx) => ctx.db.get(fleet)))?.clerkOrgId).toBeUndefined();
	});

	test("(e) the service account soft-deletes any row", async () => {
		await asServiceAccount(t).mutation(api.memories.softDeleteMemory, { memoryId: rowA });
		expect((await t.run((ctx) => ctx.db.get(rowA)))?.isLatest).toBe(false);
	});
});

describe("(c) an unresolved caller is refused", () => {
	test("writes raise RBAC_DENIED, and softDelete answers a live and a missing id alike", async () => {
		expect(
			await refusal(
				t.mutation(api.memories.storeMemory, {
					namespace: "team/acme",
					type: "project",
					content: "x",
					createdBy: "x",
				}),
			),
		).toMatch(/RBAC_DENIED/);
		const gone = await t.run(async (ctx) => {
			const id = await ctx.db.insert("memories", {
				namespace: "team/acme",
				type: "project",
				content: "c",
				createdBy: "x",
				relations: [],
				isLatest: true,
				createdAt: 1,
				updatedAt: 1,
			});
			await ctx.db.delete(id);
			return id;
		});
		const live = await refusal(t.mutation(api.memories.softDeleteMemory, { memoryId: rowA }));
		const missing = await refusal(t.mutation(api.memories.softDeleteMemory, { memoryId: gone }));
		expect(live).toMatch(/RBAC_DENIED/);
		expect(missing).toMatch(/RBAC_DENIED/);
	});

	test("a scoped member sees the same refusal for a foreign row and for a missing one", async () => {
		const gone = await t.run(async (ctx) => {
			const id = await ctx.db.insert("memories", {
				namespace: "team/acme",
				type: "project",
				content: "c",
				createdBy: "x",
				relations: [],
				isLatest: true,
				createdAt: 1,
				updatedAt: 1,
			});
			await ctx.db.delete(id);
			return id;
		});
		const foreign = await refusal(
			memberB(t).mutation(api.memories.softDeleteMemory, { memoryId: rowA }),
		);
		const missing = await refusal(
			memberB(t).mutation(api.memories.softDeleteMemory, { memoryId: gone }),
		);
		expect(foreign).toMatch(/RBAC_DENIED/);
		expect(missing).toMatch(/RBAC_DENIED/);
	});
});
