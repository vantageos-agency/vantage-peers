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
	BareStateLiteralError,
	countStateEvidenceAdoption,
	FreshStateGuardError,
	type FreshStateGuardDeps,
	getStateEvidenceAdoption,
	guardFreshState,
	resetStateEvidenceAdoption,
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
		const content = "evidence: gh pr view 54 -R owner/repo --json state -> OPEN";

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
		const content = `evidence: gh pr view 54 -R owner/repo --json state -> ${falseClaim}`;

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
		const content = `evidence: npm view some-pkg dist-tags -> some-pkg@alpha -> ${falseVersion}`;

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
		const content = `evidence: get_task k1234567890 -> task k1234567890 -> ${falseStatus}`;

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

// ─── MUST_REFUSE ──────────────────────────────────────────────────────────────
// The third pole (Eta, Day 131). MUST_BLOCK and MUST_PASS prove the guard tells
// the sound from the false. They say NOTHING about what it does when its
// instrument is taken away — which is precisely the hypothesis that breaks in
// production. A guard has three outcomes, never two: it passed, it bit, or IT
// COULD NOT MEASURE.
//
// This guard is fail-OPEN on "cannot verify" (declared, and argued in the module
// docstring: it is a net over prose the author never marked as a live claim, and
// blocking a legitimate message on a network failure rebuilds the very "silence
// read as good news" the doctrine exists to kill).
//
// But fail-open MUST NOT mean FAIL-SILENT — and it was. The warning went to the
// server's own console, where the orchestrator who sent the message never sees
// it. From the caller's side, "GitHub was unreachable" and "your claim checks
// out" rendered THE SAME SCREEN. That is the defect, in the guard written to
// prosecute it, shipped by its own author on the same day.
describe("MUST_REFUSE pole — the inability must reach the CALLER, not a console", () => {
	it("names what it could not read, and hands that back to whoever sent the message", async () => {
		const seen: string[] = [];
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
		const deps = buildDeps({ fetchImpl, warn: (m: string) => seen.push(m) });

		await expect(
			guardFreshState(
				"evidence: gh pr view 54 -R owner/repo --json state -> PR #54 (owner/repo) -> OPEN",
				deps,
			),
		).resolves.toBeUndefined();

		// Allowed — but never silently. The caller must be able to tell a pass
		// from an unmeasured pass, or the absence of a verdict becomes a verdict.
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/unreachable/i);
		expect(seen[0]).toMatch(/PR #54/);
		expect(seen[0]).toMatch(/owner\/repo/);
	});
});

