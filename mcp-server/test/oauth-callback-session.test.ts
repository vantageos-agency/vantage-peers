/**
 * GET /authorize/callback fails closed and loud when Clerk's handshake cannot
 * run because half of its configuration is missing (CLERK_SECRET_KEY set,
 * CLERK_PUBLISHABLE_KEY absent, or the reverse). Before this change the
 * handshake was skipped silently and the operator saw `session-required`,
 * indistinguishable from "not signed in".
 *
 * Test location: mcp-server/test/ (the suite's convention; the brief's
 * mcp-server/tests/ does not exist). No Clerk collaborator is injected, so the
 * SDK path runs for real, offline, as in oauth-clerk-handshake.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../server-http.js";
import { _setInternalClientForTest } from "../src/auth.js";

const BASE = "http://localhost:3000";
const FAPI = "sharp-sponge-67.clerk.accounts.dev";
const STATE_SECRET = "test-state-secret-0123456789-0123456789-abcdef";
const ENV = {
	AUTHORIZE_STATE_SECRET: STATE_SECRET,
	CLERK_DOMAIN: `https://${FAPI}`,
	AUTHORIZE_SIGN_IN_URL: `https://${FAPI}/sign-in`,
	AUTHORIZE_CALLBACK_URL: `${BASE}/authorize/callback`,
	PUBLIC_BASE_URL: BASE,
	CLERK_SECRET_KEY: `sk_test_${"x".repeat(40)}`,
	CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${FAPI}$`).toString("base64")}`,
} as const;

const doc = { accept: "text/html", "sec-fetch-dest": "document" };
let saved: Record<string, string | undefined> = {};
let errors: ReturnType<typeof vi.spyOn>;

const b64url = (bytes: Uint8Array | string): string =>
	Buffer.from(bytes).toString("base64url");

/** A state signed the way the package signs it: base64url(json).base64url(hmac). */
async function signedState(): Promise<string> {
	const payload = b64url(
		JSON.stringify({
			v: 1,
			cid: "client-iris",
			ru: "https://client.example/callback",
			cc: "c".repeat(43),
			rs: `${BASE}/mcp`,
			sc: "mcp:full",
			st: null,
			exp: Date.now() + 600_000,
		}),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(STATE_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(payload),
	);
	return `${payload}.${b64url(new Uint8Array(mac))}`;
}

const logged = (): string =>
	errors.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");

beforeEach(() => {
	saved = {};
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
	// The only Convex read before the session check is the client lookup.
	_setInternalClientForTest({
		query: async () => ({
			clientId: "client-iris",
			name: "Iris",
			redirectUris: ["https://client.example/callback"],
		}),
		// biome-ignore lint/suspicious/noExplicitAny: minimal ConvexHttpClient stand-in
	} as any);
});

afterEach(() => {
	_setInternalClientForTest(null);
	errors.mockRestore();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("(a) secret set, publishable key missing", () => {
	beforeEach(() => {
		delete process.env.CLERK_PUBLISHABLE_KEY;
	});

	it("refuses with the misconfiguration reason, not session-required", async () => {
		const state = await signedState();
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=${state}`,
			{ headers: doc, redirect: "manual" },
		);
		const body = (await res.json()) as {
			error: string;
			error_description: string;
		};
		expect(res.status).toBe(500);
		expect(body.error).toBe("server_error");
		expect(body.error_description).toBe("server-misconfigured");
		expect(body.error_description).not.toBe("session-required");
	});

	it("logs the missing variable NAME and the refusal reason, never a secret", async () => {
		const state = await signedState();
		await app.request(`${BASE}/authorize/callback?authorize_state=${state}`, {
			headers: doc,
			redirect: "manual",
		});
		const out = logged();
		expect(out).toContain("CLERK_PUBLISHABLE_KEY");
		expect(out).toContain("server-misconfigured");
		expect(out).toContain("client-iris");
		expect(out).not.toContain(ENV.CLERK_SECRET_KEY);
		expect(out).not.toContain(STATE_SECRET);
	});

	it("/health reads missing:CLERK_PUBLISHABLE_KEY", async () => {
		const res = await app.request(`${BASE}/health`);
		const body = (await res.json()) as { authorize: { handshake: string } };
		expect(body.authorize.handshake).toBe("missing:CLERK_PUBLISHABLE_KEY");
	});
});

describe("(a') publishable key set, secret missing", () => {
	it("refuses the same way, naming CLERK_SECRET_KEY", async () => {
		delete process.env.CLERK_SECRET_KEY;
		const state = await signedState();
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=${state}`,
			{ headers: doc, redirect: "manual" },
		);
		// Without the secret key readAuthorizeSettings may already answer 503;
		// either way the log must name the variable.
		expect(res.status).toBeGreaterThanOrEqual(500);
		expect(logged()).toContain("CLERK_SECRET_KEY");
		const health = (await (await app.request(`${BASE}/health`)).json()) as {
			authorize: { handshake: string };
		};
		expect(health.authorize.handshake).toBe("missing:CLERK_SECRET_KEY");
	});
});

describe("(b) both keys set", () => {
	it("takes the handshake path", async () => {
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=x&__clerk_db_jwt=dvb_abc`,
			{ headers: doc, redirect: "manual" },
		);
		expect(res.status).toBe(307);
		expect(res.headers.get("location") ?? "").toContain(
			`${FAPI}/v1/client/handshake`,
		);
	});

	it("/health reads configured", async () => {
		const res = await app.request(`${BASE}/health`);
		const body = (await res.json()) as { authorize: { handshake: string } };
		expect(body.authorize.handshake).toBe("configured");
	});
});

describe("(c) a Bearer session token", () => {
	it("is unchanged: no misconfiguration refusal even with the publishable key missing", async () => {
		delete process.env.CLERK_PUBLISHABLE_KEY;
		const state = await signedState();
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=${state}`,
			{
				headers: { ...doc, authorization: "Bearer not.a.real-token" },
				redirect: "manual",
			},
		);
		const body = (await res.json()) as { error_description: string };
		expect(body.error_description).not.toBe("server-misconfigured");
	});
});

describe("(c') one key set + a __session cookie on this host", () => {
	it("is served by resumeAuthorize, not refused server-misconfigured", async () => {
		delete process.env.CLERK_PUBLISHABLE_KEY;
		const state = await signedState();
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=${state}`,
			{
				headers: { ...doc, cookie: "__session=not.a.real-token" },
				redirect: "manual",
			},
		);
		const body = (await res.json()) as { error_description: string };
		// The cookie is judged by the package (here: not a valid token), which is
		// the same outcome as before this change; the misconfiguration refusal
		// is reserved for a request that carries no session at all.
		expect(body.error_description).not.toBe("server-misconfigured");
		expect(body.error_description).not.toBe("session-required");
	});
});

describe("(d) both keys set, signed out", () => {
	it("still answers session-required", async () => {
		const state = await signedState();
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=${state}`,
			{ redirect: "manual" },
		);
		const body = (await res.json()) as { error_description: string };
		expect(body.error_description).toBe("session-required");
		expect(logged()).toContain("session-required");
	});
});
