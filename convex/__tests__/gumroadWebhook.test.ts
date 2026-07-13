/// <reference types="vite/client" />
/**
 * Gumroad webhook handler tests — W3 Bob onboarding.
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
		email: overrides?.email ?? "bob@example.com",
		full_name: overrides?.full_name ?? "Bob Test",
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
			email: "bob-en@example.com",
			full_name: "Bob EN",
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
		expect(license?.customerEmail).toBe("bob-en@example.com");
		expect(license?.emailSent).toBe(false);
	});

	// ── Case 2: Valid FR signature + FR product_id ───────────────────────────────

	test("2. valid FR signature + FR product_id → license generated, locale=fr, emailSent flag, 200", async () => {
		const t = createTestConvex();

		const body = buildGumroadBody({
			product_id: PRODUCT_ID_FR,
			sale_id: "sale_fr_001",
			email: "bob-fr@example.com",
			full_name: "Bob FR",
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
		expect(license?.customerEmail).toBe("bob-fr@example.com");
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
			email: "bob-idem@example.com",
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

	// ── Case 6 (M1): XSS in customerName → HTML-escaped in email body ────────────

	test("6. customerName with XSS payload → HTML-escaped in email, raw tag not present", async () => {
		const t = createTestConvex();

		const xssName = "<script>alert('xss')</script>";
		const body = buildGumroadBody({
			product_id: PRODUCT_ID_EN,
			sale_id: "sale_xss_001",
			email: "xss@example.com",
			full_name: xssName,
		});
		const signature = sign(body, WEBHOOK_SECRET);

		// Capture the HTML body sent to Resend by inspecting the fetch mock
		let capturedHtml = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async (_url, init?: RequestInit) => {
				if (init?.body && typeof init.body === "string") {
					const parsed = JSON.parse(init.body) as { html?: string };
					capturedHtml = parsed.html ?? "";
				}
				return new Response(JSON.stringify({ id: "resend-xss-test" }), {
					status: 200,
				});
			},
		);
		// Provide a dummy RESEND_API_KEY so the send path is triggered
		process.env.RESEND_API_KEY = "re_test_key";

		const result = await t.action(
			internal.gumroadWebhook.handleGumroadWebhook,
			{ body, signature },
		);

		expect(result.status).toBe(200);

		// Raw <script> tag must NOT appear anywhere in the HTML output
		expect(capturedHtml).not.toContain("<script>");
		expect(capturedHtml).not.toContain("</script>");

		// The escaped form must be present
		expect(capturedHtml).toContain("&lt;script&gt;");
		expect(capturedHtml).toContain("&lt;/script&gt;");

		delete process.env.RESEND_API_KEY;
	});

	// ── Case 7 (M2): concurrent same gumroadOrderId → only 1 license row ─────────

	test("7. two concurrent webhooks with same gumroadOrderId → exactly 1 license row (atomic findOrCreate)", async () => {
		const t = createTestConvex();

		const body = buildGumroadBody({
			product_id: PRODUCT_ID_EN,
			sale_id: "sale_concurrent_001",
			email: "concurrent@example.com",
			full_name: "Concurrent User",
		});
		const signature = sign(body, WEBHOOK_SECRET);

		// Fire both concurrently — convex-test serialises mutations atomically
		// so one will win the insert; the second will find the existing row.
		const [r1, r2] = await Promise.all([
			t.action(internal.gumroadWebhook.handleGumroadWebhook, {
				body,
				signature,
			}),
			t.action(internal.gumroadWebhook.handleGumroadWebhook, {
				body,
				signature,
			}),
		]);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);

		const p1 = JSON.parse(r1.payload) as {
			ok: boolean;
			licenseId: string;
			duplicate?: boolean;
		};
		const p2 = JSON.parse(r2.payload) as {
			ok: boolean;
			licenseId: string;
			duplicate?: boolean;
		};

		// Both must succeed and return the same licenseId
		expect(p1.ok).toBe(true);
		expect(p2.ok).toBe(true);
		expect(p1.licenseId).toBe(p2.licenseId);

		// Exactly one row in the DB
		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("licenses")
				.withIndex("by_gumroadOrderId", (q) =>
					q.eq("gumroadOrderId", "sale_concurrent_001"),
				)
				.collect();
		});

		expect(rows).toHaveLength(1);
	});

	// ── Case 8 (trial flow): pre-seeded trial → upgraded to active on purchase ──

	test("8. trial license for email → webhook upgrades to active, keyHash unchanged, isUpgraded=true", async () => {
		const t = createTestConvex();

		const trialEmail = "bob@example.com";

		// Pre-seed a trial license for the same email
		const trialId = await t.run(async (ctx) => {
			return await ctx.db.insert("licenses", {
				keyHash: "deadbeef-trial-hash",
				customerEmail: trialEmail,
				customerName: "Bob Trial",
				productCode: "vantage-peers-self-host",
				tier: "open-core-trial",
				purchasedAt: Date.now() - 7 * 24 * 60 * 60 * 1000, // 7 days ago
				expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000, // 14 days ahead
				status: "trial",
			});
		});

		const body = buildGumroadBody({
			product_id: PRODUCT_ID_EN,
			sale_id: "sale_trial_upgrade_001",
			email: trialEmail,
			full_name: "Bob Trial",
		});
		const signature = sign(body, WEBHOOK_SECRET);

		const result = await t.action(
			internal.gumroadWebhook.handleGumroadWebhook,
			{ body, signature },
		);

		expect(result.status).toBe(200);

		const payload = JSON.parse(result.payload) as {
			ok: boolean;
			licenseId: string;
			isUpgraded: boolean;
			emailSent: boolean;
		};
		expect(payload.ok).toBe(true);
		expect(payload.isUpgraded).toBe(true);
		// The returned licenseId must be the original trial row's ID
		expect(payload.licenseId).toBe(trialId);

		// DB: only one row for this email, status=active, keyHash unchanged
		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("licenses")
				.withIndex("by_customerEmail", (q) => q.eq("customerEmail", trialEmail))
				.collect();
		});

		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("active");
		expect(rows[0].keyHash).toBe("deadbeef-trial-hash"); // unchanged
		expect(rows[0].gumroadOrderId).toBe("sale_trial_upgrade_001"); // patched
	});
});
