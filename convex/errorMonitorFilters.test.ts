/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
	DEFAULT_FILTER_RULES,
	evaluateFilter,
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
