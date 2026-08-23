/**
 * P-T1 — getScopedUserToken: mints a Clerk-NATIVE session JWT for an
 * ARBITRARY Clerk userId, distinct from the fixed service-account user
 * (mcp-server/src/serviceAccountAuth.ts).
 *
 * UNIT test: the Clerk Backend/Frontend API calls are injected via
 * _setScopedUserTokenDepsForTest, so no live network call to Clerk happens
 * here. Proves OUR wiring (ticket -> session -> native token, no template)
 * is correct; the live end-to-end mint against a real Clerk instance is the
 * task's separate network proof step.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
	_setScopedUserTokenDepsForTest,
	getScopedUserToken,
	type ScopedUserTokenDeps,
} from "../serviceAccountAuth.js";

afterEach(() => {
	_setScopedUserTokenDepsForTest(null);
});

function fakeNativeJwt(): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
		"base64url",
	);
	const payload = Buffer.from(
		JSON.stringify({
			sub: "user_3FXI326OF3bgUd6OnOgUcAYY9ip",
			org_id: "org_perello",
			org_role: "org:admin",
			org_slug: "perello-consulting-1782214787064836324",
			aud: "convex",
			exp: Math.floor(Date.now() / 1000) + 60,
		}),
	).toString("base64url");
	return `${header}.${payload}.`;
}

describe("getScopedUserToken", () => {
	test("returns null when CLERK_SECRET_KEY is not configured", async () => {
		const previous = process.env.CLERK_SECRET_KEY;
		delete process.env.CLERK_SECRET_KEY;
		try {
			const token = await getScopedUserToken("user_3FXI326OF3bgUd6OnOgUcAYY9ip");
			expect(token).toBeNull();
		} finally {
			if (previous !== undefined) process.env.CLERK_SECRET_KEY = previous;
		}
	});

	test("mints a NATIVE (no-template) session token for an arbitrary scoped user, distinct from the fixed service account", async () => {
		const previous = process.env.CLERK_SECRET_KEY;
		process.env.CLERK_SECRET_KEY = "test-secret-key";
		try {
			const createSignInTicket = vi.fn().mockResolvedValue("ticket-scoped");
			const exchangeTicketForSession = vi
				.fn()
				.mockResolvedValue("sess_scoped_1");
			const getNativeSessionToken = vi.fn().mockResolvedValue({
				jwt: fakeNativeJwt(),
				exp: Date.now() + 60_000,
			});
			const deps: ScopedUserTokenDeps = {
				createSignInTicket,
				exchangeTicketForSession,
				getNativeSessionToken,
			};
			_setScopedUserTokenDepsForTest(deps);

			const jwt = await getScopedUserToken(
				"user_3FXI326OF3bgUd6OnOgUcAYY9ip",
				"org_perello",
			);

			expect(createSignInTicket).toHaveBeenCalledWith(
				"user_3FXI326OF3bgUd6OnOgUcAYY9ip",
				"org_perello",
			);
			expect(exchangeTicketForSession).toHaveBeenCalledWith(
				"ticket-scoped",
				expect.any(String),
			);
			// NATIVE path: getNativeSessionToken takes no template argument at all
			// (distinct from getServiceAccountToken's getSessionToken(id, "convex")).
			expect(getNativeSessionToken).toHaveBeenCalledWith("sess_scoped_1");
			expect(jwt).not.toBeNull();

			const payload = JSON.parse(
				Buffer.from(jwt!.split(".")[1], "base64url").toString("utf-8"),
			);
			expect(payload.org_id).toBe("org_perello");
			expect(payload.org_role).toBe("org:admin");
			expect(payload.org_slug).toBe(
				"perello-consulting-1782214787064836324",
			);
			expect(payload.aud).toBe("convex");
		} finally {
			if (previous !== undefined) {
				process.env.CLERK_SECRET_KEY = previous;
			} else {
				delete process.env.CLERK_SECRET_KEY;
			}
		}
	});
});
