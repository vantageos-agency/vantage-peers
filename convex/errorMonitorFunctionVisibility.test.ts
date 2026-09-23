import { describe, expect, test } from "vitest";
import { classifyRefusal } from "./errorMonitorRefusalClassifier";
import { resolveFunctionVisibility } from "./errorMonitorFunctionVisibility";

// =============================================================================
// Task k17a2hpeffm3hdfcym8z0h9tas8ezre2 -- correcting PR #1326's own body.
//
// PR #1326 claimed "133 closed auto-issues... 26 distinct functions... 25
// public" while the shipped REGISTRY held exactly 3 modules, of which only
// `tasks` appeared in that history at all. This file is the permanent
// regression coverage the claim should have shipped with: one assertion per
// corpus-named function this REGISTRY now actually resolves, plus the two
// modules deliberately left OUT (and why), plus a fail-safe mutation proof
// that an unregistered/unresolvable module still resolves "unknown" and
// still escalates (never silently downgraded to a working refusal).
//
// Corpus, re-measured fresh (not relayed): `gh issue list --state closed
// --search 'ArgumentValidationError in:title' --limit 500` -> 408 closed
// issues, 38 distinct "module:function" identifiers, 14 distinct modules.
// =============================================================================

describe("resolveFunctionVisibility -- every corpus-named function on a registered module resolves public", () => {
	const PUBLIC_CORPUS_FUNCTIONS = [
		"briefingNotes:create",
		"briefingNotes:get",
		"briefingNotes:update",
		"businessUnits:get",
		"diary:get",
		"diary:write",
		"fixPatterns:addAttempt",
		"fixPatterns:get",
		"fixPatterns:listByProject",
		"mandates:get",
		"memories:getMemory",
		"memories:listMemories",
		"memories:softDeleteMemory",
		"memories:storeMemory",
		"messages:getById",
		"messages:listBroadcastStatus",
		"messages:listMessages",
		"messages:markAsRead",
		"messages:sendMessage",
		"missions:get",
		"missions:update",
		"oauth:getClientByClientId",
		"oauth:listClients",
		"profiles:listProfiles",
		"profiles:updateDynamic",
		"recurringTasks:getById",
		"tasks:billingSummaryByProject",
		"tasks:complete",
		"tasks:create",
		"tasks:get",
		"tasks:getById",
		"tasks:list",
		"tasks:listByMission",
		"tasks:start",
		"tasks:update",
	];

	for (const functionName of PUBLIC_CORPUS_FUNCTIONS) {
		test(`${functionName} resolves "public"`, () => {
			expect(resolveFunctionVisibility(functionName)).toBe("public");
		});
	}
});

describe("resolveFunctionVisibility -- deliberately NOT registered, and why", () => {
	test('components:get resolves "unknown" -- convex/components.ts does not exist in this repo', () => {
		expect(resolveFunctionVisibility("components:get")).toBe("unknown");
	});

	test('search:recall resolves "unknown" -- convex/search.ts is "use node" and its Convex-bundler runtime interaction with a non-"use node" importer is unverified without a deploy (DEV-only task, no npx convex deploy)', () => {
		expect(resolveFunctionVisibility("search:recall")).toBe("unknown");
	});

	test('search:textSearch resolves "unknown" for the same reason', () => {
		expect(resolveFunctionVisibility("search:textSearch")).toBe("unknown");
	});
});

describe("resolveFunctionVisibility -- fail-safe: an identifier that names no real export on a registered module still resolves unknown, never a guess", () => {
	test('memories:recall resolves "unknown" -- convex/memories.ts has no "recall" export (the real function is search:recall)', () => {
		expect(resolveFunctionVisibility("memories:recall")).toBe("unknown");
	});

	test('profiles:get resolves "unknown" -- convex/profiles.ts has no "get" export (the real function is profiles:getProfile)', () => {
		expect(resolveFunctionVisibility("profiles:get")).toBe("unknown");
	});
});

describe("classifyRefusal -- the fail-safe direction the REGISTRY comment block promises: unknown NEVER downgrades to a working refusal", () => {
	// This is the mutation this file pins: if REGISTRY loses an entry (a
	// module renamed/removed, a future edit that forgets to register a new
	// module), the functions on it fall back to "unknown" -- and this test
	// proves "unknown" still escalates rather than going quiet. Simulating
	// "removed from REGISTRY" without editing the source: any identifier
	// this REGISTRY does not (yet) cover behaves identically, and
	// `search:recall` is exactly that case today, deliberately left out
	// above. Removing `memories` from REGISTRY in errorMonitorFunctionVisibility.ts
	// and re-running this suite reproduces the same RED->GREEN shape for
	// `memories:getMemory` that this test proves for `search:recall` now.
	test("an ArgumentValidationError on an unregistered module's function is NOT a working refusal, and still escalates", () => {
		const visibility = resolveFunctionVisibility("search:recall");
		expect(visibility).toBe("unknown");

		const decision = classifyRefusal(
			{
				functionName: "search:recall",
				errorMessage:
					'ArgumentValidationError: Value does not match validator.\nPath: .query  Value: "kzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"  Validator: v.string()',
			},
			visibility,
		);

		expect(decision.isWorkingRefusal).toBe(false);
		expect(decision.reason).toMatch(/unknown/);
	});
});
