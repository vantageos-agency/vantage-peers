// ─────────────────────────────────────────────────────────────────────────────
// D90 KILL-SWITCH HARDENING — RED tests
// ─────────────────────────────────────────────────────────────────────────────
// Context : issue #632 (Day 91) generated a 14-task IRP cascade despite
// AUTO_IRP_PAUSED=true on prod, because the kill-switch was guarded only at
// `pollAllDeployments` (cron entry), leaving `createGitHubIssue` action and the
// `http.ts` webhook IRP-cascade path ungated. Additionally, the originating
// error was a TRANSIENT Convex Server Error that succeeded on immediate retry —
// it should never have escalated to GH issue + IRP regardless of the kill-switch.
//
// This suite specifies :
//   T1 — baseline preserved: a persistent error reaches `shouldCreateIssue=true`
//        when kill-switch off + no transient match
//   T2 — TRANSIENT classification: transient retry-class messages are filtered
//        out by the new `DEFAULT_FILTER_RULES` transient entry
//   T3 — AUTO_IRP_PAUSED=true → isKillSwitchActive() returns true (env gate)
//   T4 — AUTO_IRP_PAUSED unset → isKillSwitchActive() returns false (default
//        active so existing behavior is preserved; default-paused would be a
//        breaking change in non-prod environments)
//   T5 — assertKillSwitchHealth() logs a warning when AUTO_IRP_PAUSED unset
//        (belt-and-suspenders startup health check)
//   T6 — Issue #632 specific scenario: ConvexError with TASK_START_BLOCKED code
//        text classified as transient → skipped
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	DEFAULT_FILTER_RULES,
	evaluateFilter,
	isTransientErrorMessage,
} from "./errorMonitorFilters";
import {
	KILL_SWITCH_VARS,
	assertKillSwitchHealth,
	isKillSwitchActive,
} from "./errorMonitorKillSwitch";

describe("D90 kill-switch hardening", () => {
	const originalEnv = process.env.AUTO_IRP_PAUSED;
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.AUTO_IRP_PAUSED;
		else process.env.AUTO_IRP_PAUSED = originalEnv;
		vi.restoreAllMocks();
	});

	test("T1 — baseline: persistent non-transient error still creates issue when kill-switch off", () => {
		delete process.env.AUTO_IRP_PAUSED;
		const decision = evaluateFilter({
			functionName: "missions:create",
			errorMessage: "TypeError: cannot read property 'foo' of undefined",
		});
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.severity).toBe("create-issue");
	});

	test("T2 — TRANSIENT retry-class messages are filtered by DEFAULT_FILTER_RULES", () => {
		// Server Error w/ Request ID is the canonical Convex transient retry shape
		const decision = evaluateFilter({
			functionName: "tasks:start",
			errorMessage:
				"Server Error\nRequest ID: 1234567890abcdef\nUncaught Error: transient timeout, please retry",
		});
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
		expect(decision.matchedRule?.reason).toMatch(/transient/i);
	});

	test("T2b — isTransientErrorMessage classifies Server Error + Request ID as transient", () => {
		expect(
			isTransientErrorMessage(
				"Server Error\nRequest ID: abc123\nsomething transient",
			),
		).toBe(true);
		// Persistent app-logic errors are NOT transient
		expect(
			isTransientErrorMessage(
				"ArgumentValidationError: Path .foo Value: undefined",
			),
		).toBe(false);
	});

	test("T3 — AUTO_IRP_PAUSED=true → kill-switch ACTIVE", () => {
		process.env.AUTO_IRP_PAUSED = "true";
		expect(isKillSwitchActive()).toBe(true);
	});

	test("T4 — AUTO_IRP_PAUSED unset → kill-switch INACTIVE (default-active behavior preserved)", () => {
		delete process.env.AUTO_IRP_PAUSED;
		expect(isKillSwitchActive()).toBe(false);
	});

	test("T4b — AUTO_IRP_PAUSED=false → kill-switch INACTIVE", () => {
		process.env.AUTO_IRP_PAUSED = "false";
		expect(isKillSwitchActive()).toBe(false);
	});

	test("T5 — assertKillSwitchHealth logs WARN when AUTO_IRP_PAUSED unset", () => {
		delete process.env.AUTO_IRP_PAUSED;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		assertKillSwitchHealth();
		expect(warn).toHaveBeenCalled();
		const msg = warn.mock.calls[0]?.[0] as string;
		expect(msg).toMatch(/AUTO_IRP_PAUSED/);
		expect(msg).toMatch(/health/i);
	});

	test("T5b — assertKillSwitchHealth does NOT warn when AUTO_IRP_PAUSED=true", () => {
		process.env.AUTO_IRP_PAUSED = "true";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		assertKillSwitchHealth();
		expect(warn).not.toHaveBeenCalled();
	});

	test("T6 — Issue #632 scenario: TASK_START_BLOCKED transient retry success → SKIPPED", () => {
		// The actual log shape from issue #632: Server Error wrapping a
		// ConvexError code TASK_START_BLOCKED that succeeded on immediate retry.
		const decision = evaluateFilter({
			functionName: "tasks:start",
			errorMessage:
				'Server Error\nRequest ID: deadbeefcafe\nConvexError: {"code":"TASK_START_BLOCKED","message":"task already in-progress"}',
		});
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
	});

	test("KILL_SWITCH_VARS includes AUTO_IRP_PAUSED", () => {
		expect(KILL_SWITCH_VARS).toContain("AUTO_IRP_PAUSED");
	});
});
