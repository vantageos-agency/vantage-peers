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

// R4 RED reproduction — memoriesScoped:storeMemoryScoped (createdBy attribution).

describe("memoriesScoped:storeMemoryScoped", () => {
	test("memoriesScoped:storeMemoryScoped — an org-a member cannot author a memory as 'system' (createdBy bound to the caller or refused)", async () => {
		const t = createT();
		await seedOrgs(t);
		await expectForgedAuthorNotPersisted(
			() =>
				asMemberA(t).mutation(api.memoriesScoped.storeMemoryScoped, {
					namespace: "team/org-a",
					type: "project",
					content: "x",
					createdBy: "system",
				}),
			async () =>
				(await t.run((ctx) => ctx.db.query("memories").collect())).map((m) => m.createdBy),
			"system",
		);
	});

	test("memoriesScoped:storeMemoryScoped — positive control: the member's own-named write to team/org-a is served", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await asMemberA(t).mutation(api.memoriesScoped.storeMemoryScoped, {
			namespace: "team/org-a",
			type: "project",
			content: "x",
			createdBy: "user:user-org-a",
		});
		expect(id).toBeDefined();
	});
});
