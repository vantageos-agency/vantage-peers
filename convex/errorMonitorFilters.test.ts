/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
	DEFAULT_FILTER_RULES,
	evaluateFilter,
	type FilterRule,
	shouldCreateIssue,
} from "./errorMonitorFilters";

// =============================================================================
// Auto-IRP false-positive filter — sigma-D50-cleanup
// Linked: memory j573cwcs3znp0xsvtg34x435jh84b0eg, pattern m978zeg4b2e9nx67z2hg5rwgfs85hf7f,
//         parent task k1794bfcmbv13790cht8aaagp585g9pa, mission k5700zmc41dsa0sav8sft4dpcd85g2a7.
// =============================================================================

describe("evaluateFilter — should be FILTERED (no issue)", () => {
	test("RBAC unauthorized for sigma on tasks:complete is skipped", () => {
		const decision = evaluateFilter({
			functionName: "tasks:complete",
			errorMessage:
				"Uncaught Error: Unauthorized: sigma is not creator or assignee of this task",
		});
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
		expect(decision.matchedRule?.reason).toMatch(/RBAC/);
	});

	test("RBAC unauthorized for omega on tasks:complete is skipped", () => {
		const decision = evaluateFilter({
			functionName: "tasks:complete",
			errorMessage:
				"Unauthorized: omega is not creator or assignee of this task (id k123)",
		});
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
		expect(
			shouldCreateIssue({
				functionName: "tasks:complete",
				errorMessage: "Unauthorized: omega is not creator or assignee",
			}),
		).toBe(false);
	});

	test("missions:update with empty missionId Value is skipped", () => {
		const decision = evaluateFilter({
			functionName: "missions:update",
			errorMessage:
				'ArgumentValidationError: Validator error: Path: .missionId Value: "" Validator: v.id("missions")',
		});
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
		expect(decision.matchedRule?.reason).toMatch(/self-cascade/);
	});

	test("missions:update with truncated missionId Value is skipped", () => {
		// Real shape from error logs: `Value: "k57..."`
		const decision = evaluateFilter({
			functionName: "missions:update",
			errorMessage:
				'ArgumentValidationError: Path: .missionId Value: "k5700zm..." Validator: v.id("missions")',
		});
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
	});
});

describe("evaluateFilter — should NOT be filtered (issue created)", () => {
	test("briefingNotes:create size-too-large error passes through", () => {
		const decision = evaluateFilter({
			functionName: "briefingNotes:create",
			errorMessage:
				"Error: content exceeds maximum size of 1MB (got 2,344,210 bytes)",
		});
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.severity).toBe("create-issue");
		expect(decision.matchedRule).toBeNull();
	});

	test("tasks:create foreign-key validation error passes through", () => {
		const decision = evaluateFilter({
			functionName: "tasks:create",
			errorMessage:
				'ArgumentValidationError: Path: .missionId Value: "j99nonexistentid12345" Validator: v.id("missions") (referent does not exist)',
		});
		// tasks:create is NOT in the rule set, so even though the message looks
		// vaguely similar to the missions:update truncated-id rule, the
		// functionName mismatch must let it through.
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.severity).toBe("create-issue");
		expect(decision.matchedRule).toBeNull();
		expect(
			shouldCreateIssue({
				functionName: "tasks:create",
				errorMessage:
					'ArgumentValidationError: Path: .missionId Value: "j99..."',
			}),
		).toBe(true);
	});
});

describe("DEFAULT_FILTER_RULES sanity", () => {
	test("ships exactly the two acceptance-criteria rules", () => {
		expect(DEFAULT_FILTER_RULES).toHaveLength(2);
		const fns = DEFAULT_FILTER_RULES.map((r) => r.functionName).sort();
		expect(fns).toEqual(["missions:update", "tasks:complete"]);
		for (const r of DEFAULT_FILTER_RULES) {
			expect(r.severity).toBe("skip");
			expect(r.errorMessageRegex).toBeInstanceOf(RegExp);
			expect(r.reason.length).toBeGreaterThan(0);
		}
	});

	test("does not match well-formed missionId values (no false-skip)", () => {
		// A full, valid Convex id should NOT trigger the truncated-id filter.
		const decision = evaluateFilter({
			functionName: "missions:update",
			errorMessage:
				'ArgumentValidationError: Path: .missionId Value: "k5700zmc41dsa0sav8sft4dpcd85g2a7" Validator: v.id("missions")',
		});
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.matchedRule).toBeNull();
	});
});

