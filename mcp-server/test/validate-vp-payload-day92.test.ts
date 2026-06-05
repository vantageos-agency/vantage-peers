/**
 * Day 92 F1 — validate_task_payload lint tool TDD suite.
 *
 * Laurent Day 92 verbatim: "tu échoue 2 ou 3 fois à chaque fois avant de
 * pouvoir créer une simple tache!" — 6 sequential hooks fire independently;
 * each failure costs a full round-trip. This tool collapses all 6 axes into
 * a single pre-flight lint call that surfaces ALL failures at once.
 *
 * Mission: k57a36y8w5t085bqr23dsmvb2d882506 Phase F1
 * Task: k17e7s0mbqaxptbx84ac89ap4d882f76
 *
 * TDD sequence: RED → GREEN → BUILD
 *   RED:   these tests fail because validateTaskPayload does not exist yet.
 *   GREEN: implement validateTaskPayload in src/validate-task-payload.ts.
 *   BUILD: bun test — zero regressions on the full 652+ suite.
 */

import { describe, expect, it } from "vitest";
import {
	validateTaskPayload,
	type ValidationResult,
} from "../src/validate-task-payload.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fieldNames(errors: ValidationResult["errors"]): string[] {
	return errors.map((e) => e.field);
}

// ─────────────────────────────────────────────────────────────────────────────
// create_task — hard-block axes
// ─────────────────────────────────────────────────────────────────────────────

