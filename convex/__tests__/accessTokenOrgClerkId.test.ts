/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// oauth:getAccessTokenByHash answers the token's org PERMANENT ID (`orgClerkId`),
// read live from the ACTIVE mapping row of the token's org label. The MCP admits
// that org's own team/<id> namespace for reads on it (auth.ts checkNamespaceRead).
//
// PRESENT  an active org with an ID -> orgClerkId is that ID.
// ABSENT   a token with no org -> no key. REFUSED/NONE  an inactive org, or an org
//          whose mapping carries no ID, yields NO ID (absence grants nothing).
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";
import { seedMintProfile } from "../../tests/lib/seedMintProfile";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seed(
	t: T,
	slug: string,
	opts: { active?: boolean; withId?: boolean } = {},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			...(opts.withId === false ? {} : { clerkOrgId: testClerkOrgId(slug) }),
			allowedOrchestrators: ["clio"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: opts.active !== false,
			createdAt: Date.now(),
		});
	});
}

let n = 0;
async function token(t: T, clerkOrgSlug?: string): Promise<string> {
	n += 1;
	const tokenHash = `ocid-${n}`;
	if (clerkOrgSlug !== undefined) await seedMintProfile(t, "p", clerkOrgSlug);
	await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId: `c-${n}`,
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile: "p",
		fromAllowList: ["clio"],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
		...(clerkOrgSlug !== undefined ? { clerkOrgSlug } : {}),
	});
	return tokenHash;
}
const lookup = (t: T, tokenHash: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash });

describe("getAccessTokenByHash orgClerkId", () => {
	test("PRESENT: an active org with an ID", async () => {
		const t = createT();
		await seed(t, "probe-tenant-a");
		const row = await lookup(t, await token(t, "probe-tenant-a"));
		expect(row?.orgClerkId).toBe(testClerkOrgId("probe-tenant-a"));
	});

	test("NONE: an inactive org yields no ID", async () => {
		const t = createT();
		await seed(t, "off", { active: false });
		expect((await lookup(t, await token(t, "off")))?.orgClerkId).toBeUndefined();
	});

	test("NONE: a mapping with no ID, an unmapped org and a token with no org", async () => {
		const t = createT();
		await seed(t, "noid", { withId: false });
		expect((await lookup(t, await token(t, "noid")))?.orgClerkId).toBeUndefined();
		expect((await lookup(t, await token(t, "ghost")))?.orgClerkId).toBeUndefined();
		const row = await lookup(t, await token(t));
		expect(row).not.toBeNull();
		expect(row && "orgClerkId" in row).toBe(false);
	});
});
