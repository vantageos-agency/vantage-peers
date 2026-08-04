/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import {
	DEFAULT_FILTER_RULES,
	evaluateFilter,
	isPendingAliasError,
	type FilterRule,
	shouldCreateIssue,
	synthesizePendingAliasRules,
} from "./errorMonitorFilters";
import schema from "./schema";

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

// ─── Day 98 k17fzba8 Cat D — ConvexError typed business-error filter ───
describe("D98 Cat D — Uncaught ConvexError: → log-only (no GH issue)", () => {
	test("CLIENT_REVOKED typed ConvexError is log-only", () => {
		const decision = evaluateFilter({
			functionName: "oauthDcr:exchangeAuthCode",
			errorMessage:
				'Uncaught ConvexError: {"code":"CLIENT_REVOKED","message":"Client has been revoked"}',
		});
		expect(decision.severity).toBe("log-only");
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.matchedRule?.reason).toContain("Typed ConvexError");
	});

	test("TASK_START_BLOCKED typed ConvexError is log-only", () => {
		const decision = evaluateFilter({
			functionName: "tasks:start",
			errorMessage:
				'Uncaught ConvexError: {"code":"TASK_START_BLOCKED","message":"Cannot start: dependency not done"}',
		});
		expect(decision.severity).toBe("log-only");
		expect(decision.shouldCreateIssue).toBe(false);
	});

	test("TASK_DELETE_UNAUTHORIZED typed ConvexError is log-only", () => {
		const decision = evaluateFilter({
			functionName: "tasks:deleteTask",
			errorMessage:
				'Uncaught ConvexError: {"code":"TASK_DELETE_UNAUTHORIZED","message":"Not creator"}',
		});
		expect(decision.severity).toBe("log-only");
		expect(decision.shouldCreateIssue).toBe(false);
	});

	test("Uncaught Error (non-ConvexError) still creates an issue — real crash", () => {
		const decision = evaluateFilter({
			functionName: "tasks:create",
			errorMessage:
				"Uncaught Error: Cannot read properties of undefined (reading 'foo')",
		});
		expect(decision.severity).toBe("create-issue");
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.matchedRule).toBeNull();
	});

	test("Server Error envelope (D90) still wins over ConvexError rule via priority 100 > 90", () => {
		// Both rules could match a "Server Error" wrapping a ConvexError, but
		// the D90 transient classifier has priority 100, the D98 ConvexError
		// classifier priority 90. D90 must win.
		const decision = evaluateFilter({
			functionName: "tasks:start",
			errorMessage:
				'Server Error\nRequest ID: deadbeef\nUncaught ConvexError: {"code":"TASK_START_BLOCKED"}',
		});
		expect(decision.severity).toBe("skip");
		expect(decision.matchedRule?.reason).toContain("Transient");
	});

	test("Uncaught ConvexError on any function (wildcard *) matches", () => {
		const decision = evaluateFilter({
			functionName: "any:random:function:name",
			errorMessage:
				'Uncaught ConvexError: {"code":"WHATEVER","message":"test"}',
		});
		expect(decision.severity).toBe("log-only");
	});
});

