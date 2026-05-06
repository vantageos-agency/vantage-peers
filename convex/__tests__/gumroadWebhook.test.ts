/// <reference types="vite/client" />
/**
 * Gumroad webhook handler tests — W3 Cédric onboarding.
 *
 * 5 cases: EN happy path, FR happy path, invalid signature, non-whitelisted
 * product_id, idempotent duplicate gumroadOrderId.
 */
import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

// Exclude RAG/search/backfill modules (same exclusion pattern as licenses.test.ts)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// ─── Constants ────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-gumroad-secret-xyz";
const PRODUCT_ID_EN = "vantage-peers-self-host-en";
const PRODUCT_ID_FR = "vantage-peers-self-host-fr";

/** Build a Gumroad form-encoded payload string. */
function buildGumroadBody(overrides?: {
	product_id?: string;
	sale_id?: string;
	email?: string;
	full_name?: string;
}): string {
	const params = new URLSearchParams({
		product_id: overrides?.product_id ?? PRODUCT_ID_EN,
		sale_id: overrides?.sale_id ?? "sale_test_001",
		email: overrides?.email ?? "cedric@example.com",
		full_name: overrides?.full_name ?? "Cédric Test",
	});
	return params.toString();
}

/** Compute the expected HMAC-SHA256 hex signature for a body + secret. */
function sign(body: string, secret: string): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

	// Set required env vars before each test
	process.env.GUMROAD_WEBHOOK_SECRET = WEBHOOK_SECRET;
	process.env.GUMROAD_PRODUCT_ID_EN = PRODUCT_ID_EN;
	process.env.GUMROAD_PRODUCT_ID_FR = PRODUCT_ID_FR;
	// Omit RESEND_API_KEY so email send returns {ok:false} without network call
	delete process.env.RESEND_API_KEY;
	delete process.env.RESEND_FROM;

	// Mock global fetch — should not be called when RESEND_API_KEY is absent,
	// but mock anyway to catch accidental network leaks.
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify({ id: "resend-mocked" }), { status: 200 }),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	delete process.env.GUMROAD_WEBHOOK_SECRET;
	delete process.env.GUMROAD_PRODUCT_ID_EN;
	delete process.env.GUMROAD_PRODUCT_ID_FR;
	delete process.env.RESEND_API_KEY;
});

