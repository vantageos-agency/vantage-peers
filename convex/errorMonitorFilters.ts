// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorFilters
// ─────────────────────────────────────────────────────────────────────────────
// False-positive filtering for the auto-IRP bot. Two recurring noise classes
// were creating GitHub issues + IRP missions that did not represent real bugs:
//
//   1. RBAC deny-by-default rejections from `tasks:complete` and friends, e.g.
//      `Unauthorized: sigma is not creator or assignee of this task`. These
//      are correct security behavior per memory j573cwcs3znp0xsvtg34x435jh84b0eg
//      ("Never skip auth checks when the field is undefined") — not bugs.
//
//   2. The bot's own self-cascade: `missions:update` ArgumentValidationError
//      with truncated/empty `missionId` values that re-trigger the auto-IRP
//      loop, creating a noise feedback amplifier.
//
// Design notes :
// - Patterns are runtime-configurable via the `errorMonitorFilterRules` table
//   (NOT hardcoded), so Pi/Sigma can tune filters without redeploying. The
//   `DEFAULT_FILTER_RULES` array below is seeded into that table on first run
//   and serves as the in-process fallback if the table is empty (deny-by-noise).
// - `evaluateFilter()` is a pure synchronous function — taking a candidate
//   error + a list of rules — so it is trivially unit-testable without the
//   Convex sandbox. The Convex action layer is responsible for loading rules.
// - Severity semantics :
//     "skip"          → do NOT upsert / create issue
//     "log-only"      → emit console.log, do NOT create issue
//     "create-issue"  → normal flow (default for unmatched errors)
//
// Linked artefacts :
//   memory j573cwcs3znp0xsvtg34x435jh84b0eg  — RBAC review pattern
//   pattern m978zeg4b2e9nx67z2hg5rwgfs85hf7f — root-cause analysis
//   parent  k1794bfcmbv13790cht8aaagp585g9pa — Pi directive Day 50
//   mission k5700zmc41dsa0sav8sft4dpcd85g2a7 — this implementation
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Types — pure, no Convex deps so this file can be imported by test code
// ─────────────────────────────────────────────────────────────────────────────

export type FilterSeverity = "skip" | "log-only" | "create-issue";

export interface FilterRule {
	functionName: string; // exact match against Convex identifier ("tasks:complete")
	errorMessageRegex: RegExp;
	reason: string;
	severity: FilterSeverity;
}

export interface FilterRuleSerialized {
	functionName: string;
	errorMessageRegex: string; // serialized RegExp source
	regexFlags?: string;
	reason: string;
	severity: FilterSeverity;
}

export interface FilterDecision {
	shouldCreateIssue: boolean;
	matchedRule: FilterRule | null;
	severity: FilterSeverity; // "create-issue" if no rule matched
}

// ─────────────────────────────────────────────────────────────────────────────
// Default filter rules
// ─────────────────────────────────────────────────────────────────────────────
// Seeded into `errorMonitorFilterRules` on first run; also acts as the
// in-process fallback when the runtime table is empty.

export const DEFAULT_FILTER_RULES: ReadonlyArray<FilterRule> = [
	{
		functionName: "tasks:complete",
		errorMessageRegex: /Unauthorized: \w+ is not creator or assignee/,
		reason: "RBAC deny-by-default — by design per memory j573cwcs",
		severity: "skip",
	},
	{
		functionName: "missions:update",
		// Truncated id ends in `...` (≤15 chars before the ellipsis) OR empty
		// string. Two alternatives joined under a single regex for the canonical
		// validator-error shape emitted by Convex.
		errorMessageRegex:
			/ArgumentValidationError.*Path: \.missionId.*Value: "(?:[^"]{0,15}\.\.\."|")/,
		reason: "Truncated/empty missionId — likely self-cascade from auto-IRP bot",
		severity: "skip",
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// Pure evaluator — the unit-testable core
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether an error should propagate to GitHub-issue creation.
 * Pure function — no I/O, no globals. Caller passes in the rule set.
 *
 * Rule match = (functionName === rule.functionName) AND
 *              rule.errorMessageRegex.test(errorMessage).
 *
 * On match : returns the rule's severity. "skip" / "log-only" → no issue.
 * No match : returns severity "create-issue", shouldCreateIssue = true.
 */
export function evaluateFilter(
	candidate: { functionName: string; errorMessage: string },
	rules: ReadonlyArray<FilterRule> = DEFAULT_FILTER_RULES,
): FilterDecision {
	for (const rule of rules) {
		if (rule.functionName !== candidate.functionName) continue;
		// Re-create RegExp per call to avoid stateful `lastIndex` if /g is used.
		const re = new RegExp(
			rule.errorMessageRegex.source,
			rule.errorMessageRegex.flags,
		);
		if (re.test(candidate.errorMessage)) {
			return {
				shouldCreateIssue: rule.severity === "create-issue",
				matchedRule: rule,
				severity: rule.severity,
			};
		}
	}
	return {
		shouldCreateIssue: true,
		matchedRule: null,
		severity: "create-issue",
	};
}

