/**
 * state-tokens.test.ts
 *
 * Pins the fail-closed contract for `resolveStateTokens` (Day 128 brief).
 *
 * Historical incidents replayed:
 *   1. A message asserted "PR #54 -> OPEN" hand-typed at compose time; by
 *      send time the PR had been MERGED. A token makes this class of bug
 *      structurally impossible: the value is resolved AT SEND TIME.
 *   2. A message asserted "latest 0.4.6-alpha" hand-typed at compose time;
 *      the registry's actual `latest` dist-tag was 0.4.7-alpha by send
 *      time. Same fix.
 *
 * Bipolar probe (three polarities, each must be non-empty and reported):
 *   - MUST_RESOLVE: tokens yield the live value + a resolution timestamp.
 *   - MUST_PASS: content with zero tokens (ratios, SHAs, diffs, past-tense
 *     prose) passes through completely unchanged — zero false positives.
 *   - MUST_FAIL_LOUD: unreachable network / nonexistent artifact rejects
 *     loudly, never silently substitutes a fallback value.
 */

import { describe, expect, it, vi } from "vitest";
import {
	hasStateTokens,
	resolveStateTokens,
	StateTokenError,
	type StateTokenResolutionDeps,
} from "../state-tokens.js";

const FIXED_NOW = new Date("2026-07-14T18:00:00.000Z");