function createTestConvex() {
	return convexTest(schema, modules);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test cases
// ─────────────────────────────────────────────────────────────────────────────

describe("handleGumroadWebhook", () => {
	// ── Case 1: Valid EN signature + EN product_id ───────────────────────────────

	test("1. valid EN signature + EN product_id → license generated, locale=en, emailSent flag, 200", async () => {
		const t = createTestConvex();

		const body = buildGumroadBody({
			product_id: PRODUCT_ID_EN,
			sale_id: "sale_en_001",
			email: "cedric-en@example.com",
			full_name: "Cédric EN",
		});
		const signature = sign(body, WEBHOOK_SECRET);

		const result = await t.action(
			internal.gumroadWebhook.handleGumroadWebhook,
			{
				body,
				signature,
			},
		);

		expect(result.status).toBe(200);

		const payload = JSON.parse(result.payload) as {
			ok: boolean;
			licenseId: string;
			emailSent: boolean;
			duplicate?: boolean;
		};
		expect(payload.ok).toBe(true);
		expect(typeof payload.licenseId).toBe("string");
		expect(payload.licenseId.length).toBeGreaterThan(0);
		// emailSent is false because RESEND_API_KEY is absent
		expect(payload.emailSent).toBe(false);
		expect(payload.duplicate).toBeUndefined();

		// Verify the license was actually written to the DB with locale=en
		const license = await t.run(async (ctx) => {
			const doc = await ctx.db
				.query("licenses")
				.withIndex("by_gumroadOrderId", (q) =>
					q.eq("gumroadOrderId", "sale_en_001"),
				)
				.unique();
			return doc;
		});

		expect(license).not.toBeNull();
		expect(license?.purchaseLocale).toBe("en");
		expect(license?.customerEmail).toBe("cedric-en@example.com");
		expect(license?.emailSent).toBe(false);
	});

	// ── Case 2: Valid FR signature + FR product_id ───────────────────────────────

	test("2. valid FR signature + FR product_id → license generated, locale=fr, emailSent flag, 200", async () => {
		const t = createTestConvex();

		const body = buildGumroadBody({
			product_id: PRODUCT_ID_FR,
			sale_id: "sale_fr_001",
			email: "cedric-fr@example.com",
			full_name: "Cédric FR",
		});
		const signature = sign(body, WEBHOOK_SECRET);

		const result = await t.action(
			internal.gumroadWebhook.handleGumroadWebhook,
			{
				body,
				signature,
			},
		);

		expect(result.status).toBe(200);

		const payload = JSON.parse(result.payload) as {
			ok: boolean;
			licenseId: string;
			emailSent: boolean;
		};
		expect(payload.ok).toBe(true);
		expect(typeof payload.licenseId).toBe("string");

		const license = await t.run(async (ctx) => {
			return await ctx.db
				.query("licenses")
				.withIndex("by_gumroadOrderId", (q) =>
					q.eq("gumroadOrderId", "sale_fr_001"),
				)
				.unique();
		});

		expect(license).not.toBeNull();
		expect(license?.purchaseLocale).toBe("fr");
		expect(license?.customerEmail).toBe("cedric-fr@example.com");
	});

	// ── Case 3: Invalid HMAC signature → 401, no license ────────────────────────

	test("3. invalid HMAC signature → 401, no license generated", async () => {
		const t = createTestConvex();

		const body = buildGumroadBody({
			product_id: PRODUCT_ID_EN,
			sale_id: "sale_bad_sig",
		});
		// Deliberately wrong secret
		const badSignature = sign(body, "wrong-secret");

		const result = await t.action(
			internal.gumroadWebhook.handleGumroadWebhook,
			{
				body,
				signature: badSignature,
			},
		);

		expect(result.status).toBe(401);

		const payload = JSON.parse(result.payload) as { error: string };
		expect(payload.error).toMatch(/signature/i);

		// No license should have been created
		const license = await t.run(async (ctx) => {
			return await ctx.db
				.query("licenses")
				.withIndex("by_gumroadOrderId", (q) =>
					q.eq("gumroadOrderId", "sale_bad_sig"),
				)
				.unique();
		});

		expect(license).toBeNull();
	});

	// ── Case 4: Non-whitelisted product_id → 400, no license ────────────────────

	test("4. non-whitelisted product_id → 400, no license generated", async () => {
		const t = createTestConvex();

		const body = buildGumroadBody({
			product_id: "unknown-product-xyz",
			sale_id: "sale_bad_product",
		});
		const signature = sign(body, WEBHOOK_SECRET);

		const result = await t.action(
			internal.gumroadWebhook.handleGumroadWebhook,
			{
				body,
				signature,
			},
		);

		expect(result.status).toBe(400);

		const payload = JSON.parse(result.payload) as { error: string };
		expect(payload.error).toMatch(/product/i);

		const license = await t.run(async (ctx) => {
			return await ctx.db
				.query("licenses")
				.withIndex("by_gumroadOrderId", (q) =>
					q.eq("gumroadOrderId", "sale_bad_product"),
				)
				.unique();
		});

		expect(license).toBeNull();
	});

	// ── Case 5: Idempotent duplicate gumroadOrderId ──────────────────────────────

	test("5. duplicate gumroadOrderId → existing license returned, no duplicate in DB", async () => {
		const t = createTestConvex();

		const body = buildGumroadBody({
			product_id: PRODUCT_ID_EN,
			sale_id: "sale_idempotent_001",
			email: "cedric-idem@example.com",
		});
		const signature = sign(body, WEBHOOK_SECRET);

		// First request — creates license
		const first = await t.action(internal.gumroadWebhook.handleGumroadWebhook, {
			body,
			signature,
		});
		expect(first.status).toBe(200);
		const firstPayload = JSON.parse(first.payload) as {
			ok: boolean;
			licenseId: string;
		};

		// Second request — same body/signature/sale_id
		const second = await t.action(
			internal.gumroadWebhook.handleGumroadWebhook,
			{
				body,
				signature,
			},
		);
		expect(second.status).toBe(200);
		const secondPayload = JSON.parse(second.payload) as {
			ok: boolean;
			licenseId: string;
			duplicate: boolean;
		};

		// Must return the same licenseId and mark as duplicate
		expect(secondPayload.ok).toBe(true);
		expect(secondPayload.licenseId).toBe(firstPayload.licenseId);
		expect(secondPayload.duplicate).toBe(true);

		// Exactly one license row in DB for this order
		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("licenses")
				.withIndex("by_gumroadOrderId", (q) =>
					q.eq("gumroadOrderId", "sale_idempotent_001"),
				)
				.collect();
		});

		expect(rows).toHaveLength(1);
	});
});