describe("DEFAULT_FILTER_RULES sanity", () => {
	test("ships the acceptance-criteria rules + D90 transient + D98 ConvexError classifier + #1132 stale-fn classifier", () => {
		// D90 added the transient retry-class wildcard rule (#632).
		// D98 k17fzba8 Cat D added a fourth wildcard rule for "Uncaught
		// ConvexError:" typed business errors.
		// #1132 added a fifth wildcard rule for stale pre-rename function
		// identifiers ("Could not find public function for 'X'"). Total: 5.
		expect(DEFAULT_FILTER_RULES).toHaveLength(5);
		const fns = DEFAULT_FILTER_RULES.map((r) => r.functionName).sort();
		expect(fns).toEqual([
			"*",
			"*",
			"*",
			"missions:update",
			"tasks:complete",
		]);
		for (const r of DEFAULT_FILTER_RULES) {
			// D98 Cat D introduces "log-only" severity in addition to "skip".
			expect(["skip", "log-only"]).toContain(r.severity);
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

// =============================================================================
// Issue #1132 — stale/pre-rename function identifier classifier
// Caller-side defect already fixed on live code; this rule only demotes the
// residual "Could not find public function for 'X'" noise from
// old-deployed/external clients still calling the 9 pre-rename names.
// =============================================================================
describe("evaluateFilter — #1132 stale pre-rename function identifiers", () => {
	const DEPRECATED_NAMES = [
		"tasks:listTasks",
		"memories:getById",
		"memories:list",
		"memories:get",
		"memories:recall",
		"diary:getById",
		"licenses:get",
		"issues:get",
		"missionTemplates:getMissionTemplateByName",
	];

	test.each(DEPRECATED_NAMES)(
		"'%s' → log-only (no GH issue)",
		(deprecatedName) => {
			const decision = evaluateFilter({
				functionName: "someCaller:whatever",
				errorMessage: `Could not find public function for '${deprecatedName}'`,
			});
			expect(decision.severity).toBe("log-only");
			expect(decision.shouldCreateIssue).toBe(false);
			expect(decision.matchedRule?.reason).toContain("#1132");
		},
	);

	test("NEGATIVE CONTROL — a genuinely unknown function name still creates an issue", () => {
		// Proves the rule does NOT broadly suppress all "Could not find public
		// function" errors — only the 9 known-deprecated identifiers.
		const decision = evaluateFilter({
			functionName: "someCaller:whatever",
			errorMessage: "Could not find public function for 'widgets:frobnicate'",
		});
		expect(decision.severity).toBe("create-issue");
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.matchedRule).toBeNull();
	});

	test("NEGATIVE CONTROL — a substring/prefix of a deprecated name is NOT matched", () => {
		// "memories:get" is a prefix of "memories:getById" and "memories:getFoo"
		// is a plausible near-miss. The quote-delimited regex must not match
		// either as a stand-in for the exact deprecated names.
		const decision = evaluateFilter({
			functionName: "someCaller:whatever",
			errorMessage: "Could not find public function for 'memories:getFoo'",
		});
		expect(decision.severity).toBe("create-issue");
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.matchedRule).toBeNull();
	});

	test("a non-'Could not find' error mentioning a deprecated name is unaffected", () => {
		const decision = evaluateFilter({
			functionName: "someCaller:whatever",
			errorMessage:
				"Uncaught Error: unrelated crash near memories:get usage in helper",
		});
		expect(decision.severity).toBe("create-issue");
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.matchedRule).toBeNull();
	});

	test("matches regardless of the erroring caller's own functionName (wildcard)", () => {
		const decision = evaluateFilter({
			functionName: "totally:different:caller",
			errorMessage: "Could not find public function for 'issues:get'",
		});
		expect(decision.severity).toBe("log-only");
		expect(decision.shouldCreateIssue).toBe(false);
	});
});

// =============================================================================
// synthesizePendingAliasRules — pure unit tests
// =============================================================================
describe("synthesizePendingAliasRules", () => {
	test("produces 4 rules for a single alias (one per covered function name)", () => {
		const rules = synthesizePendingAliasRules(["open"]);
		expect(rules).toHaveLength(4);
		const fns = rules.map((r) => r.functionName).sort();
		expect(fns).toEqual([
			"briefingNotes:list",
			"missions:list",
			"tasks:list",
			"tasks:listByMission",
		]);
	});

	test("every synthesized rule has severity 'skip' and correct reason", () => {
		const rules = synthesizePendingAliasRules(["open"]);
		for (const rule of rules) {
			expect(rule.severity).toBe("skip");
			expect(rule.reason).toBe("Pending alias release: open not yet deployed");
		}
	});

	test("regex matches ArgumentValidationError with .status path and alias value", () => {
		const rules = synthesizePendingAliasRules(["open"]);
		const tasksListRule = rules.find((r) => r.functionName === "tasks:list");
		expect(tasksListRule).toBeDefined();
		expect(
			tasksListRule?.errorMessageRegex.test(
				'ArgumentValidationError: Path: .status Value: "open" Validator: v.union(...)',
			),
		).toBe(true);
	});

	test("regex does NOT match a different alias value", () => {
		const rules = synthesizePendingAliasRules(["open"]);
		const tasksListRule = rules.find((r) => r.functionName === "tasks:list");
		expect(tasksListRule).toBeDefined();
		expect(
			tasksListRule?.errorMessageRegex.test(
				'ArgumentValidationError: Path: .status Value: "active" Validator: v.union(...)',
			),
		).toBe(false);
	});

	test("produces 8 rules for two aliases", () => {
		const rules = synthesizePendingAliasRules(["open", "active"]);
		expect(rules).toHaveLength(8);
	});

	test("produces empty array for empty alias list", () => {
		expect(synthesizePendingAliasRules([])).toHaveLength(0);
	});
});

// =============================================================================
// evaluateFilter with synthesized pending-alias rules
// =============================================================================
describe("evaluateFilter — synthesized pending-alias rules", () => {
	test("ArgumentValidationError on tasks:list with status 'open' is skipped when alias is pending", () => {
		const rules = synthesizePendingAliasRules(["open"]);
		const decision = evaluateFilter(
			{
				functionName: "tasks:list",
				errorMessage:
					'ArgumentValidationError: Path: .status Value: "open" Validator: v.union(...)',
			},
			rules,
		);
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
		expect(decision.matchedRule?.reason).toBe(
			"Pending alias release: open not yet deployed",
		);
	});

	test("same error passes through (issue created) when alias list is empty (post-deploy state)", () => {
		const rules = synthesizePendingAliasRules([]);
		const decision = evaluateFilter(
			{
				functionName: "tasks:list",
				errorMessage:
					'ArgumentValidationError: Path: .status Value: "open" Validator: v.union(...)',
			},
			rules,
		);
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.severity).toBe("create-issue");
		expect(decision.matchedRule).toBeNull();
	});

	test("tasks:create does NOT match even when alias is pending (function name mismatch)", () => {
		const rules = synthesizePendingAliasRules(["open"]);
		const decision = evaluateFilter(
			{
				functionName: "tasks:create",
				errorMessage:
					'ArgumentValidationError: Path: .status Value: "open" Validator: v.union(...)',
			},
			rules,
		);
		expect(decision.shouldCreateIssue).toBe(true);
		expect(decision.severity).toBe("create-issue");
		expect(decision.matchedRule).toBeNull();
	});

	test("missions:list is covered by synthesized rules", () => {
		const rules = synthesizePendingAliasRules(["active"]);
		const decision = evaluateFilter(
			{
				functionName: "missions:list",
				errorMessage:
					'ArgumentValidationError: Path: .status Value: "active" Validator: v.union(...)',
			},
			rules,
		);
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
	});

	test("tasks:listByMission is covered by synthesized rules", () => {
		const rules = synthesizePendingAliasRules(["all"]);
		const decision = evaluateFilter(
			{
				functionName: "tasks:listByMission",
				errorMessage:
					'ArgumentValidationError: Path: .status Value: "all" Validator: v.union(...)',
			},
			rules,
		);
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
	});

	test("briefingNotes:list is covered by synthesized rules", () => {
		const rules = synthesizePendingAliasRules(["open"]);
		const decision = evaluateFilter(
			{
				functionName: "briefingNotes:list",
				errorMessage:
					'ArgumentValidationError: Path: .status Value: "open" Validator: v.union(...)',
			},
			rules,
		);
		expect(decision.shouldCreateIssue).toBe(false);
		expect(decision.severity).toBe("skip");
	});
});

// =============================================================================
// isPendingAliasError convenience wrapper
// =============================================================================
describe("isPendingAliasError", () => {
	test("returns true when alias is pending and error matches", () => {
		expect(
			isPendingAliasError(
				{
					functionName: "tasks:list",
					errorMessage:
						'ArgumentValidationError: Path: .status Value: "open" Validator: v.union(...)',
				},
				["open"],
			),
		).toBe(true);
	});

	test("returns false when pending list is empty", () => {
		expect(
			isPendingAliasError(
				{
					functionName: "tasks:list",
					errorMessage:
						'ArgumentValidationError: Path: .status Value: "open" Validator: v.union(...)',
				},
				[],
			),
		).toBe(false);
	});
});

// =============================================================================
// Convex integration tests — getPendingAliasReleases + setPendingAliasReleases
// =============================================================================
describe("getPendingAliasReleases / setPendingAliasReleases (Convex layer)", () => {
	const modules = import.meta.glob("./**/*.ts");

	test("returns [] when no config row exists", async () => {
		const t = convexTest(schema, modules);
		const aliases = await t.query(api.errorMonitorFilters.getPendingAliasReleases);
		expect(aliases).toEqual([]);
	});

	test("setPendingAliasReleases upserts and getPendingAliasReleases reads back", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.errorMonitorFilters.setPendingAliasReleases, {
			aliases: ["open", "active"],
		});
		const aliases = await t.query(api.errorMonitorFilters.getPendingAliasReleases);
		expect(aliases).toEqual(["open", "active"]);
	});

	test("calling setPendingAliasReleases again overwrites (upsert behaviour)", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.errorMonitorFilters.setPendingAliasReleases, {
			aliases: ["open"],
		});
		await t.mutation(internal.errorMonitorFilters.setPendingAliasReleases, {
			aliases: ["active"],
		});
		const aliases = await t.query(api.errorMonitorFilters.getPendingAliasReleases);
		expect(aliases).toEqual(["active"]);
	});

	test("clearing with [] reflects post-deploy empty state", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.errorMonitorFilters.setPendingAliasReleases, {
			aliases: ["open"],
		});
		await t.mutation(internal.errorMonitorFilters.setPendingAliasReleases, {
			aliases: [],
		});
		const aliases = await t.query(api.errorMonitorFilters.getPendingAliasReleases);
		expect(aliases).toEqual([]);
	});
});

