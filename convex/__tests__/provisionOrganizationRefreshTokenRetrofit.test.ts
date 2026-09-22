/// <reference types="vite/client" />
/**
 * SEAT_REFRESH_TOKEN_RETROFIT — oauth:retrofitSeatRefreshToken.
 *
 * Task k1784cq353qpmw9fmn8me551qs8ev2z9, round 2. The `provisionOrganization`
 * fix (provisionOrganizationRefreshToken.test.ts) only rescues seats
 * provisioned AFTER the deploy — a seat provisioned BEFORE it has an
 * oauth_clients row and an oauth_access_tokens row but NO oauth_refresh_tokens
 * row, and nothing in the normal provisioning path (including a replay call,
 * which returns refreshToken: null) can ever backfill it. This file proves
 * the operator-run retrofit mutation closes that gap: mints exactly once per
 * seat, refuses a client that already holds a live refresh token, and
 * refuses an unknown clientId outright.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER = "test-master-token-retrofit";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

async function sha256Hex(raw: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(raw),
	);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Provisions a seat, then DELETES its refresh token row directly — this
 * models the real pre-deploy-seat shape (oauth_clients + oauth_access_tokens
 * rows exist, oauth_refresh_tokens does not) more faithfully than trying to
 * provision "before the fix", since the fix is already live in this test
 * module's imports.
 */
async function provisionThenStripRefreshToken(
	t: ReturnType<typeof createTestConvex>,
	clerkOrgSlug: string,
	name: string,
): Promise<{ clientId: string }> {
	const result = await t.mutation(api.oauth.provisionOrganization, {
		callerToken: MASTER,
		clerkOrgSlug,
		displayName: clerkOrgSlug,
		orchestrators: [{ name }],
	});
	const clientId = result.orchestrators[0].clientId;
	await t.run(async (ctx) => {
		const rows = await ctx.db
			.query("oauth_refresh_tokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect();
		for (const row of rows) {
			await ctx.db.delete(row._id);
		}
	});
	return { clientId };
}

describe("oauth:retrofitSeatRefreshToken", () => {
	test("a pre-deploy seat with no refresh token gets one, and it renews through the seat's own identity", async () => {
		const t = createTestConvex();
		const { clientId } = await provisionThenStripRefreshToken(
			t,
			"retrofit-org-alpha",
			"orch-retrofit-a",
		);

		const preRows = await t.run(async (ctx) =>
			ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
				.collect(),
		);
		expect(preRows).toHaveLength(0);

		const result = await t.mutation(internal.oauth.retrofitSeatRefreshToken, {
			clientId,
		});
		expect(result.refreshToken).toBeTruthy();
		expect(result.clientId).toBe(clientId);
		expect(result.userId).toBe("orch-retrofit-a");
		expect(result.scopeProfile).toBe("orch-retrofit-a-retrofit-org-alpha");

		const row = await t.run(async (ctx) => {
			const hash = await sha256Hex(result.refreshToken);
			return ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
				.unique();
		});
		expect(row).not.toBeNull();
		expect(row?.clientId).toBe(clientId);
		expect(row?.userId).toBe("orch-retrofit-a");
	});

	test("a client that already holds a live refresh token is REFUSED, not double-minted", async () => {
		const t = createTestConvex();
		// Fresh provision already mints a live refresh token — do NOT strip it.
		const result = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "retrofit-org-beta",
			displayName: "retrofit-org-beta",
			orchestrators: [{ name: "orch-retrofit-b" }],
		});
		const clientId = result.orchestrators[0].clientId;

		await expect(
			t.mutation(internal.oauth.retrofitSeatRefreshToken, { clientId }),
		).rejects.toThrow(/SEAT_ALREADY_HAS_LIVE_REFRESH_TOKEN/);

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});

	test("re-running the retrofit against the SAME seat after a first successful mint is refused too (idempotent operator re-run)", async () => {
		const t = createTestConvex();
		const { clientId } = await provisionThenStripRefreshToken(
			t,
			"retrofit-org-gamma",
			"orch-retrofit-c",
		);
		await t.mutation(internal.oauth.retrofitSeatRefreshToken, { clientId });
		await expect(
			t.mutation(internal.oauth.retrofitSeatRefreshToken, { clientId }),
		).rejects.toThrow(/SEAT_ALREADY_HAS_LIVE_REFRESH_TOKEN/);

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});

	test("an unknown clientId is refused", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(internal.oauth.retrofitSeatRefreshToken, {
				clientId: "does-not-exist-anywhere",
			}),
		).rejects.toThrow(/SEAT_CLIENT_NOT_FOUND/);
	});
});
