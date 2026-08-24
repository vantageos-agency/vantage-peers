/**
 * The master-token shortcut in bearerAuthMiddleware must use the constant-time
 * `validateMasterBearer` (@vantageos/cloud-identity) — the SAME comparator
 * masterOnlyMiddleware already uses — not a timing-variant
 * `token === masterToken` string compare. One secret, one comparator.
 *
 * Task k177v39m5w5t54mqf84mk9k0mn8czfwa. This asserts the FUNCTION IN USE, not
 * the outcome: validateMasterBearer is spied and forced to accept a token that
 * does NOT string-equal the configured secret. If the middleware still used
 * `token === masterToken`, the master branch would not be taken (the spy's
 * verdict would be ignored) and no master oauthContext would be set — so this
 * test is RED on the pre-fix head and GREEN only once the middleware routes the
 * decision through validateMasterBearer.
 */

import { describe, expect, it, vi } from "vitest";

const validateMasterBearerSpy = vi.fn();

vi.mock("@vantageos/cloud-identity", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@vantageos/cloud-identity")>();
	return {
		...actual,
		validateMasterBearer: (...args: unknown[]) =>
			validateMasterBearerSpy(...args),
	};
});

import { bearerAuthMiddleware } from "../auth.js";

type FakeCtx = {
	set: ReturnType<typeof vi.fn>;
	header: ReturnType<typeof vi.fn>;
	json: ReturnType<typeof vi.fn>;
	get: (k: string) => unknown;
	store: Record<string, unknown>;
	req: { header: (name: string) => string | undefined };
};

function buildCtx(headers: Record<string, string>): FakeCtx {
	const store: Record<string, unknown> = {};
	return {
		store,
		set: vi.fn((k: string, v: unknown) => {
			store[k] = v;
		}),
		header: vi.fn(),
		json: vi.fn((body: unknown, status?: number) => ({ body, status })),
		get: (k: string) => store[k],
		req: {
			header: (name: string) => headers[name.toLowerCase()],
		},
	};
}

describe("bearerAuthMiddleware master shortcut uses validateMasterBearer", () => {
	it("takes the master branch on the comparator's verdict, not string equality", async () => {
		process.env.BEARER_SECRET_MASTER = "the-configured-secret";
		process.env.CONVEX_URL_INTERNAL = "https://internal.convex.cloud";

		// The comparator ACCEPTS a token that does NOT equal the secret. A
		// `token === masterToken` implementation would reject it.
		validateMasterBearerSpy.mockResolvedValue({ ok: true });

		const ctx = buildCtx({
			host: "example.com",
			authorization: "Bearer a-token-that-differs-from-the-secret",
		});
		const next = vi.fn(async () => {});

		const mw = bearerAuthMiddleware();
		// biome-ignore lint/suspicious/noExplicitAny: minimal Hono context stub.
		await mw(ctx as any, next as any);

		// Function IN USE: called with (authHeader, masterSecret).
		expect(validateMasterBearerSpy).toHaveBeenCalledWith(
			"Bearer a-token-that-differs-from-the-secret",
			"the-configured-secret",
		);
		// Branch taken purely on the comparator's ok verdict.
		expect(next).toHaveBeenCalledTimes(1);
		const oauthContext = ctx.get("oauthContext") as
			| { scopeProfile?: string; isMaster?: boolean }
			| undefined;
		expect(oauthContext?.isMaster).toBe(true);
		expect(oauthContext?.scopeProfile).toBe("master");
	});
});