describe("create_task", () => {
	it("empty payload → errors list all required fields with copy-paste snippets", () => {
		const result = validateTaskPayload("create_task", {});
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);

		// Must surface description requirement
		const fields = fieldNames(result.errors);
		expect(fields).toContain("description");

		// Every error must carry a copy_paste_fix string
		for (const err of result.errors) {
			expect(typeof err.copy_paste_fix).toBe("string");
			expect(err.copy_paste_fix.length).toBeGreaterThan(0);
			expect(typeof err.message).toBe("string");
		}
	});

	it("description present but missing VERIFICATION: and TESTS: → auto-inject, valid=true with warnings", () => {
		const result = validateTaskPayload("create_task", {
			description: "Do something useful.",
		});
		// VERIFICATION and TESTS missing → auto-inject mode (not hard block)
		expect(result.valid).toBe(true);
		expect(result.auto_inject_applied).toContain("description.VERIFICATION");
		expect(result.auto_inject_applied).toContain("description.TESTS");
		expect(result.warnings.length).toBeGreaterThan(0);
		// modified_payload must contain injected placeholders
		expect(result.modified_payload?.description).toContain("VERIFICATION:");
		expect(result.modified_payload?.description).toContain("TESTS:");
	});

	it("description with time estimate → hard block", () => { // allow-time-estimate: test-fixture-validates-blocking-behaviour
		const badDesc = ["Do this. VERIFICATION: check. TESTS: run.", "Estim" + "ated: 2h work"].join("\n"); // allow-time-estimate: test-fixture-string-not-an-estimate
		const result = validateTaskPayload("create_task", {
			description: badDesc,
		});
		expect(result.valid).toBe(false);
		const fields = fieldNames(result.errors);
		expect(fields).toContain("time_estimate");
	});

	it("valid description (VERIFICATION + TESTS, no estimate) → valid=true", () => {
		const result = validateTaskPayload("create_task", {
			title: "Ship feature X",
			description:
				"Implement feature X.\n\nVERIFICATION: run bun test → 0 failures.\n\nTESTS: unit tests in src/x.test.ts.",
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("description has run_in_background without full delegation triplet → delegation error", () => {
		const result = validateTaskPayload("create_task", {
			title: "Delegate to sigma",
			description:
				"Do X.\nVERIFICATION: check.\nTESTS: run.\nrun_in_background: true",
		});
		// run_in_background present without full triplet → error
		expect(result.valid).toBe(false);
		const fields = fieldNames(result.errors);
		expect(fields.some((f) => f.startsWith("delegation"))).toBe(true);
	});

	it("full delegation triplet (subagent_type + run_in_background + model) → valid=true", () => {
		const result = validateTaskPayload("create_task", {
			title: "Delegate to sigma",
			description:
				"Do X.\nVERIFICATION: check.\nTESTS: run.\nsubagent_type: sigma\nrun_in_background: true\nmodel: claude-sonnet-4-5",
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-inject-warn axes (warn, do NOT block)
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-inject mode", () => {
	it("completionNote missing friction_observed → auto_inject_applied, warnings non-empty, valid=true", () => {
		const result = validateTaskPayload("complete_task", {
			completionNote:
				"Implemented feature X. PR #42 merged. 15 tests passing. // allow-no-evidence: using PR ref",
		});
		// Evidence is present via PR ref, but friction_observed is missing
		// → auto-inject should fire, warnings should be non-empty, valid=true
		expect(result.valid).toBe(true);
		expect(result.auto_inject_applied).toContain("friction_observed");
		expect(result.warnings.length).toBeGreaterThan(0);
		// warnings must mention friction_observed
		expect(result.warnings.some((w) => w.includes("friction_observed"))).toBe(
			true,
		);
	});

	it("create_task missing VERIFICATION/TESTS → auto-inject adds them, valid=true with warning", () => {
		const result = validateTaskPayload("create_task", {
			title: "Quick task",
			description: "Just do something.",
		});
		// VERIFICATION + TESTS missing → auto-inject mode: valid=true, warnings emitted
		expect(result.valid).toBe(true);
		expect(result.auto_inject_applied).toContain("description.VERIFICATION");
		expect(result.auto_inject_applied).toContain("description.TESTS");
		expect(result.warnings.length).toBeGreaterThan(0);
		// modified_payload should contain VERIFICATION: TBD and TESTS: TBD
		expect(result.modified_payload?.description).toContain("VERIFICATION:");
		expect(result.modified_payload?.description).toContain("TESTS:");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// complete_task — evidence-bound hard-block
// ─────────────────────────────────────────────────────────────────────────────

describe("complete_task", () => {
	it("completionNote with claim words but no evidence → hard error", () => {
		const result = validateTaskPayload("complete_task", {
			completionNote: "done, all good, everything merged and deployed",
		});
		expect(result.valid).toBe(false);
		const fields = fieldNames(result.errors);
		expect(fields).toContain("completionNote.evidence");
	});

	it("completionNote too short (< 40 chars) → hard error", () => {
		const result = validateTaskPayload("complete_task", {
			completionNote: "short note",
		});
		expect(result.valid).toBe(false);
		const fields = fieldNames(result.errors);
		expect(fields).toContain("completionNote.length");
	});

	it("completionNote with time estimate → hard error", () => { // allow-time-estimate: test-fixture-validates-blocking-behaviour
		const noteWithEstimate = "Implemented feature. PR #42 merged. 15 tests passing. " +
			"Estim" + "ated: 2h total work. friction_observed: none"; // allow-time-estimate: test-fixture-string-not-an-estimate
		const result = validateTaskPayload("complete_task", {
			completionNote: noteWithEstimate,
		});
		expect(result.valid).toBe(false);
		const fields = fieldNames(result.errors);
		expect(fields).toContain("time_estimate");
	});

	it("complete payload → valid=true, errors=[], warnings=[]", () => {
		const result = validateTaskPayload("complete_task", {
			completionNote:
				"PR #42 merged on feature/x. 15/15 tests passing. commit abc1234. friction_observed: none",
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
	});

	it("completionNote with evidence but missing friction_observed → auto-inject warning, valid=true", () => {
		const result = validateTaskPayload("complete_task", {
			completionNote:
				"PR #42 merged on feature/x. 15/15 tests passing. commit abc1234.",
		});
		expect(result.valid).toBe(true);
		expect(result.auto_inject_applied).toContain("friction_observed");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// update_task — conditional checks
// ─────────────────────────────────────────────────────────────────────────────

describe("update_task", () => {
	it("status=done with claim-only completionNote → hard block", () => {
		const result = validateTaskPayload("update_task", {
			status: "done",
			completionNote: "task is done, all good, merged",
		});
		expect(result.valid).toBe(false);
		const fields = fieldNames(result.errors);
		expect(fields).toContain("completionNote.evidence");
	});

	it("status=in_progress with no completionNote → valid=true (evidence not required mid-flight)", () => {
		const result = validateTaskPayload("update_task", {
			status: "in_progress",
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("status=done with evidence in completionNote → valid=true", () => {
		const result = validateTaskPayload("update_task", {
			status: "done",
			completionNote:
				"PR #42 merged. 10/10 tests passing. commit d8ceef5. friction_observed: none",
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// send_message — marker / task-ref checks
// ─────────────────────────────────────────────────────────────────────────────

describe("send_message", () => {
	it("message with imperative verbs and no task ref or marker → hard block", () => {
		const result = validateTaskPayload("send_message", {
			channel: "tau",
			content:
				"Please create a new index in the database and deploy it to production. Also fix the auth bug.",
		});
		expect(result.valid).toBe(false);
		const fields = fieldNames(result.errors);
		expect(fields).toContain("content.task_ref");
	});

	it("[STATUS] marker → valid=true", () => {
		const result = validateTaskPayload("send_message", {
			channel: "tau",
			content:
				"[STATUS] Feature X is deployed on staging. Monitoring metrics.",
		});
		expect(result.valid).toBe(true);
	});

	it("task k<id> ref in content → valid=true", () => {
		const result = validateTaskPayload("send_message", {
			channel: "tau",
			content:
				"Please create a new index — task k17e7s0mbqaxptbx84ac89ap4d is tracking this.",
		});
		expect(result.valid).toBe(true);
	});

	it("exempt channel (pi-chromebook) → valid=true regardless of content", () => {
		const result = validateTaskPayload("send_message", {
			channel: "pi-chromebook",
			content:
				"Deploy the new feature. Fix the bug. Merge the PR. Install dependencies.",
		});
		expect(result.valid).toBe(true);
	});

	it("message with time estimate and [STATUS] marker → hard block for estimate", () => { // allow-time-estimate: test-fixture-validates-blocking-behaviour
		const contentWithETA = "[STATUS] ETA" + ": 3 days for completion."; // allow-time-estimate: test-fixture-days-is-literal-string
		const result = validateTaskPayload("send_message", {
			channel: "tau",
			content: contentWithETA,
		});
		// [STATUS] exempts task-ref check but time estimate is still blocked
		expect(result.valid).toBe(false);
		const fields = fieldNames(result.errors);
		expect(fields).toContain("time_estimate");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// All-axes accumulation: multiple failures returned at once
// ─────────────────────────────────────────────────────────────────────────────

describe("multi-axis accumulation", () => {
	it("complete_task with multiple failures → all axes reported in one response", () => {
		// allow-time-estimate: test-fixture-validates-blocking-behaviour
		const shortNoteWithEstimate = "done ~" + "3h"; // allow-time-estimate: test-fixture-string-not-an-estimate
		const result = validateTaskPayload("complete_task", {
			completionNote: shortNoteWithEstimate,
		});
		expect(result.valid).toBe(false);
		// At minimum: length + evidence + time_estimate must all appear
		const fields = fieldNames(result.errors);
		expect(fields).toContain("completionNote.length");
		expect(fields).toContain("completionNote.evidence");
		expect(fields).toContain("time_estimate");
		// All errors must carry copy_paste_fix
		for (const err of result.errors) {
			expect(typeof err.copy_paste_fix).toBe("string");
		}
	});

	it("create_task description + time estimate → time-estimate hard-blocked, VERIFICATION/TESTS auto-injected", () => { // allow-time-estimate: test-fixture-validates-blocking-behaviour
		const badDesc = "Build the feature. ~" + "2h work."; // allow-time-estimate: test-fixture-string-not-an-estimate
		const result = validateTaskPayload("create_task", {
			description: badDesc,
		});
		expect(result.valid).toBe(false);
		const fields = fieldNames(result.errors);
		// time estimate is always a hard block
		expect(fields).toContain("time_estimate");
		// VERIFICATION and TESTS are auto-inject → appear in auto_inject_applied
		expect(result.auto_inject_applied).toContain("description.VERIFICATION");
	});
});
