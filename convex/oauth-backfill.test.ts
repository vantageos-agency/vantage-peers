/// <reference types="vite/client" />
/**
 * convex/oauth-backfill.test.ts
 *
 * Tests for backfillTokenEndpointAuthMethod migration mutation.
 * D-CROSS-1 mirror: Theta VCRM convex/oauthMigrations.ts
 * Mission: k57c7s478gw1a3e5gmhdeptg5n87z78n
 *
 * Cases:
 *   B1 — registration surface: internal, no callerToken argument
 *   B2 — idempotency: second run returns backfilled=0
 *   B3 — respect existing values: row with tokenEndpointAuthMethod="none" NOT overwritten
 *   B4 — empty table: scanned=0 backfilled=0
 *   B5 — count correctness: 3 clients seeded, 2 without field, 1 with "none" → scanned=3 backfilled=2
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import * as oauthMigrationsModule from "./oauthMigrations";
import schema from "./schema";

// Load all convex modules except RAG/search/backfill (cannot run in edge-vm)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("BEARER_SECRET_MASTER", "test-master-token-backfill");
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

// seedDefaultProfiles authorises by identity: the caller must be the recognised
// service account (vitest.config.ts sets CLERK_SERVICE_ACCOUNT_USER_ID to this
// exact subject).
function asServiceAccount(t: ReturnType<typeof createTestConvex>) {
	return t.withIdentity({ subject: "test-service-account-user-id" });
}

// Helper: seed scope profiles (required before inserting clients — FK constraint)
async function seedProfiles(t: ReturnType<typeof createTestConvex>) {
	await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
}

// Helper: insert an oauth_client row directly via ctx.db.insert to control
// exactly whether tokenEndpointAuthMethod is present or absent.
// Using t.run (raw db access) instead of api.oauth.createClient because
// createClient always defaults tokenEndpointAuthMethod to "client_secret_basic"
// — bypassing that is required to simulate pre-migration rows.
async function insertClient(
	t: ReturnType<typeof createTestConvex>,
	suffix: string,
	tokenEndpointAuthMethod?: string,
) {
	await t.run(async (ctx) => {
		const row: {
			clientId: string;
			clientSecretHash: string;
			name: string;
			redirectUris: string[];
			scopeProfile: string;
			createdAt: number;
			tokenEndpointAuthMethod?: string;
		} = {
			clientId: `client-backfill-${suffix}`,
			clientSecretHash:
				`deadbeef${suffix}0000000000000000000000000000000000000000000000000000000000`.slice(
					0,
					64,
				),
			name: `Backfill Client ${suffix}`,
			redirectUris: ["https://example.com/callback"],
			scopeProfile: "client-generic",
			createdAt: Date.now(),
		};
		if (tokenEndpointAuthMethod !== undefined) {
			row.tokenEndpointAuthMethod = tokenEndpointAuthMethod;
		}
		await ctx.db.insert("oauth_clients", row);
	});
}

describe("oauthMigrations.backfillTokenEndpointAuthMethod", () => {
	test("B1 — the migration is not on the public registration surface", async () => {
		const reg =
			oauthMigrationsModule.backfillTokenEndpointAuthMethod as unknown as {
				isPublic?: boolean;
				isInternal?: boolean;
				exportArgs: () => string;
			};
		expect(reg.isPublic).toBeUndefined();
		expect(reg.isInternal).toBe(true);
		expect(reg.exportArgs()).not.toMatch(/callerToken/);
	});

	test("B2 — idempotency: second run returns backfilled=0", async () => {
		const t = createTestConvex();
		await seedProfiles(t);
		await insertClient(t, "idem-a");
		await insertClient(t, "idem-b");

		const first = await t.mutation(
			internal.oauthMigrations.backfillTokenEndpointAuthMethod,
			{},
		);
		expect(first.backfilled).toBe(2);

		const second = await t.mutation(
			internal.oauthMigrations.backfillTokenEndpointAuthMethod,
			{},
		);
		expect(second.scanned).toBe(2);
		expect(second.backfilled).toBe(0);
	});

	test("B3 — respect existing values: row with tokenEndpointAuthMethod='none' is NOT overwritten", async () => {
		const t = createTestConvex();
		await seedProfiles(t);
		await insertClient(t, "none-client", "none");

		const result = await t.mutation(
			internal.oauthMigrations.backfillTokenEndpointAuthMethod,
			{},
		);
		expect(result.scanned).toBe(1);
		expect(result.backfilled).toBe(0);

		// Verify the value was NOT overwritten
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("oauth_clients")
				.withIndex("by_clientId", (q) =>
					q.eq("clientId", "client-backfill-none-client"),
				)
				.unique();
			expect(row?.tokenEndpointAuthMethod).toBe("none");
		});
	});

	test("B4 — empty table: scanned=0 backfilled=0", async () => {
		const t = createTestConvex();
		const result = await t.mutation(
			internal.oauthMigrations.backfillTokenEndpointAuthMethod,
			{},
		);
		expect(result.scanned).toBe(0);
		expect(result.backfilled).toBe(0);
	});

	test("B5 — count correctness: 3 clients seeded, 2 without field, 1 with 'none' → scanned=3 backfilled=2", async () => {
		const t = createTestConvex();
		await seedProfiles(t);
		await insertClient(t, "b5-a"); // no tokenEndpointAuthMethod
		await insertClient(t, "b5-b"); // no tokenEndpointAuthMethod
		await insertClient(t, "b5-c", "none"); // has "none" — must not be touched

		const result = await t.mutation(
			internal.oauthMigrations.backfillTokenEndpointAuthMethod,
			{},
		);
		expect(result.scanned).toBe(3);
		expect(result.backfilled).toBe(2);

		// Verify the "none" client was preserved
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("oauth_clients")
				.withIndex("by_clientId", (q) =>
					q.eq("clientId", "client-backfill-b5-c"),
				)
				.unique();
			expect(row?.tokenEndpointAuthMethod).toBe("none");
		});

		// Verify the two patched clients now have client_secret_basic
		await t.run(async (ctx) => {
			const rowA = await ctx.db
				.query("oauth_clients")
				.withIndex("by_clientId", (q) =>
					q.eq("clientId", "client-backfill-b5-a"),
				)
				.unique();
			expect(rowA?.tokenEndpointAuthMethod).toBe("client_secret_basic");

			const rowB = await ctx.db
				.query("oauth_clients")
				.withIndex("by_clientId", (q) =>
					q.eq("clientId", "client-backfill-b5-b"),
				)
				.unique();
			expect(rowB?.tokenEndpointAuthMethod).toBe("client_secret_basic");
		});
	});
});
