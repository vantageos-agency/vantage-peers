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

// R4 RED reproduction — diary:write (createdBy attribution).

describe("diary:write", () => {
	test("diary:write — an org-a member cannot forge the author 'user:someone-else' (createdBy bound to the caller or refused)", async () => {
		const t = createT();
		await seedOrgs(t);
		await expectForgedAuthorNotPersisted(
			() =>
				asMemberA(t).mutation(api.diary.write, {
					date: "2026-10-09",
					orchestrator: "sigma",
					content: "x",
					createdBy: "user:someone-else",
				}),
			async () =>
				(
					await asMemberA(t).query(api.diary.list, { createdBy: "user:someone-else" } as never)
				).map((e: { createdBy?: string }) => e.createdBy),
			"user:someone-else",
		);
	});

	test("diary:write — positive control: the member writes its own entry (roster orchestrator sigma) and reads it back", async () => {
		const t = createT();
		await seedOrgs(t);
		await asMemberA(t).mutation(api.diary.write, {
			date: "2026-10-09",
			orchestrator: "sigma",
			content: "x",
			createdBy: "user:user-org-a",
		});
		const row = await asMemberA(t).query(api.diary.get, { date: "2026-10-09", orchestrator: "sigma" });
		expect(row?.content).toBe("x");
	});
});
