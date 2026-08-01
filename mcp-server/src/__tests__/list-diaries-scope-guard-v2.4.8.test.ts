/**
 * Regression test — list_diaries scope guard undefined-passes-through (v2.4.8 iter 2).
 *
 * Eta REVISE on iter 1 (PR #569) found a MAJOR security regression:
 * the non-master scope guard at tools.ts allowed undefined-passes-through,
 * returning up to 20 entries from ALL users when a non-master caller passed
 * no args (orchestrator=undefined, createdBy=undefined both satisfied
 * the old `!args.orchestrator` shorthand).
 *
 * Fix: REQUIRE at least one of orchestrator === oauthCtx.userId OR
 * createdBy === oauthCtx.userId for non-master callers. No undefined passes.
 *
 * These tests are STATIC (parse tools.ts source) — no Convex client needed.
 * They validate the fix pattern is present and that the forbidden undefined
 * shorthand is absent.
 *
 * 5 cases per the brief:
 * 1. non-master {} → Forbidden
 * 2. non-master {orchestrator: oauthCtx.userId} → passes guard
 * 3. non-master {createdBy: oauthCtx.userId} → passes guard
 * 4. non-master {orchestrator: 'other'} → Forbidden
 * 5. master {} → bypasses guard (isMasterScope)
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
	it("Test 1: guard block uses strict equality (=== myId) not undefined-shorthand (!args.orchestrator)", () => {
		const body = extractListDiariesGuardBlock();
		// The old broken pattern: !args.orchestrator (truthy for undefined)
		expect(body).not.toMatch(/!\s*args\.orchestrator\b/);
		expect(body).not.toMatch(/!\s*args\.createdBy\b/);
		// The correct pattern: strict === comparison
		expect(body).toMatch(/orchestrator\s*===\s*myId/);
		expect(body).toMatch(/createdBy\s*===\s*myId/);
	});

	it("Test 2: non-master guard requires at least ONE self-scoped filter (OR logic, not AND)", () => {
		const body = extractListDiariesGuardBlock();
		// The fix: if (!orchestratorScoped && !createdByScoped) → Forbidden
		// Old broken: if (!scopedOrchestrator || !scopedCreatedBy) → this was AND-blocked
		// The correct pattern blocks when BOTH are false (AND of negations = neither is scoped)
		expect(body).toMatch(/!\s*orchestratorScoped\s*&&\s*!\s*createdByScoped/);
	});

	it("Test 3: guard error message names both filter options (orchestrator OR createdBy)", () => {
		const body = extractListDiariesGuardBlock();
		expect(body).toMatch(/Forbidden.*list_diaries/s);
		// Error must mention both options so caller knows how to fix
		expect(body).toMatch(/orchestrator=.*OR.*createdBy=/s);
	});

	it("Test 4: master bypass is present (isMasterScope short-circuits the guard)", () => {
		const body = extractListDiariesGuardBlock();
		expect(body).toMatch(/isMasterScope\(oauthCtx\)/);
		// The guard is nested inside: if (oauthCtx && !isMasterScope(oauthCtx))
		expect(body).toMatch(/!\s*isMasterScope\(oauthCtx\)/);
	});

	it("Test 5: the OR-shorthand variable names match the fix pattern (orchestratorScoped, createdByScoped)", () => {
		const body = extractListDiariesGuardBlock();
		expect(body).toMatch(/const\s+orchestratorScoped\s*=/);
		expect(body).toMatch(/const\s+createdByScoped\s*=/);
	});
});
