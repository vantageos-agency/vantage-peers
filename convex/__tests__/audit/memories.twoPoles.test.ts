/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

/** Ordinary org member of org-a: NOT the service account, NOT master. */
const asMemberA = (t: T) =>
	t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
		orgRole: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);
const asMemberB = (t: T) =>
	t.withIdentity({
		subject: "user-org-b",
		organizationId: "org-b",
		orgRole: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		for (const org of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

/**
 * The attribution property: a member either is refused, or the stored author is NOT the
 * forged string. A refusal must be a coded one (RBAC_/AUTH_), never an unrelated crash.
 */
async function expectForgedAuthorNotPersisted(
	call: () => Promise<unknown>,
	storedAuthors: () => Promise<(string | undefined)[]>,
	forged: string,
) {
	let refused = false;
	try {
		await call();
	} catch (e) {
		refused = true;
		expect(String(e)).toMatch(/RBAC_DENIED|AUTH_|createdBy/);
	}
	if (!refused) {
		expect(await storedAuthors()).not.toContain(forged);
	}
}

// R4 RED reproduction — memories doors (storeMemory, softDeleteMemory). Identity: org-a member
// (subject user-org-a, org:member) unless stated.

describe("memories:storeMemory", () => {
	test("memories:storeMemory — an org-a member cannot author a memory as 'pi' (createdBy is bound to the caller or refused)", async () => {
		const t = createT();
		await seedOrgs(t);
		await expectForgedAuthorNotPersisted(
			() =>
				asMemberA(t).mutation(api.memories.storeMemory, {
					namespace: "team/org-a",
					type: "user",
					content: "x",
					createdBy: "pi",
				}),
			async () =>
				(await t.run((ctx) => ctx.db.query("memories").collect())).map((m) => m.createdBy),
			"pi",
		);
	});

	test("memories:storeMemory — positive control: the member's own write to team/org-a is served", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await asMemberA(t).mutation(api.memories.storeMemory, {
			namespace: "team/org-a",
			type: "user",
			content: "x",
			createdBy: "user:user-org-a",
		});
		expect(id).toBeDefined();
	});
});

describe("memories:softDeleteMemory", () => {
	test("memories:softDeleteMemory — an unauthenticated caller gets the same refusal for an existing and for a deleted memoryId", async () => {
		const t = createT();
		await seedOrgs(t);
		const existing = await t.run((ctx) =>
			ctx.db.insert("memories", {
				namespace: "team/org-b",
				type: "user",
				content: "c",
				createdBy: "x",
				relations: [],
				isLatest: true,
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		const gone = await t.run(async (ctx) => {
			const id = await ctx.db.insert("memories", {
				namespace: "team/org-b",
				type: "user",
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
		const errOf = async (memoryId: string) => {
			try {
				await t.mutation(api.memories.softDeleteMemory, { memoryId });
			} catch (e) {
				return String(e);
			}
			return "NO-ERROR";
		};
		const eExisting = await errOf(existing);
		const eGone = await errOf(gone);
		expect(eExisting).toMatch(/RBAC_DENIED/); // pole 1: the anonymous caller is refused on the live row
		// pole 2: the deleted id must be refused identically (no existence oracle)
		expect(eGone).toMatch(/RBAC_DENIED/);
	});

	test("memories:softDeleteMemory — positive control: an org-b member soft-deletes its own memory", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await t.run((ctx) =>
			ctx.db.insert("memories", {
				namespace: "team/org-b",
				type: "user",
				content: "c",
				createdBy: "x",
				relations: [],
				isLatest: true,
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		await asMemberB(t).mutation(api.memories.softDeleteMemory, { memoryId: id });
		expect((await t.run((ctx) => ctx.db.get(id)))?.isLatest).toBe(false);
	});
});
