/// <reference types="vite/client" />
/**
 * SEAT_REFRESH_TOKEN — provisionOrganization mints a refresh token per seat.
 *
 * Task k1784cq353qpmw9fmn8me551qs8ev2z9. Before this change a provisioned
 * seat held an access token with a 7-day life and NO refresh token at all —
 * `oauth_refresh_tokens` stayed empty for every seat `provisionOrganization`
 * ever created, so a seat that outlived a week had no way back in short of
 * re-provisioning. This file proves the seat now gets one, at the same
 * 30-day life the HTTP `/token` authorization_code flow uses, and that a
 * replay (idempotent second call with the same name set) does not mint a
 * second one.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER = "test-master-token-provision-refresh";

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

describe("oauth:provisionOrganization — seat refresh token", () => {
	test("fresh provision mints a refresh token per seat, 30-day life, linked to the access token row", async () => {
		const t = createTestConvex();
		const before = Date.now();
		const result = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "renew-org-alpha",
			displayName: "Renew org alpha",
			orchestrators: [{ name: "orch-renew-a" }],
		});
		expect(result.replay).toBe(false);
		const seat = result.orchestrators[0];
		expect(seat.refreshToken).toBeTruthy();

		const refreshRow = await t.run(async (ctx) => {
			const hash = await sha256Hex(seat.refreshToken as string);
			return ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
				.unique();
		});
		expect(refreshRow).not.toBeNull();
		expect(refreshRow?.clientId).toBe(seat.clientId);
		expect(refreshRow?.userId).toBe("orch-renew-a");
		expect(refreshRow?.scopeProfile).toBe(seat.profileId);
		// Same 30-day life the HTTP authorization_code flow gives every
		// other refresh token — deliberately DIFFERENT from the seat's own
		// 7-day access token, which is left unchanged.
		const thirtyDaysMs = 30 * 24 * 3600 * 1000;
		expect(refreshRow?.expiresAt).toBeGreaterThanOrEqual(
			before + thirtyDaysMs - 5000,
		);
		expect(refreshRow?.expiresAt).toBeLessThanOrEqual(
			before + thirtyDaysMs + 5000,
		);

		// Linked: the access token row's refreshTokenHash points at THIS
		// refresh token, mirroring the /token authorization_code flow.
		const accessRow = await t.run(async (ctx) => {
			const hash = await sha256Hex(seat.accessToken as string);
			return ctx.db
				.query("oauth_access_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
				.unique();
		});
		const refreshHash = await sha256Hex(seat.refreshToken as string);
		expect(accessRow?.refreshTokenHash).toBe(refreshHash);
		// Access token's own life is UNCHANGED — still 7 days, not widened.
		const sevenDaysMs = 7 * 24 * 3600 * 1000;
		expect(accessRow?.expiresAt).toBeGreaterThanOrEqual(
			before + sevenDaysMs - 5000,
		);
		expect(accessRow?.expiresAt).toBeLessThanOrEqual(
			before + sevenDaysMs + 5000,
		);
	});

	test("replay does not mint a second refresh token for the same seat", async () => {
		const t = createTestConvex();
		await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "renew-org-beta",
			displayName: "Renew org beta",
			orchestrators: [{ name: "orch-renew-b" }],
		});
		const replay = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "renew-org-beta",
			displayName: "Renew org beta",
			orchestrators: [{ name: "orch-renew-b" }],
		});
		expect(replay.replay).toBe(true);
		expect(replay.orchestrators[0].refreshToken).toBeNull();

		const rows = await t.run(async (ctx) =>
			ctx.db.query("oauth_refresh_tokens").collect(),
		);
		expect(rows).toHaveLength(1);
	});
});
