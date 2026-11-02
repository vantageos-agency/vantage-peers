/// <reference types="vite/client" />
/**
 * tokenRightsDrift.test.ts - VantagePeers Cloud (multi-tenant).
 * task k17dhntq3m2w5x3x1jtdmkkba18hek7m.
 *
 * The migration doors that make the request-time rights derivation listable and the
 * one marker reversible:
 *   inventory     counts what the derivation changes for LIVE tokens (stale seat
 *                 token gains the profile's right; a deleted profile is `denied`;
 *                 revoked and expired tokens are not counted)
 *   stampPinned   dry run writes nothing; a real run marks only legacy `admin-mint:`
 *                 rows, once; revertPinned undoes exactly those
 */
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

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
const ORG = "org-a";

async function seed(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			allowedOrchestrators: ["clio"],
			scopes: ["view-own-tasks"],
			displayName: ORG,
			isActive: true,
			createdAt: 1,
		});
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "p-a",
			description: "p-a",
			fromAllowList: ["clio"],
			namespaceReadPrefixes: ["project/org-a", "orchestrator/agent-x"],
			namespaceWritePrefixes: ["project/org-a", "orchestrator/agent-x"],
			createdAt: 1,
			updatedAt: 1,
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
		});
	});
}

async function token(
	t: T,
	hash: string,
	over: Partial<{
		clientId: string;
		scopeProfile: string;
		revokedAt: number;
		expiresAt: number;
	}> = {},
) {
	return await t.run((ctx) =>
		ctx.db.insert("oauth_access_tokens", {
			tokenHash: hash,
			clientId: over.clientId ?? "seat-client",
			userId: "seat",
			scopes: ["mcp:full"],
			scopeProfile: over.scopeProfile ?? "p-a",
			fromAllowList: ["clio"],
			namespaceReadPrefixes: ["project/org-a"],
			namespaceWritePrefixes: ["project/org-a"],
			expiresAt: over.expiresAt ?? Date.now() + 3_600_000,
			createdAt: Date.now(),
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			...(over.revokedAt !== undefined ? { revokedAt: over.revokedAt } : {}),
		}),
	);
}

describe("tokenRightsDrift:inventory", () => {
	test("counts the live tokens whose derived grant differs from the mint-time copy", async () => {
		const t = createT();
		await seed(t);
		const stale = await token(t, "stale");
		await token(t, "gone", { scopeProfile: "no-such-profile" });
		await token(t, "revoked", { revokedAt: 1 });
		await token(t, "expired", { expiresAt: 1 });
		const out = await t.query(internal.migrations.tokenRightsDrift.inventory, {});
		expect(out.isDone).toBe(true);
		expect(out.scanned).toBe(4);
		expect(out.live).toBe(2);
		expect(out.changes).toBe(1);
		expect(out.denied).toBe(1);
		const c = out.changed.find((x) => x.id === stale);
		expect(c?.writeGained).toEqual(["orchestrator/agent-x"]);
		expect(c?.readGained).toEqual(["orchestrator/agent-x"]);
		expect(c?.writeLost).toEqual([]);
	});

	test("a token already equal to its profile is unchanged", async () => {
		const t = createT();
		await seed(t);
		await t.run((ctx) =>
			ctx.db.insert("oauth_access_tokens", {
				tokenHash: "fresh",
				clientId: "seat-client",
				userId: "seat",
				scopes: ["mcp:full"],
				scopeProfile: "p-a",
				fromAllowList: ["clio"],
				namespaceReadPrefixes: ["project/org-a", "orchestrator/agent-x"],
				namespaceWritePrefixes: ["project/org-a", "orchestrator/agent-x"],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: ORG,
				clerkOrgId: testClerkOrgId(ORG),
			}),
		);
		const out = await t.query(internal.migrations.tokenRightsDrift.inventory, {});
		expect(out.unchanged).toBe(1);
		expect(out.changed).toEqual([]);
	});
});

describe("tokenRightsDrift:stampPinned / revertPinned", () => {
	test("dry run writes nothing; a real run marks only admin-mint rows, once; revert undoes them", async () => {
		const t = createT();
		await seed(t);
		const adm = await token(t, "adm", { clientId: "admin-mint:abc" });
		const seat = await token(t, "seat");
		const dry = await t.mutation(internal.migrations.tokenRightsDrift.stampPinned, {});
		expect(dry).toMatchObject({ dryRun: true, wouldMark: 1, marked: 0, ids: [adm] });
		expect((await t.run((ctx) => ctx.db.get(adm)))?.rightsPinned).toBeUndefined();

		const run = await t.mutation(internal.migrations.tokenRightsDrift.stampPinned, {
			dryRun: false,
		});
		expect(run).toMatchObject({ dryRun: false, marked: 1, ids: [adm] });
		expect((await t.run((ctx) => ctx.db.get(adm)))?.rightsPinned).toBe(true);
		expect((await t.run((ctx) => ctx.db.get(seat)))?.rightsPinned).toBeUndefined();

		const again = await t.mutation(internal.migrations.tokenRightsDrift.stampPinned, {
			dryRun: false,
		});
		expect(again).toMatchObject({ marked: 0, alreadyMarked: 1 });

		const rev = await t.mutation(internal.migrations.tokenRightsDrift.revertPinned, {
			ids: [adm, seat],
			dryRun: false,
		});
		expect(rev).toMatchObject({ reverted: 1, skipped: 1 });
		expect((await t.run((ctx) => ctx.db.get(adm)))?.rightsPinned).toBeUndefined();
	});
});