// =============================================================================
// addFilterRule idempotency + dedupeFilterRules — Issue k177wm2b duplication fix
// Prod had 11 identical active rules created by repeated addFilterRule calls
// (no dedup guard). This block locks the fix: identical adds are a no-op, and
// dedupeFilterRules collapses existing duplicate groups down to one (oldest).
// =============================================================================
describe("addFilterRule — idempotency", () => {
	const modules = import.meta.glob("./**/*.ts");

	const dupArgs = {
		functionName: "*",
		errorMessageRegex: "(Uncaught ConvexError|ArgumentValidationError)",
		reason: "dup test rule",
		severity: "skip" as const,
		priority: 100,
	};

	test("calling addFilterRule twice with an identical tuple creates only ONE active row and returns the same _id", async () => {
		const t = convexTest(schema, modules);
		const id1 = await t.mutation(internal.errorMonitorFilters.addFilterRule, dupArgs);
		const id2 = await t.mutation(internal.errorMonitorFilters.addFilterRule, dupArgs);
		expect(id2).toBe(id1);

		const rows = await t.query(api.errorMonitorFilters.listFilterRules, {});
		const matching = rows.filter(
			(r) =>
				r.active &&
				r.functionName === dupArgs.functionName &&
				r.errorMessageRegex === dupArgs.errorMessageRegex &&
				r.severity === dupArgs.severity,
		);
		expect(matching).toHaveLength(1);
	});

	test("addFilterRule with a DIFFERENT tuple (different regex) still inserts a new row", async () => {
		const t = convexTest(schema, modules);
		const id1 = await t.mutation(internal.errorMonitorFilters.addFilterRule, dupArgs);
		const id2 = await t.mutation(internal.errorMonitorFilters.addFilterRule, {
			...dupArgs,
			errorMessageRegex: "some other regex",
		});
		expect(id2).not.toBe(id1);

		const rows = await t.query(api.errorMonitorFilters.listFilterRules, {});
		expect(rows.filter((r) => r.active)).toHaveLength(2);
	});

	test("addFilterRule with a DIFFERENT severity still inserts a new row (tuple includes severity)", async () => {
		const t = convexTest(schema, modules);
		const id1 = await t.mutation(internal.errorMonitorFilters.addFilterRule, dupArgs);
		const id2 = await t.mutation(internal.errorMonitorFilters.addFilterRule, {
			...dupArgs,
			severity: "log-only",
		});
		expect(id2).not.toBe(id1);
	});
});