// ─── BARE LITERAL (Pi ruling, option b) ───────────────────────────────────────
// A live-state literal on an `evidence:` line is refused when the SAME line
// carries no command, even when the literal is TRUE. "A claim carries the
// command that produced it" (.claude/rules/a-claim-carries-its-command.md).
describe("bare live-state literal on an evidence: line", () => {
	// The live value is injected and the typed literal is DERIVED from it, so
	// the claim below is TRUE by construction. It is refused anyway.
	const liveBody = { state: "closed", merged: true };
	const liveState = liveBody.merged ? "MERGED" : "OPEN";
	const trueLive = () =>
		vi.fn().mockResolvedValue(jsonResponse(200, liveBody));

	it("MUST_BLOCK: a TRUE bare PR state is refused, and the error names both legal forms", async () => {
		const fetchImpl = trueLive();
		const deps = buildDeps({ fetchImpl, log: vi.fn() });
		const content = `evidence: PR #1092 -> ${liveState}`;

		await expect(guardFreshState(content, deps)).rejects.toThrow(
			BareStateLiteralError,
		);
		const err = await guardFreshState(content, deps).catch((e: unknown) => e);
		const msg = (err as Error).message;
		expect(msg).toContain(liveState);
		// legal form 1: the command that produced it, on the same line
		expect(msg).toMatch(/gh pr view/);
		expect(msg).toMatch(/same line/i);
		// legal form 2: the token
		expect(msg).toContain("{{pr:");
	});

	it("MUST_BLOCK: a TRUE bare npm dist-tag and a TRUE bare task status are refused", async () => {
		const deps = buildDeps({ log: vi.fn() });
		await expect(
			guardFreshState("evidence: some-pkg@alpha -> 0.4.7", deps),
		).rejects.toThrow(BareStateLiteralError);
		await expect(
			guardFreshState("evidence: task k1234567890 -> done", deps),
		).rejects.toThrow(BareStateLiteralError);
	});

	it("MUST_BLOCK: a command on ANOTHER evidence line does not excuse the bare line", async () => {
		const deps = buildDeps({ log: vi.fn() });
		const content =
			"evidence: gh pr view 1 -R o/r --json state -> OPEN\n" +
			"PR #1092 -> MERGED";
		await expect(guardFreshState(content, deps)).rejects.toThrow(
			BareStateLiteralError,
		);
	});

	it.each([
		["gh", "evidence: gh pr view 1092 -R o/r --json state -> MERGED"],
		["git", "evidence: git log -1 --format=%s -> PR #1092 -> MERGED"],
		["npm view", "evidence: npm view some-pkg dist-tags -> some-pkg@alpha -> 0.4.7"],
		["tool call name", "evidence: get_task k1234567890 -> task k1234567890 -> done"],
		["curl", "evidence: curl -s https://api.github.com/repos/o/r/pulls/1092 -> PR #1092 -> MERGED"],
	])("MUST_PASS: a command line (%s) carrying a TRUE state is allowed", async (_name, content) => {
		const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
			String(url).includes("npmjs")
				? jsonResponse(200, { "dist-tags": { alpha: "0.4.7" } })
				: jsonResponse(200, liveBody),
		);
		const convexQuery = vi.fn().mockResolvedValue({ status: "done" });
		const deps = buildDeps({ fetchImpl, convexQuery, log: vi.fn(), defaultRepo: "o/r" });
		await expect(guardFreshState(content, deps)).resolves.toBeUndefined();
	});

	it("MUST_PASS: a resolved token ({{pr:..}} after resolution) is allowed", async () => {
		const deps = buildDeps({ fetchImpl: trueLive(), log: vi.fn() });
		const content =
			`evidence: PR #1092 (o/r) -> ${liveState} @ abc1234 mergeStateStatus=CLEAN ` +
			"[resolved 2026-07-14T18:00:00.000Z]";
		await expect(guardFreshState(content, deps)).resolves.toBeUndefined();
	});

	it("MUST_PASS: the unresolved token, SHA pin, ratio and count pins", async () => {
		const fetchImpl = vi.fn();
		const deps = buildDeps({ fetchImpl, log: vi.fn() });
		for (const content of [
			"evidence: {{pr:o/r#1092}}",
			"evidence: ETA_APPROVED_COMMIT_SHA=abc1234",
			"evidence: ratio 788/788",
			"evidence: 18 tests, 7 files",
		]) {
			await expect(guardFreshState(content, deps)).resolves.toBeUndefined();
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("MUST_PASS: narration outside evidence: is never scanned", async () => {
		const deps = buildDeps({ log: vi.fn() });
		for (const content of [
			"finding: at the time I gated it, PR #870 -> OPEN",
			"action: PR #870 -> OPEN",
			"next: task k1234567890 -> done",
		]) {
			await expect(guardFreshState(content, deps)).resolves.toBeUndefined();
		}
	});

	it("MUST_REFUSE (existing): a command line whose state is FALSE is still refused", async () => {
		const falseClaim = liveState === "MERGED" ? "OPEN" : "MERGED";
		const deps = buildDeps({ fetchImpl: trueLive(), log: vi.fn() });
		await expect(
			guardFreshState(
				`evidence: gh pr view 1092 -R o/r --json state -> PR #1092 (o/r) -> ${falseClaim}`,
				deps,
			),
		).rejects.toThrow(FreshStateGuardError);
	});

	it("unresolvable network on a command line: unchanged, allowed with a stated warning", async () => {
		const warn = vi.fn();
		const deps = buildDeps({
			fetchImpl: vi.fn().mockRejectedValue(new Error("ETIMEDOUT")),
			warn,
			log: vi.fn(),
		});
		await expect(
			guardFreshState(
				"evidence: gh pr view 54 -R o/r --json state -> PR #54 (o/r) -> OPEN",
				deps,
			),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("the override marker still lets a verbatim historical bare citation through", async () => {
		const deps = buildDeps({ log: vi.fn() });
		await expect(
			guardFreshState(
				"evidence: PR #1092 -> MERGED // allow-stale-state-claim: verbatim citation",
				deps,
			),
		).resolves.toBeUndefined();
	});
});

describe("adoption counter", () => {
	it("countStateEvidenceAdoption classifies evidence lines by token / command / bare literal", () => {
		const messages = [
			"evidence: {{pr:o/r#1}}",
			"evidence: PR #1 (o/r) -> OPEN @ abc [resolved 2026-07-14T18:00:00.000Z]",
			"evidence: gh pr view 2 --json state -> PR #2 -> MERGED",
			"evidence: PR #3 -> CLOSED",
			"evidence: ratio 788/788",
			"finding: PR #4 -> OPEN",
		];
		expect(countStateEvidenceAdoption(messages)).toEqual({
			withToken: 2,
			withCommand: 1,
			bareLiteralRefused: 1,
		});
	});

	it("a single message string is accepted and an empty list is all zeros", () => {
		expect(countStateEvidenceAdoption("evidence: PR #3 -> CLOSED")).toEqual({
			withToken: 0,
			withCommand: 0,
			bareLiteralRefused: 1,
		});
		expect(countStateEvidenceAdoption([])).toEqual({
			withToken: 0,
			withCommand: 0,
			bareLiteralRefused: 0,
		});
	});

	it("the guard accumulates the counter in memory and writes one log line", async () => {
		resetStateEvidenceAdoption();
		const log = vi.fn();
		const deps = buildDeps({
			fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { state: "open" })),
			log,
		});
		await guardFreshState("evidence: {{pr:o/r#1}}", deps);
		await guardFreshState(
			"evidence: gh pr view 2 -R o/r --json state -> PR #2 (o/r) -> OPEN",
			deps,
		);
		await guardFreshState("evidence: PR #3 -> CLOSED", deps).catch(() => undefined);
		expect(getStateEvidenceAdoption()).toEqual({
			withToken: 1,
			withCommand: 1,
			bareLiteralRefused: 1,
		});
		expect(log).toHaveBeenCalledTimes(3);
		expect(String(log.mock.calls[2][0])).toContain("bareLiteralRefused=1");
	});
});

// ─── SPELLING VARIANTS (Eta REVISE, PR #1593) ─────────────────────────────────
// The bare-literal refusal must not hinge on spelling: state words in any case,
// `->` or the single-char arrow, an optional `#`, and a task id with its status.
describe("bare literal spellings", () => {
	const liveBody = { state: "closed", merged: true }; // live -> MERGED
	const liveStatus = "done";

	// [label, bare line, same claim prefixed with the command that produced it]
	const spellings: Array<[string, string, string]> = [
		[
			"lowercase state word",
			"evidence: PR #1092 -> merged",
			"evidence: gh pr view 1092 -R o/r --json state: PR #1092 -> merged",
		],
		[
			"unicode arrow",
			"evidence: PR #1092 \u2192 MERGED",
			"evidence: gh pr view 1092 -R o/r --json state: PR #1092 \u2192 MERGED",
		],
		[
			"no hash",
			"evidence: PR 1592 -> MERGED",
			"evidence: gh pr view 1592 -R o/r --json state: PR 1592 -> MERGED",
		],
		[
			"uppercase task status",
			"evidence: task k1234567890 -> DONE",
			"evidence: get_task k1234567890: task k1234567890 -> DONE",
		],
	];

	const livePass = () =>
		buildDeps({
			fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, liveBody)),
			convexQuery: vi.fn().mockResolvedValue({ status: liveStatus }),
			defaultRepo: "o/r",
			log: vi.fn(),
		});

	it.each(spellings)("MUST_BLOCK: %s, bare", async (_label, bare) => {
		await expect(guardFreshState(bare, livePass())).rejects.toThrow(
			BareStateLiteralError,
		);
	});

	it.each(spellings)(
		"MUST_PASS: %s, with its command (true state)",
		async (_label, _bare, withCommand) => {
			await expect(
				guardFreshState(withCommand, livePass()),
			).resolves.toBeUndefined();
		},
	);

	it("MUST_REFUSE: a command line with a FALSE state in a variant spelling is still refused", async () => {
		await expect(
			guardFreshState(
				"evidence: gh pr view 1092 -R o/r --json state: PR 1092 \u2192 open",
				livePass(),
			),
		).rejects.toThrow(FreshStateGuardError);
		await expect(
			guardFreshState(
				"evidence: get_task k1234567890: task k1234567890 -> TODO",
				livePass(),
			),
		).rejects.toThrow(FreshStateGuardError);
	});

	it("a prose word that merely looks like an id is not a claim", async () => {
		await expect(
			guardFreshState("evidence: keyboard -> done", livePass()),
		).resolves.toBeUndefined();
	});
});