function buildDeps(
	overrides: Partial<StateTokenResolutionDeps> = {},
): StateTokenResolutionDeps {
	return {
		fetchImpl: vi.fn(),
		convexQuery: vi.fn(),
		now: () => FIXED_NOW,
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
// Historical incident replay
// ─────────────────────────────────────────────────────────────────────────────

describe("historical incident replay", () => {
	it("incident 1: hand-typed 'OPEN' would have been stale — token resolves to MERGED at send time", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				state: "closed",
				merged: true,
				merge_commit_sha: "a1b2c3d",
				mergeable_state: "clean",
			}),
		);
		const deps = buildDeps({ fetchImpl });
		const content =
			"Status: PR -> {{pr:vantageos/vantage-peers#54}} (was hand-typed OPEN at compose time, now stale)";
		const resolved = await resolveStateTokens(content, deps);
		expect(resolved).toContain("MERGED");
		expect(resolved).not.toContain("{{pr:");
		expect(resolved).toContain("[resolved 2026-07-14T18:00:00.000Z]");
	});

	it("incident 2: hand-typed '0.4.6-alpha' would have been stale — token resolves to registry latest 0.4.7-alpha", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(200, { "dist-tags": { latest: "0.4.7-alpha" } }),
			);
		const deps = buildDeps({ fetchImpl });
		const content = "Published: {{npm:@vantageos/mcp-server}}";
		const resolved = await resolveStateTokens(content, deps);
		expect(resolved).toContain("0.4.7-alpha");
		expect(resolved).not.toContain("0.4.6-alpha"); // stale hand-typed value never appears
		expect(resolved).not.toContain("{{npm:");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MUST_RESOLVE — value + resolution instant, for all 3 token kinds
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST_RESOLVE", () => {
	it("pr token resolves to state + sha + mergeStateStatus + timestamp", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				state: "open",
				merged: false,
				head: { sha: "deadbeef" },
				mergeable_state: "unstable",
			}),
		);
		const resolved = await resolveStateTokens(
			"{{pr:vantageos/vantage-peers#100}}",
			buildDeps({ fetchImpl }),
		);
		expect(resolved).toBe(
			"PR #100 (vantageos/vantage-peers) -> OPEN @ deadbeef mergeStateStatus=unstable [resolved 2026-07-14T18:00:00.000Z]",
		);
	});

	it("npm token resolves to dist-tag version + timestamp", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(200, {
				"dist-tags": { latest: "1.2.3", beta: "1.3.0-beta.1" },
			}),
		);
		const resolved = await resolveStateTokens(
			"{{npm:vantage-peers@beta}}",
			buildDeps({ fetchImpl }),
		);
		expect(resolved).toBe(
			"vantage-peers@beta -> 1.3.0-beta.1 [resolved 2026-07-14T18:00:00.000Z]",
		);
	});

	it("task token resolves to live status + timestamp", async () => {
		const convexQuery = vi.fn().mockResolvedValue({ status: "in_progress" });
		const resolved = await resolveStateTokens(
			"{{task:k17abc123}}",
			buildDeps({ convexQuery }),
		);
		expect(resolved).toBe(
			"task k17abc123 -> in_progress [resolved 2026-07-14T18:00:00.000Z]",
		);
		expect(convexQuery).toHaveBeenCalledWith("tasks:get", {
			taskId: "k17abc123",
		});
	});

	it("multiple tokens in one message all resolve independently", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(200, {
					state: "open",
					merged: false,
					head: { sha: "aaa" },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, { "dist-tags": { latest: "2.0.0" } }),
			);
		const resolved = await resolveStateTokens(
			"{{pr:org/repo#1}} and {{npm:pkg}}",
			buildDeps({ fetchImpl }),
		);
		expect(resolved).toContain("PR #1 (org/repo) -> OPEN");
		expect(resolved).toContain("pkg@latest -> 2.0.0");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MUST_PASS — zero-token / content-proof messages pass through UNTOUCHED
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST_PASS — content proofs never modified, zero false positives", () => {
	const deps = buildDeps();
	let falsePositives = 0;

	async function assertUnchanged(content: string) {
		const resolved = await resolveStateTokens(content, deps);
		if (resolved !== content) falsePositives++;
		expect(resolved).toBe(content);
	}

	it("test ratio prose passes intact (788/788)", async () => {
		await assertUnchanged("All green: 788/788 tests passing on CI run #42.");
	});

	it("bare commit SHA prose passes intact", async () => {
		await assertUnchanged("Reviewed commit a1b2c3d4e5f6 line by line, LGTM.");
	});

	it("diff-shaped prose passes intact", async () => {
		await assertUnchanged(
			"- old line removed\n+ new line added\n  context line unchanged",
		);
	});

	it("past-tense narrative referencing a PR state does NOT get treated as a token", async () => {
		await assertUnchanged(
			"At the time I gated, #54 was OPEN — that observation is a historical fact, not a live claim.",
		);
	});

	it("content with no braces at all passes intact", async () => {
		await assertUnchanged("Simple handoff note, no artifacts referenced.");
	});

	it("reports zero false positives across all content-proof probes", () => {
		expect(falsePositives).toBe(0);
	});

	it("fetchImpl and convexQuery are never invoked when there are no tokens", async () => {
		const localDeps = buildDeps();
		await resolveStateTokens(
			"788/788, SHA a1b2c3d, no tokens here.",
			localDeps,
		);
		expect(localDeps.fetchImpl).not.toHaveBeenCalled();
		expect(localDeps.convexQuery).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MUST_FAIL_LOUD — unreachable / nonexistent artifacts reject, never silent
// ─────────────────────────────────────────────────────────────────────────────

describe("MUST_FAIL_LOUD", () => {
	it("GitHub unreachable (network throw) rejects with StateTokenError, not a silent fallback", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(
			resolveStateTokens("{{pr:org/repo#1}}", buildDeps({ fetchImpl })),
		).rejects.toThrow(StateTokenError);
	});

	it("npm registry unreachable rejects loudly", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
		await expect(
			resolveStateTokens("{{npm:some-pkg}}", buildDeps({ fetchImpl })),
		).rejects.toThrow(StateTokenError);
	});

	it("nonexistent PR (GitHub 404) rejects loudly, does not render 'unknown' silently", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));
		await expect(
			resolveStateTokens("{{pr:org/repo#999999}}", buildDeps({ fetchImpl })),
		).rejects.toThrow(/not found/);
	});

	it("nonexistent npm package (404) rejects loudly", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));
		await expect(
			resolveStateTokens(
				"{{npm:this-package-does-not-exist-anywhere}}",
				buildDeps({ fetchImpl }),
			),
		).rejects.toThrow(/not found/);
	});

	it("nonexistent task (Convex returns null) rejects loudly, never renders empty/unknown", async () => {
		const convexQuery = vi.fn().mockResolvedValue(null);
		await expect(
			resolveStateTokens("{{task:kFAKE_TASK_ID}}", buildDeps({ convexQuery })),
		).rejects.toThrow(/does not exist/);
	});

	it("malformed pr reference rejects loudly instead of silently passing through", async () => {
		await expect(
			resolveStateTokens("{{pr:not-a-valid-ref}}", buildDeps()),
		).rejects.toThrow(StateTokenError);
	});

	it("Convex query throwing (e.g. malformed id) rejects loudly, not silently", async () => {
		const convexQuery = vi
			.fn()
			.mockRejectedValue(new Error("ArgumentValidationError"));
		await expect(
			resolveStateTokens("{{task:bad id}}", buildDeps({ convexQuery })),
		).rejects.toThrow(StateTokenError);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// hasStateTokens helper
// ─────────────────────────────────────────────────────────────────────────────

describe("hasStateTokens", () => {
	it("returns false for content with no tokens", () => {
		expect(hasStateTokens("788/788 passing, sha a1b2c3d")).toBe(false);
	});

	it("returns true for content with a token", () => {
		expect(hasStateTokens("{{task:k17abc}}")).toBe(true);
	});
});
