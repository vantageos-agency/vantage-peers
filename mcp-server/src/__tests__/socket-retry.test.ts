/**
 * Pins the single-retry-on-dead-keep-alive-socket behaviour in
 * mcp-server/src/socketRetry.ts.
 *
 * Incident (2026-09-08, Railway log 12:36:15 UTC+2): "The socket connection
 * was closed unexpectedly" on a reused keep-alive fetch to Convex — no
 * retry existed anywhere before this fix (see socketRetry.ts's module doc
 * for the duplication-risk analysis behind scoping this to `query` only).
 *
 * RED-then-GREEN: the "retries exactly once" test below is written to fail
 * before withSingleRetryOnSocketClose exists / retries. It is included here
 * (not as a separate ephemeral file) so the bipolar proof is reproducible:
 * `git stash` the production file (socketRetry.ts) and re-run this suite to
 * see it fail again.
 */

import { describe, expect, it, vi } from "vitest";
import {
	isSocketCloseError,
	withSingleRetryOnSocketClose,
} from "../socketRetry.js";

function socketCloseError(): Error {
	return new Error("The socket connection was closed unexpectedly");
}

describe("isSocketCloseError — predicate", () => {
	it("matches the exact incident message", () => {
		expect(isSocketCloseError(socketCloseError())).toBe(true);
	});

	it("matches undici's UND_ERR_SOCKET code", () => {
		const err = new Error("fetch failed");
		(err as unknown as { code: string }).code = "UND_ERR_SOCKET";
		expect(isSocketCloseError(err)).toBe(true);
	});

	it("matches a nested cause carrying the socket-close message", () => {
		const cause = new Error("The socket connection was closed unexpectedly");
		const err = new Error("fetch failed", { cause });
		expect(isSocketCloseError(err)).toBe(true);
	});

	it("matches ECONNRESET / socket hang up", () => {
		expect(isSocketCloseError(new Error("socket hang up"))).toBe(true);
		const err = new Error("read ECONNRESET");
		expect(isSocketCloseError(err)).toBe(true);
	});

	it("does NOT match an unrelated error (RBAC_DENIED)", () => {
		expect(isSocketCloseError(new Error("RBAC_DENIED: not allowed"))).toBe(
			false,
		);
	});

	it("does NOT match a non-Error thrown value", () => {
		expect(isSocketCloseError("just a string")).toBe(false);
		expect(isSocketCloseError(null)).toBe(false);
		expect(isSocketCloseError(undefined)).toBe(false);
	});
});

describe("withSingleRetryOnSocketClose — RED/GREEN: socket-close on attempt 1, success on attempt 2", () => {
	it("the caller receives the value from the second attempt", async () => {
		const dep = vi
			.fn()
			.mockRejectedValueOnce(socketCloseError())
			.mockResolvedValueOnce("second-attempt-value");

		const result = await withSingleRetryOnSocketClose(dep);

		expect(result).toBe("second-attempt-value");
		expect(dep).toHaveBeenCalledTimes(2);
	});
});

describe("withSingleRetryOnSocketClose — NEGATIVE pole: non-socket error propagates on first throw", () => {
	it("RBAC_DENIED propagates immediately with exactly ONE underlying call", async () => {
		const dep = vi.fn().mockRejectedValue(new Error("RBAC_DENIED: not allowed"));

		await expect(withSingleRetryOnSocketClose(dep)).rejects.toThrow(
			"RBAC_DENIED",
		);
		expect(dep).toHaveBeenCalledTimes(1);
	});
});

describe("withSingleRetryOnSocketClose — COUNTED control: exactly one retry, never a loop", () => {
	it("both attempts throw socket-close: the final error escapes, dep called exactly 2 times", async () => {
		const dep = vi.fn().mockRejectedValue(socketCloseError());

		await expect(withSingleRetryOnSocketClose(dep)).rejects.toThrow(
			"socket connection was closed unexpectedly",
		);
		expect(dep).toHaveBeenCalledTimes(2);
	});
});
