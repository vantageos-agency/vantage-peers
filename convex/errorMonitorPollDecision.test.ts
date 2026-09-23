/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { DEFAULT_FILTER_RULES } from "./errorMonitorFilters";
import { decideGroupAction } from "./errorMonitorPollDecision";
import type { FunctionVisibility } from "./errorMonitorRefusalClassifier";

// =============================================================================
// Coordinator feedback, task k17dthw4ky2w0bhevzy3dawz9h8ezd3e: "a perfect
// predicate wired backwards is a reporter that misbehaves exactly as
// before, and every test you wrote would still be green. `.every` versus
// `.some` is precisely the mutation that inverts behaviour while looking
// correct." This file pins the WIRING (`decideGroupAction`'s aggregation
// across a group's `functionNames`), not just the predicate underneath it.
// =============================================================================

const ISSUE_1297_ERROR_MESSAGE =
	'ArgumentValidationError: Value does not match validator.\nPath: .taskId  Value: "kzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"  Validator: v.id("tasks")';

function visibilityFixture(
	map: Record<string, FunctionVisibility>,
): (functionName: string) => FunctionVisibility {
	return (functionName: string) => map[functionName] ?? "unknown";
}

describe("decideGroupAction — single-function groups", () => {
	test("a public function's ArgumentValidationError is a working refusal", () => {
		const action = decideGroupAction(
			{ functionNames: ["tasks:get"], errorMessage: ISSUE_1297_ERROR_MESSAGE },
			DEFAULT_FILTER_RULES,
			visibilityFixture({ "tasks:get": "public" }),
		);
		expect(action.kind).toBe("working-refusal");
	});

	test("an internal function's ArgumentValidationError still escalates", () => {
		const action = decideGroupAction(
			{
				functionNames: ["errorMonitorFilters:incrementRuleMatch"],
				errorMessage: ISSUE_1297_ERROR_MESSAGE,
			},
			DEFAULT_FILTER_RULES,
			visibilityFixture({
				"errorMonitorFilters:incrementRuleMatch": "internal",
			}),
		);
		expect(action.kind).toBe("escalate");
	});
});

describe("decideGroupAction — MIXED group: the .every vs .some pin", () => {
	// Two functions land in the same group (same module + validator-keyword
	// tuple per computeGroupKey -- this test bypasses that grouping and
	// constructs the mixed group directly, which is exactly the shape
	// `decideGroupAction` must handle regardless of how the group was built).
	// One is a public refusal, the other is an internal defect. The WHOLE
	// GROUP must still escalate -- the internal member is never allowed to
	// be silenced by the public member's clean bill.
	test("one public (working-refusal) + one internal (defect) in the same group -> escalate, not working-refusal", () => {
		const action = decideGroupAction(
			{
				functionNames: ["tasks:get", "errorMonitorFilters:incrementRuleMatch"],
				errorMessage: ISSUE_1297_ERROR_MESSAGE,
			},
			DEFAULT_FILTER_RULES,
			visibilityFixture({
				"tasks:get": "public",
				"errorMonitorFilters:incrementRuleMatch": "internal",
			}),
		);
		// This is the assertion an `.every` -> `.some` mutation flips: `.some`
		// would see "tasks:get" qualify and return "working-refusal" for the
		// whole group, silencing the internal-function defect riding alongside
		// it. `.every` correctly refuses to let ANY non-qualifying member
		// clear the group.
		expect(action.kind).toBe("escalate");
	});

	test("one public + one unknown-visibility in the same group -> escalate, not working-refusal", () => {
		const action = decideGroupAction(
			{
				functionNames: ["tasks:get", "notARealModule:foo"],
				errorMessage: ISSUE_1297_ERROR_MESSAGE,
			},
			DEFAULT_FILTER_RULES,
			visibilityFixture({ "tasks:get": "public" }),
		);
		expect(action.kind).toBe("escalate");
	});

	test("all-public group of two functions -> working-refusal", () => {
		const action = decideGroupAction(
			{
				functionNames: ["tasks:get", "tasks:getById"],
				errorMessage: ISSUE_1297_ERROR_MESSAGE,
			},
			DEFAULT_FILTER_RULES,
			visibilityFixture({ "tasks:get": "public", "tasks:getById": "public" }),
		);
		expect(action.kind).toBe("working-refusal");
	});
});

describe("decideGroupAction — the errorMonitorFilters rule table still takes priority", () => {
	test("an RBAC deny on tasks:complete is skipped by the existing rule, unaffected by the refusal gate", () => {
		const action = decideGroupAction(
			{
				functionNames: ["tasks:complete"],
				errorMessage:
					"Uncaught Error: Unauthorized: sigma is not creator or assignee of this task",
			},
			DEFAULT_FILTER_RULES,
			visibilityFixture({ "tasks:complete": "public" }),
		);
		expect(action.kind).toBe("skip");
	});
});