describe("dedupeFilterRules", () => {
	const modules = import.meta.glob("./**/*.ts");

	async function seedDuplicates(
		t: ReturnType<typeof convexTest<(typeof schema)["tables"]>>,
		count: number,
	) {
		// Insert N identical active rows directly, bypassing addFilterRule's
		// dedup guard, to reproduce the prod shape (11 duplicate rows created
		// before the idempotency guard existed).
		const ids: string[] = [];
		for (let i = 0; i < count; i++) {
			const id = await t.run(async (ctx) => {
				return await ctx.db.insert("errorMonitorFilterRules", {
					functionName: "*",
					errorMessageRegex: "(Uncaught ConvexError|ArgumentValidationError)",
					reason: `seed dup ${i}`,
					severity: "skip",
					active: true,
					createdAt: 1_000 + i, // ascending — row 0 is the oldest
					priority: 100,
				});
			});
			ids.push(id as unknown as string);
		}
		return ids;
	}

	test("collapses N identical active rows down to exactly 1, disabling N-1 (keeps the oldest)", async () => {
		const t = convexTest(schema, modules);
		const ids = await seedDuplicates(t, 11);

		const disabledCount = await t.mutation(
			internal.errorMonitorFilters.dedupeFilterRules,
			{},
		);
		expect(disabledCount).toBe(10);

		const rows = await t.query(api.errorMonitorFilters.listFilterRules, {});
		const active = rows.filter((r) => r.active);
		expect(active).toHaveLength(1);
		// Oldest row (createdAt: 1000, seed index 0) must be the survivor.
		expect(active[0]._id).toBe(ids[0]);
	});

	test("is a no-op on a second run (idempotent)", async () => {
		const t = convexTest(schema, modules);
		await seedDuplicates(t, 11);

		await t.mutation(internal.errorMonitorFilters.dedupeFilterRules, {});
		const secondRunDisabled = await t.mutation(
			internal.errorMonitorFilters.dedupeFilterRules,
			{},
		);
		expect(secondRunDisabled).toBe(0);
	});

	test("does not touch rules that are genuinely distinct", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.errorMonitorFilters.addFilterRule, {
			functionName: "tasks:complete",
			errorMessageRegex: "Unauthorized",
			reason: "distinct rule A",
			severity: "skip",
		});
		await t.mutation(internal.errorMonitorFilters.addFilterRule, {
			functionName: "missions:update",
			errorMessageRegex: "ArgumentValidationError",
			reason: "distinct rule B",
			severity: "skip",
		});

		const disabledCount = await t.mutation(
			internal.errorMonitorFilters.dedupeFilterRules,
			{},
		);
		expect(disabledCount).toBe(0);

		const rows = await t.query(api.errorMonitorFilters.listFilterRules, {});
		expect(rows.filter((r) => r.active)).toHaveLength(2);
	});
});