// =============================================================================
// v1.0.1 — boundary tests for the truncated-id regex `[^"]{0,15}\.\.\.`
// Locks the upper bound at exactly 15 chars before the ellipsis, so a 16+ char
// "real" id won't get silently dropped if it happens to land in a Value: "…"
// shape later.
// =============================================================================
describe("evaluateFilter — truncated-id boundary cases", () => {
	test("EXACTLY 15 chars before '...' MUST match (upper inclusive boundary)", () => {
		// 15 a's then "..."
		const id = "a".repeat(15);
		const decision = evaluateFilter({
			functionName: "missions:update",
			errorMessage: `ArgumentValidationError: Path: .missionId Value: "${id}..." Validator: v.id("missions")`,
		});
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
		expect(decision.matchedRule?.reason).toMatch(/self-cascade/);
	});

	test("EXACTLY 16 chars before '...' MUST NOT match (just past boundary)", () => {
		// 16 a's then "..." — the regex bound is {0,15} so this falls through.
		// The OR-branch for empty string also doesn't match (Value is non-empty
		// AND ends with `...`).
		const id = "a".repeat(16);
		const decision = evaluateFilter({
			functionName: "missions:update",
			errorMessage: `ArgumentValidationError: Path: .missionId Value: "${id}..." Validator: v.id("missions")`,
		});
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.matchedRule).toBeNull();
		expect(decision.severity).toBe("create-issue");
	});

	test("EXACTLY 0 chars before '...' MUST match (lower inclusive boundary)", () => {
		// `Value: "..."` — degenerate truncation, all that's left is the ellipsis.
		const decision = evaluateFilter({
			functionName: "missions:update",
			errorMessage:
				'ArgumentValidationError: Path: .missionId Value: "..." Validator: v.id("missions")',
		});
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
	});

	test("empty Value string sanity — alternation branch still matches", () => {
		// Already covered earlier in the file but pinned again here so the
		// boundary block self-documents.
		const decision = evaluateFilter({
			functionName: "missions:update",
			errorMessage:
				'ArgumentValidationError: Path: .missionId Value: "" Validator: v.id("missions")',
		});
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
	});
});

// =============================================================================
// v1.0.1 — rule precedence: higher `priority` wins, stable by creationTime
// =============================================================================
describe("evaluateFilter — priority precedence", () => {
	test("higher-priority rule wins over lower-priority rule on the same input", () => {
		// Two rules, same functionName + both regexes match. The high-priority
		// rule has severity "create-issue" and should beat the low-priority
		// "skip" rule. Without priority sorting the "skip" would have shadowed.
		const rules: FilterRule[] = [
			{
				functionName: "missions:update",
				errorMessageRegex: /missionId/,
				reason: "low-pri skip — generic",
				severity: "skip",
				priority: 1,
				creationTime: 1_000,
			},
			{
				functionName: "missions:update",
				errorMessageRegex: /missionId/,
				reason: "high-pri override — create issue anyway",
				severity: "create-issue",
				priority: 100,
				creationTime: 2_000,
			},
		];
		const decision = evaluateFilter(
			{
				functionName: "missions:update",
				errorMessage:
					'ArgumentValidationError: Path: .missionId Value: "x" Validator: v.id("missions")',
			},
			rules,
		);
		expect(decision.severity).toBe("create-issue");
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.matchedRule?.reason).toMatch(/high-pri/);
	});

	test("priority tiebreak — older creationTime wins when priority is equal", () => {
		const rules: FilterRule[] = [
			{
				functionName: "missions:update",
				errorMessageRegex: /missionId/,
				reason: "newer rule",
				severity: "log-only",
				priority: 5,
				creationTime: 5_000,
			},
			{
				functionName: "missions:update",
				errorMessageRegex: /missionId/,
				reason: "older rule",
				severity: "skip",
				priority: 5,
				creationTime: 1_000,
			},
		];
		const decision = evaluateFilter(
			{
				functionName: "missions:update",
				errorMessage: "Path: .missionId Value: x",
			},
			rules,
		);
		// older creationTime first → "skip" rule wins
		expect(decision.severity).toBe("skip");
		expect(decision.matchedRule?.reason).toBe("older rule");
	});

	test("undefined priority is treated as 0 (lowest)", () => {
		const rules: FilterRule[] = [
			{
				functionName: "missions:update",
				errorMessageRegex: /missionId/,
				reason: "no-pri rule",
				severity: "skip",
			},
			{
				functionName: "missions:update",
				errorMessageRegex: /missionId/,
				reason: "explicit pri 1",
				severity: "create-issue",
				priority: 1,
			},
		];
		const decision = evaluateFilter(
			{
				functionName: "missions:update",
				errorMessage: "Path: .missionId Value: x",
			},
			rules,
		);
		// priority 1 beats undefined-treated-as-0 → "create-issue" wins
		expect(decision.severity).toBe("create-issue");
		expect(decision.matchedRule?.reason).toBe("explicit pri 1");
	});
});
