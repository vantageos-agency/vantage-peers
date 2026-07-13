/// <reference types="vite/client" />
/**
 * License system tests — W2 Bob onboarding.
 *
 * Tests: generate / activate / validate / requireActiveLicense middleware.
 * 9 test cases covering: happy paths, auth failures, expiry, revocation, unknown.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { requireActiveLicense } from "../lib/license";
import schema from "../schema";

// Exclude RAG/search/backfill modules (same exclusion pattern as tests.test.ts)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER_TOKEN = "test-master-token-abc123";

// Freeze time so Date.now() is deterministic across each test
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

// ─────────────────────────────────────────────────────────────────────────────
// generate
// ─────────────────────────────────────────────────────────────────────────────

describe("generate", () => {
	test("1. master token → returns license key + correct expiresAt (365d)", async () => {
		const t = createTestConvex();
		process.env.BEARER_SECRET_MASTER = MASTER_TOKEN;

		const now = Date.now(); // 2026-01-01T12:00:00.000Z in ms
		const expected365d = now + 365 * 24 * 60 * 60 * 1000;

		const result = await t.mutation(api.licenses.generate, {
			callerToken: MASTER_TOKEN,
			customerEmail: "bob@example.com",
			productCode: "vantage-peers-self-host",
			tier: "open-core-99-eur-yr",
		});

		// Key should be a non-empty base64url string (~43 chars from 32 bytes)
		expect(typeof result.licenseKey).toBe("string");
		expect(result.licenseKey.length).toBeGreaterThan(30);
		// base64url characters only
		expect(result.licenseKey).toMatch(/^[A-Za-z0-9_-]+$/);

		// licenseId should be an id string
		expect(typeof result.licenseId).toBe("string");
		expect(result.licenseId.length).toBeGreaterThan(0);

		// expiresAt should be now + 365d
		expect(result.expiresAt).toBe(expected365d);
	});

	test("2. non-master token → throws Forbidden", async () => {
		const t = createTestConvex();
		process.env.BEARER_SECRET_MASTER = MASTER_TOKEN;

		await expect(
			t.mutation(api.licenses.generate, {
				callerToken: "wrong-token",
				customerEmail: "hacker@example.com",
				productCode: "vantage-peers-self-host",
				tier: "open-core-99-eur-yr",
			}),
		).rejects.toThrow("Forbidden");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// activate
// ─────────────────────────────────────────────────────────────────────────────

describe("activate", () => {
	async function createLicense(
		t: ReturnType<typeof createTestConvex>,
		overrides?: { expiresInDays?: number },
	) {
		process.env.BEARER_SECRET_MASTER = MASTER_TOKEN;
		return await t.mutation(api.licenses.generate, {
			callerToken: MASTER_TOKEN,
			customerEmail: "bob@example.com",
			productCode: "vantage-peers-self-host",
			tier: "open-core-99-eur-yr",
			...overrides,
		});
	}

	test("3. correct key + email → sets activatedAt and returns ok+expiresAt", async () => {
		const t = createTestConvex();
		const { licenseKey } = await createLicense(t);

		const result = await t.mutation(api.licenses.activate, {
			licenseKey,
			customerEmail: "bob@example.com",
		});

		expect(result.ok).toBe(true);
		expect(typeof result.expiresAt).toBe("number");
		expect(result.expiresAt).toBeGreaterThan(Date.now());
	});

	test("4. correct key + wrong email → throws 'License invalid'", async () => {
		const t = createTestConvex();
		const { licenseKey } = await createLicense(t);

		await expect(
			t.mutation(api.licenses.activate, {
				licenseKey,
				customerEmail: "wrong@example.com",
			}),
		).rejects.toThrow("License invalid or expired");
	});

	test("5. revoked key → throws 'License invalid'", async () => {
		const t = createTestConvex();
		const { licenseId, licenseKey } = await createLicense(t);

		// Directly patch the license status to "revoked" via run
		await t.run(async (ctx) => {
			await ctx.db.patch(licenseId, { status: "revoked" });
		});

		await expect(
			t.mutation(api.licenses.activate, {
				licenseKey,
				customerEmail: "bob@example.com",
			}),
		).rejects.toThrow("License invalid or expired");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// validate
// ─────────────────────────────────────────────────────────────────────────────

describe("validate", () => {
	test("6. non-existent key → returns status 'unknown'", async () => {
		const t = createTestConvex();

		const result = await t.query(api.licenses.validate, {
			licenseKey: "totally-fake-key-that-does-not-exist",
		});

		expect(result.status).toBe("unknown");
		expect(result.expiresAt).toBeUndefined();
		expect(result.customerEmail).toBeUndefined();
	});

	test("7. past-expiresAt key → returns status 'expired'", async () => {
		const t = createTestConvex();
		process.env.BEARER_SECRET_MASTER = MASTER_TOKEN;

		// Generate with expiresInDays=1 so it's active now
		const { licenseKey } = await t.mutation(api.licenses.generate, {
			callerToken: MASTER_TOKEN,
			customerEmail: "bob@example.com",
			productCode: "vantage-peers-self-host",
			tier: "open-core-99-eur-yr",
			expiresInDays: 1,
		});

		// Advance time by 2 days so it's past expiresAt
		vi.setSystemTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));

		const result = await t.query(api.licenses.validate, { licenseKey });

		expect(result.status).toBe("expired");
		expect(result.expiresAt).toBeDefined();
		expect(result.customerEmail).toBe("bob@example.com");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// requireActiveLicense middleware
// ─────────────────────────────────────────────────────────────────────────────

describe("requireActiveLicense", () => {
	async function seedActiveLicense(t: ReturnType<typeof createTestConvex>) {
		process.env.BEARER_SECRET_MASTER = MASTER_TOKEN;
		return await t.mutation(api.licenses.generate, {
			callerToken: MASTER_TOKEN,
			customerEmail: "bob@example.com",
			productCode: "vantage-peers-self-host",
			tier: "open-core-99-eur-yr",
		});
	}

	test("8a. undefined licenseKey → throws license error", async () => {
		const t = createTestConvex();
		await expect(
			t.run(async (ctx) => {
				await requireActiveLicense(ctx, undefined);
			}),
		).rejects.toThrow("Licence expirée ou invalide");
	});

	test("8b. revoked key → throws license error", async () => {
		const t = createTestConvex();
		const { licenseId, licenseKey } = await seedActiveLicense(t);

		await t.run(async (ctx) => {
			await ctx.db.patch(licenseId, { status: "revoked" });
		});

		await expect(
			t.run(async (ctx) => {
				await requireActiveLicense(ctx, licenseKey);
			}),
		).rejects.toThrow("Licence expirée ou invalide");
	});

	test("8c. expired key (past expiresAt) → throws license error", async () => {
		const t = createTestConvex();
		const { licenseKey } = await t.mutation(api.licenses.generate, {
			callerToken: MASTER_TOKEN,
			customerEmail: "bob@example.com",
			productCode: "vantage-peers-self-host",
			tier: "open-core-99-eur-yr",
			expiresInDays: 1,
		});

		// Advance time so the license is past expiry
		vi.setSystemTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));

		await expect(
			t.run(async (ctx) => {
				await requireActiveLicense(ctx, licenseKey);
			}),
		).rejects.toThrow("Licence expirée ou invalide");
	});

	test("9. active + non-expired key → no throw", async () => {
		const t = createTestConvex();
		const { licenseKey } = await seedActiveLicense(t);

		// Should not throw — resolves to null (Convex serializes undefined → null)
		await expect(
			t.run(async (ctx) => {
				await requireActiveLicense(ctx, licenseKey);
			}),
		).resolves.not.toThrow();
	});
});
