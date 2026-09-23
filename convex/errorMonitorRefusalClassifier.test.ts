/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
	classifyRefusal,
	isArgumentValidationErrorMessage,
} from "./errorMonitorRefusalClassifier";
import { resolveFunctionVisibility } from "./errorMonitorFunctionVisibility";

// =============================================================================
// Issue #1297 (closed NOT A DEFECT, coordinator ruling) -- the reporter
// escalated a WORKING validator refusal into a recurring GitHub issue + IRP
// mission. Task k17dthw4ky2w0bhevzy3dawz9h8ezd3e.
//
// Both poles are the deliverable:
//   1. #1297's own payload (verbatim) on a PUBLIC function -> no issue.
//   2. The SAME error shape on an INTERNAL function -> still opens one.
//      This is the half a lazy fix (treat the whole ArgumentValidationError
//      class as noise) destroys -- pinned here so it can never regress.
// =============================================================================

// Verbatim from issue #1297 / this task's brief.
const ISSUE_1297_ERROR_MESSAGE =
	'ArgumentValidationError: Value does not match validator.\nPath: .taskId  Value: "kzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"  Validator: v.id("tasks")';

// Same SHAPE, same sentinel id, different (internal) target function.
const INTERNAL_ANALOGUE_ERROR_MESSAGE =
	'ArgumentValidationError: Value does not match validator.\nPath: .ruleId  Value: "kzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"  Validator: v.id("errorMonitorFilterRules")';

describe("resolveFunctionVisibility — reads THIS repo's own registered functions", () => {
	test("tasks:get is public (it is `query(...)` in convex/tasks.ts)", () => {
		expect(resolveFunctionVisibility("tasks:get")).toBe("public");
	});

	test("errorMonitorFilters:incrementRuleMatch is internal (it is `internalMutation(...)`)", () => {
		expect(resolveFunctionVisibility("errorMonitorFilters:incrementRuleMatch")).toBe(
			"internal",
		);
	});

	test("a module not in the registry resolves to unknown, never a guess", () => {
		expect(resolveFunctionVisibility("notARealModule:foo")).toBe("unknown");
	});

	test("an export that does not exist on a known module resolves to unknown", () => {
		expect(resolveFunctionVisibility("tasks:notARealExport")).toBe("unknown");
	});

	test("a functionName with no colon resolves to unknown", () => {
		expect(resolveFunctionVisibility("tasks")).toBe("unknown");
	});
});

describe("isArgumentValidationErrorMessage", () => {
	test("matches Convex's ArgumentValidationError shape", () => {
		expect(isArgumentValidationErrorMessage(ISSUE_1297_ERROR_MESSAGE)).toBe(true);
	});

	test("does not match an unrelated error shape", () => {
		expect(
			isArgumentValidationErrorMessage(
				"Uncaught Error: Unauthorized: sigma is not creator or assignee of this task",
			),
		).toBe(false);
	});
});

describe("classifyRefusal — pole 1: #1297's own payload, public function, no issue", () => {
	test("tasks:get with the max-lexicographic sentinel id is a working refusal", () => {
		const decision = classifyRefusal(
			{ functionName: "tasks:get", errorMessage: ISSUE_1297_ERROR_MESSAGE },
			resolveFunctionVisibility("tasks:get"),
		);
		expect(decision.isWorkingRefusal).toBe(true);
		expect(decision.reason).toMatch(/working refusal|not a defect/);
	});
});

describe("classifyRefusal — pole 2: same error shape, internal function, still escalates", () => {
	test("errorMonitorFilters:incrementRuleMatch with the same sentinel id is NOT a working refusal", () => {
		const decision = classifyRefusal(
			{
				functionName: "errorMonitorFilters:incrementRuleMatch",
				errorMessage: INTERNAL_ANALOGUE_ERROR_MESSAGE,
			},
			resolveFunctionVisibility("errorMonitorFilters:incrementRuleMatch"),
		);
		expect(decision.isWorkingRefusal).toBe(false);
		expect(decision.reason).toMatch(/our own code|genuine defect/);
	});
});

describe("classifyRefusal — unknown visibility fails toward escalation, never suppression", () => {
	test("an ArgumentValidationError on an unregistered module is NOT a working refusal", () => {
		const decision = classifyRefusal(
			{
				functionName: "notARealModule:foo",
				errorMessage: ISSUE_1297_ERROR_MESSAGE,
			},
			resolveFunctionVisibility("notARealModule:foo"),
		);
		expect(decision.isWorkingRefusal).toBe(false);
	});
});

describe("classifyRefusal — the predicate only applies to ArgumentValidationError", () => {
	test("a non-ArgumentValidationError on a public function is NOT reclassified as a working refusal", () => {
		const decision = classifyRefusal(
			{
				functionName: "tasks:get",
				errorMessage: "Uncaught Error: something else entirely broke",
			},
			resolveFunctionVisibility("tasks:get"),
		);
		expect(decision.isWorkingRefusal).toBe(false);
	});
});
