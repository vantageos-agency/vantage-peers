/**
 * fresh-state-guard.test.ts
 *
 * Pins Layer 2's contract: refuse hand-typed living-artifact state claims
 * in `evidence:` that contradict the live source, while never touching
 * narration (`finding:`, `action:`, `next:`) and never blocking on a
 * network failure ("cannot verify" is fail-OPEN — distinct from Layer 1's
 * fail-closed token resolver).
 *
 * MUST_PASS pole and MUST_BLOCK pole are both required — a guard that only
 * proves one polarity proves nothing (see brief and
 * tests/hooks/test_enforce_fresh_state_in_messages.py in the Python port
 * for the twin doctrine).
 */

import { describe, expect, it, vi } from "vitest";
import {
	FreshStateGuardError,
	type FreshStateGuardDeps,
	guardFreshState,
} from "../fresh-state-guard.js";

const FIXED_NOW = new Date("2026-07-14T18:00:00.000Z");

function buildDeps(
	overrides: Partial<FreshStateGuardDeps> = {},
): FreshStateGuardDeps {
	return {
		fetchImpl: vi.fn(),
		convexQuery: vi.fn(),
		now: () => FIXED_NOW,
		warn: vi.fn(),
		...overrides,
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

// ─────────────────────────────────────────────────────────────────────────────
// MUST_PASS pole
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST_PASS pole", () => {
	it("historical citation in arrow form OUTSIDE evidence: is allowed", async () => {
		const fetchImpl = vi.fn();
		const deps = buildDeps({ fetchImpl });
		const content =
			"finding: at the time I gated it, PR #870 (owner/repo) -> OPEN — " +
			"that is what I cited, and it was true.";

		await expect(guardFreshState(content, deps)).resolves.toBeUndefined();
		// Never even attempted network verification — scope excluded it.
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("content proofs only (ratios and SHAs) in evidence: are allowed", async () => {
		const fetchImpl = vi.fn();
		const deps = buildDeps({ fetchImpl });
		const content = "evidence: npx vitest run -> 788/788 ; git rev-parse HEAD -> f972cd9";

		await expect(guardFreshState(content, deps)).resolves.toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("arrow in action: (routing, not a state assertion) is allowed", async () => {
		const fetchImpl = vi.fn();
		const deps = buildDeps({ fetchImpl });
		const content = "action: route this -> pi-vps for review";

		await expect(guardFreshState(content, deps)).resolves.toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("no claim at all is allowed", async () => {
		const deps = buildDeps();
		await expect(
			guardFreshState("just a plain message, nothing special", deps),
		).resolves.toBeUndefined();
	});

	it("a claim whose live state CANNOT be resolved is allowed, with a warning", async () => {
		const warn = vi.fn();
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
		const deps = buildDeps({ fetchImpl, warn });
		const content = "evidence: PR #54 (owner/repo) -> OPEN";

		await expect(guardFreshState(content, deps)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toMatch(/unreachable/i);
		expect(warn.mock.calls[0][0]).toMatch(/allowing/i);
	});

	it("override marker allows an otherwise-contradicting claim", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(200, { state: "closed", merged: true }),
		);
		const deps = buildDeps({ fetchImpl });
		const content =
			"evidence: PR #54 (owner/repo) -> OPEN " +
			"// allow-stale-state-claim: verbatim historical citation";

		await expect(guardFreshState(content, deps)).resolves.toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MUST_BLOCK pole
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST_BLOCK pole", () => {
	it("evidence: PR state claim contradicting the live value is refused, citing both values and the replacement token", async () => {
		// Derive the false claim from the injected live value — never hardcode
		// a live state in the test (that is the exact bug that broke main).
		const liveBody = { state: "closed", merged: true }; // live -> MERGED
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, liveBody));
		const deps = buildDeps({ fetchImpl });

		const liveState = liveBody.merged ? "MERGED" : "OPEN";
		const falseClaim = liveState === "MERGED" ? "OPEN" : "MERGED";
		const content = `evidence: PR #54 (owner/repo) -> ${falseClaim}`;

		await expect(guardFreshState(content, deps)).rejects.toThrow(
			FreshStateGuardError,
		);

		try {
			await guardFreshState(content, deps);
			throw new Error("expected guardFreshState to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(FreshStateGuardError);
			const guardErr = err as FreshStateGuardError;
			expect(guardErr.message).toContain(falseClaim);
			expect(guardErr.message).toContain(liveState);
			expect(guardErr.message).toContain("{{pr:owner/repo#54}}");
		}
	});

	it("evidence: npm state claim contradicting the live dist-tag is refused", async () => {
		const liveVersion = "0.4.7-alpha";
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(200, { "dist-tags": { alpha: liveVersion } }),
		);
		const deps = buildDeps({ fetchImpl });
		const falseVersion = "0.4.6-alpha";
		const content = `evidence: some-pkg@alpha -> ${falseVersion}`;

		await expect(guardFreshState(content, deps)).rejects.toThrow(
			FreshStateGuardError,
		);
		try {
			await guardFreshState(content, deps);
		} catch (err) {
			const guardErr = err as FreshStateGuardError;
			expect(guardErr.message).toContain(falseVersion);
			expect(guardErr.message).toContain(liveVersion);
			expect(guardErr.message).toContain("{{npm:some-pkg@alpha}}");
		}
	});

	it("evidence: task state claim contradicting the live Convex status is refused", async () => {
		const liveStatus = "done";
		const convexQuery = vi.fn().mockResolvedValue({ status: liveStatus });
		const deps = buildDeps({ convexQuery });
		const falseStatus = "todo";
		const content = `evidence: task k1234567890 -> ${falseStatus}`;

		await expect(guardFreshState(content, deps)).rejects.toThrow(
			FreshStateGuardError,
		);
		try {
			await guardFreshState(content, deps);
		} catch (err) {
			const guardErr = err as FreshStateGuardError;
			expect(guardErr.message).toContain(falseStatus);
			expect(guardErr.message).toContain(liveStatus);
			expect(guardErr.message).toContain("{{task:k1234567890}}");
		}
	});
});