/**
 * Convenience boolean wrapper used by hot-path callers.
 */
export function shouldCreateIssue(
	candidate: { functionName: string; errorMessage: string },
	rules: ReadonlyArray<FilterRule> = DEFAULT_FILTER_RULES,
): boolean {
	return evaluateFilter(candidate, rules).shouldCreateIssue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialization helpers (DB ↔ runtime)
// ─────────────────────────────────────────────────────────────────────────────

export function deserializeRule(raw: FilterRuleSerialized): FilterRule {
	return {
		functionName: raw.functionName,
		errorMessageRegex: new RegExp(raw.errorMessageRegex, raw.regexFlags ?? ""),
		reason: raw.reason,
		severity: raw.severity,
	};
}

export function serializeRule(rule: FilterRule): FilterRuleSerialized {
	return {
		functionName: rule.functionName,
		errorMessageRegex: rule.errorMessageRegex.source,
		regexFlags: rule.errorMessageRegex.flags || undefined,
		reason: rule.reason,
		severity: rule.severity,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Convex layer — load + seed runtime rules
// ─────────────────────────────────────────────────────────────────────────────

const severityValidator = v.union(
	v.literal("skip"),
	v.literal("log-only"),
	v.literal("create-issue"),
);

/**
 * Internal: load active rules from `errorMonitorFilterRules`. If the table is
 * empty (cold start), returns the in-process DEFAULT_FILTER_RULES (serialized
 * shape) so the caller still gets noise filtering on day-one.
 */
export const loadActiveRules = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			functionName: v.string(),
			errorMessageRegex: v.string(),
			regexFlags: v.optional(v.string()),
			reason: v.string(),
			severity: severityValidator,
		}),
	),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query("errorMonitorFilterRules")
			.withIndex("by_active", (q) => q.eq("active", true))
			.take(200);
		if (rows.length === 0) {
			return DEFAULT_FILTER_RULES.map(serializeRule);
		}
		return rows.map((r) => ({
			functionName: r.functionName,
			errorMessageRegex: r.errorMessageRegex,
			regexFlags: r.regexFlags,
			reason: r.reason,
			severity: r.severity,
		}));
	},
});

/**
 * Seed defaults if the table is empty. Idempotent — safe to call from a cron
 * or one-shot mutation. Returns the number of rows inserted.
 */
export const seedDefaultRules = internalMutation({
	args: {},
	returns: v.number(),
	handler: async (ctx) => {
		const existing = await ctx.db.query("errorMonitorFilterRules").take(1);
		if (existing.length > 0) return 0;
		let inserted = 0;
		for (const rule of DEFAULT_FILTER_RULES) {
			const s = serializeRule(rule);
			await ctx.db.insert("errorMonitorFilterRules", {
				functionName: s.functionName,
				errorMessageRegex: s.errorMessageRegex,
				regexFlags: s.regexFlags,
				reason: s.reason,
				severity: s.severity,
				active: true,
				createdAt: Date.now(),
			});
			inserted++;
		}
		return inserted;
	},
});

// Public admin surface — used by Sigma/Pi to add or disable a rule at runtime.

export const addFilterRule = mutation({
	args: {
		functionName: v.string(),
		errorMessageRegex: v.string(),
		regexFlags: v.optional(v.string()),
		reason: v.string(),
		severity: severityValidator,
	},
	returns: v.id("errorMonitorFilterRules"),
	handler: async (ctx, args) => {
		// Validate the regex compiles before persisting — fail fast.
		try {
			new RegExp(args.errorMessageRegex, args.regexFlags ?? "");
		} catch (err) {
			throw new Error(`Invalid errorMessageRegex: ${(err as Error).message}`);
		}
		return await ctx.db.insert("errorMonitorFilterRules", {
			functionName: args.functionName,
			errorMessageRegex: args.errorMessageRegex,
			regexFlags: args.regexFlags,
			reason: args.reason,
			severity: args.severity,
			active: true,
			createdAt: Date.now(),
		});
	},
});

export const disableFilterRule = mutation({
	args: { ruleId: v.id("errorMonitorFilterRules") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.ruleId);
		if (row) {
			await ctx.db.patch(args.ruleId, { active: false });
		}
		return null;
	},
});

export const listFilterRules = query({
	args: {},
	returns: v.array(
		v.object({
			_id: v.id("errorMonitorFilterRules"),
			_creationTime: v.number(),
			functionName: v.string(),
			errorMessageRegex: v.string(),
			regexFlags: v.optional(v.string()),
			reason: v.string(),
			severity: severityValidator,
			active: v.boolean(),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx) => {
		return await ctx.db
			.query("errorMonitorFilterRules")
			.order("desc")
			.take(200);
	},
});
