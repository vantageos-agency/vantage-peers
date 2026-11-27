/**
 * Regression test — list_diaries scope guard undefined-passes-through (v2.4.8 iter 2).
 *
 * Eta REVISE on iter 1 (PR #569) found a MAJOR security regression:
 * the non-master scope guard at tools.ts allowed undefined-passes-through,
 * returning up to 20 entries from ALL users when a non-master caller passed
 * no args (orchestrator=undefined, createdBy=undefined both satisfied
 * the old `!args.orchestrator` shorthand).
 *
 * Fix: REQUIRE at least one of orchestrator / createdBy to be one of the caller's
 * own verified identities. Task k17425xt3tjf8qkynefppcps1d8jdk5s widened "own" from
 * the bare userId to the resolved agent name and 'user:<subject>', and made an
 * unfiltered call default to the caller's own author instead of a refusal; the
 * behavioural poles live in test/list-diaries-own-agent.test.ts. What this static
 * file still pins: no undefined-shorthand fleet read, and the guard shape.
 *
 * These tests are STATIC (parse tools.ts source) — no Convex client needed.
 * They validate the fix pattern is present and that the forbidden undefined
 * shorthand is absent.
 *
 * Cases (the unfiltered non-master call now defaults to its own author, so it no
 * longer ends in Forbidden):
 * 1. no undefined-shorthand; strict membership in the caller's own identities
 * 2. a filter that is neither own identity → Forbidden
 * 3. the refusal names both filter options
 * 4. master bypasses the guard (isMasterScope)
 * 5. the own-identity set is built from verified values only
 *
 * Eta REVISE comment:
 * https://github.com/vantageos-agency/vantage-peers/pull/569#issuecomment-4591141712
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../tools.ts"), "utf-8");

function extractListDiariesGuardBlock(): string {
	// Anchor on the tool's NAME line — registration-shape-agnostic, matching both
	// the legacy `server.tool("list_diaries", …)` form and the mandatory-scope
	// `defineTool(server, authCtx, <scope>, "list_diaries", …)` wrapper (S2).
	const startRe = /^\t+"list_diaries",$/m;
	const m = startRe.exec(SRC);
	if (!m)
		throw new Error("Could not locate list_diaries registration in tools.ts");
	const tryIdx = SRC.indexOf("try {", m.index);
	if (tryIdx === -1)
		throw new Error("Could not find try{ in list_diaries handler");
	return SRC.slice(tryIdx, tryIdx + 3000);
}

describe("list_diaries scope guard — v2.4.8 iter 2 regression", () => {
	it("Test 1: guard block uses strict membership in the caller's own identities, not undefined-shorthand", () => {
		const body = extractListDiariesGuardBlock();
		expect(body).not.toMatch(/!\s*args\.orchestrator\b/);
		expect(body).not.toMatch(/!\s*args\.createdBy\b/);
		expect(body).toMatch(
			/orchestrator\s*!==\s*undefined\s*&&\s*own\.has\(orchestrator\)/,
		);
		expect(body).toMatch(
			/createdBy\s*!==\s*undefined\s*&&\s*own\.has\(createdBy\)/,
		);
	});

	it("Test 2: a supplied filter must be one of the caller's own identities (neither → Forbidden)", () => {
		const body = extractListDiariesGuardBlock();
		expect(body).toMatch(
			/!\(orchestrator\s*!==\s*undefined\s*&&\s*own\.has\(orchestrator\)\)\s*&&\s*!\(createdBy\s*!==\s*undefined\s*&&\s*own\.has\(createdBy\)\)/,
		);
	});

	it("Test 3: guard error message names both filter options (orchestrator or createdBy)", () => {
		const body = extractListDiariesGuardBlock();
		expect(body).toMatch(/Forbidden.*list_diaries/s);
		expect(body).toMatch(/orchestrator or createdBy/);
	});

	it("Test 4: master bypass is present (isMasterScope short-circuits the guard)", () => {
		const body = extractListDiariesGuardBlock();
		expect(body).toMatch(/isMasterScope\(oauthCtx\)/);
		expect(body).toMatch(/!\s*isMasterScope\(oauthCtx\)/);
	});

	it("Test 5: the own identities come from the verified context, never from an argument", () => {
		const body = extractListDiariesGuardBlock();
		expect(body).toMatch(/resolveActingAgent\(oauthCtx,\s*verifiedActor\)/);
		expect(body).toMatch(/oauthCtx\.userId/);
	});
});
