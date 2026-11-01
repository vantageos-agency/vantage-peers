/// <reference types="vite/client" />
//
// clientOrgMapping.setActive: the one instrument that switches a
// client_org_mapping row off (or back on) by its label. Deactivating a row
// that carries a permanent Clerk org ID is a real organisation's offboarding,
// so it is refused unless `force: true`. Every call returns the full row
// before and after, so the destructive step prints its inventory.
//
// Poles: id-less deactivate WRITTEN; id-bearing deactivate REFUSED without
// force / WRITTEN with force; ambiguous and unknown labels REFUSED; same value
// IDEMPOTENT (no write); reactivate WRITTEN without force; and a deactivated
// mapping is REFUSED by withOrgScope for a member (existing behaviour, pinned).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seedRow(
	t: T,
	slug: string,
	opts: { withId?: boolean; isActive?: boolean; scopes?: string[] } = {},
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			...(opts.withId ? { clerkOrgId: testClerkOrgId(slug) } : {}),
			allowedOrchestrators: ["pi"],
			scopes: opts.scopes ?? ["view-own-tasks"],
			displayName: slug,
			isActive: opts.isActive ?? true,
			createdAt: 1,
		});
	});
}

const read = (t: T, id: string) =>
	t.run(async (ctx) =>
		// biome-ignore lint/suspicious/noExplicitAny: id is an Id<"client_org_mapping"> from seedRow
		ctx.db.get(id as any),
	);

describe("setActive", () => {
	test("WRITTEN: deactivates an id-less row; read back isActive false; before/after printed", async () => {
		const t = createT();
		const id = await seedRow(t, "scratch-org");
		const r = await t.mutation(internal.clientOrgMapping.setActive, {
			clerkOrgSlug: "scratch-org",
			isActive: false,
		});
		expect(r.changed).toBe(true);
		expect(r.before.isActive).toBe(true);
		expect(r.after.isActive).toBe(false);
		expect(r.before._id).toBe(id);
		expect((await read(t, id))?.isActive).toBe(false);
	});

	test("REFUSED: deactivating an id-bearing row without force; row unchanged", async () => {
		const t = createT();
		const id = await seedRow(t, "real-org", { withId: true });
		await expect(
			t.mutation(internal.clientOrgMapping.setActive, {
				clerkOrgSlug: "real-org",
				isActive: false,
			}),
		).rejects.toThrow(/ORG_DEACTIVATE_NEEDS_FORCE/);
		expect((await read(t, id))?.isActive).toBe(true);
	});

	test("REFUSED: force:false on an id-bearing row is not force", async () => {
		const t = createT();
		const id = await seedRow(t, "real-org", { withId: true });
		await expect(
			t.mutation(internal.clientOrgMapping.setActive, {
				clerkOrgSlug: "real-org",
				isActive: false,
				force: false,
			}),
		).rejects.toThrow(/ORG_DEACTIVATE_NEEDS_FORCE/);
		expect((await read(t, id))?.isActive).toBe(true);
	});

	test("WRITTEN: deactivating an id-bearing row with force", async () => {
		const t = createT();
		const id = await seedRow(t, "real-org", { withId: true });
		const r = await t.mutation(internal.clientOrgMapping.setActive, {
			clerkOrgSlug: "real-org",
			isActive: false,
			force: true,
		});
		expect(r.changed).toBe(true);
		expect(r.after.clerkOrgId).toBe(testClerkOrgId("real-org"));
		expect((await read(t, id))?.isActive).toBe(false);
	});

	test("REFUSED: ambiguous label names both _ids; neither row changes", async () => {
		const t = createT();
		const a = await seedRow(t, "dup-org");
		const b = await seedRow(t, "dup-org");
		let message = "";
		try {
			await t.mutation(internal.clientOrgMapping.setActive, {
				clerkOrgSlug: "dup-org",
				isActive: false,
			});
		} catch (e) {
			message = JSON.stringify((e as { data?: unknown }).data ?? String(e));
		}
		expect(message).toMatch(/ORG_MAPPING_AMBIGUOUS/);
		expect(message).toContain(a);
		expect(message).toContain(b);
		expect((await read(t, a))?.isActive).toBe(true);
		expect((await read(t, b))?.isActive).toBe(true);
	});

	test("REFUSED: unknown label", async () => {
		const t = createT();
		await expect(
			t.mutation(internal.clientOrgMapping.setActive, {
				clerkOrgSlug: "nobody",
				isActive: false,
			}),
		).rejects.toThrow(/ORG_MAPPING_NOT_FOUND/);
	});

	test("IDEMPOTENT: a second identical call writes nothing; before equals after", async () => {
		const t = createT();
		const id = await seedRow(t, "scratch-org");
		await t.mutation(internal.clientOrgMapping.setActive, {
			clerkOrgSlug: "scratch-org",
			isActive: false,
		});
		const r = await t.mutation(internal.clientOrgMapping.setActive, {
			clerkOrgSlug: "scratch-org",
			isActive: false,
		});
		expect(r.changed).toBe(false);
		expect(r.before).toEqual(r.after);
		expect((await read(t, id))?.isActive).toBe(false);
	});

	test("IDEMPOTENT: an already-inactive id-bearing row needs no force", async () => {
		const t = createT();
		await seedRow(t, "real-org", { withId: true, isActive: false });
		const r = await t.mutation(internal.clientOrgMapping.setActive, {
			clerkOrgSlug: "real-org",
			isActive: false,
		});
		expect(r.changed).toBe(false);
	});

	test("WRITTEN: reactivates without force, id-bearing row included", async () => {
		const t = createT();
		const id = await seedRow(t, "real-org", { withId: true, isActive: false });
		const r = await t.mutation(internal.clientOrgMapping.setActive, {
			clerkOrgSlug: "real-org",
			isActive: true,
		});
		expect(r.changed).toBe(true);
		expect(r.before.isActive).toBe(false);
		expect(r.after.isActive).toBe(true);
		expect((await read(t, id))?.isActive).toBe(true);
	});
});

describe("a deactivated mapping and withOrgScope", () => {
	const member = (t: T, slug: string) =>
		t.withIdentity({
			subject: `user-${slug}`,
			tokenIdentifier: `test|user-${slug}`,
			org_id: testClerkOrgId(slug),
		} as Parameters<T["withIdentity"]>[0]);

	test("PRESENT then REFUSED: a member is served while active, refused RBAC_DENIED once setActive switches the org off", async () => {
		const t = createT();
		await seedRow(t, "member-org", {
			withId: true,
			scopes: ["view-own-missions"],
		});
		await expect(
			member(t, "member-org").query(api.missions.list, {}),
		).resolves.not.toThrow();
		await t.mutation(internal.clientOrgMapping.setActive, {
			clerkOrgSlug: "member-org",
			isActive: false,
			force: true,
		});
		await expect(
			member(t, "member-org").query(api.missions.list, {}),
		).rejects.toThrow(/RBAC_DENIED.*resolves no active org/);
	});
});
