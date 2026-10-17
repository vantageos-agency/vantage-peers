/**
 * The return from Clerk's hosted sign-in carries no session on this host: on a
 * development instance (and a production one on another registrable domain)
 * the `__session` cookie lives on the Clerk domain. GET /authorize/callback
 * must hand the browser to Clerk's own handshake (`@clerk/backend`
 * authenticateRequest, through @vantageos/cloud-identity
 * resolveClerkSessionFromRequest), never answer 403 session-required.
 *
 * No Clerk collaborator is injected here, so the SDK path runs for real
 * (offline: the handshake redirect is built by the SDK without a network
 * call). The handshake runs only when CLERK_PUBLISHABLE_KEY is configured.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../server-http.js";

const BASE = "http://localhost:3000";
const FAPI = "sharp-sponge-67.clerk.accounts.dev";
const ENV = {
	AUTHORIZE_STATE_SECRET: "test-state-secret-0123456789-0123456789-abcdef",
	CLERK_DOMAIN: `https://${FAPI}`,
	AUTHORIZE_SIGN_IN_URL: `https://${FAPI}/sign-in`,
	AUTHORIZE_CALLBACK_URL: `${BASE}/authorize/callback`,
	PUBLIC_BASE_URL: BASE,
	CLERK_SECRET_KEY: `sk_test_${"x".repeat(40)}`,
	CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${FAPI}$`).toString("base64")}`,
} as const;

const doc = { accept: "text/html", "sec-fetch-dest": "document" };
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = {};
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("GET /authorize/callback without a session on this host", () => {
	it("answers Clerk's handshake redirect, marked no-store, not 403 session-required", async () => {
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=x&__clerk_db_jwt=dvb_abc`,
			{ headers: doc, redirect: "manual" },
		);
		expect(res.status).toBe(307);
		expect(res.headers.get("location") ?? "").toContain(
			`${FAPI}/v1/client/handshake`,
		);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("a forged __clerk_handshake never answers 500 and sets no session", async () => {
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=x&__clerk_db_jwt=dvb_abc&__clerk_handshake=forged.not.a.jwt`,
			{ headers: doc, redirect: "manual" },
		);
		expect(res.status).toBeLessThan(500);
		expect(
			res.headers.getSetCookie().some((c) => c.startsWith("__session=")),
		).toBe(false);
	});

	it("without CLERK_PUBLISHABLE_KEY no handshake is attempted and the callback refuses loudly (server-misconfigured, not a silent skip)", async () => {
		delete process.env.CLERK_PUBLISHABLE_KEY;
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=x&__clerk_db_jwt=dvb_abc`,
			{ headers: doc, redirect: "manual" },
		);
		expect(res.status).not.toBe(307);
		expect(res.status).toBe(500);
	});
});
