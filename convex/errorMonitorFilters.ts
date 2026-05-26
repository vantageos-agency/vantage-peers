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
	// v1.0.1 — higher = evaluated first. Treat undefined as 0.
	priority?: number;
	// v1.0.1 — stable tiebreak when two rules share the same priority. Lower
	// `_creationTime` wins (older rule first). Optional because in-process
	// DEFAULT_FILTER_RULES have no creation time; treat undefined as 0.
	creationTime?: number;
	// v1.0.1 — opaque ruleId so the action layer can fire-and-forget a
	// `incrementRuleMatch` mutation when a skip/log-only rule fires. Optional
	// because the in-process DEFAULT_FILTER_RULES fallback has no row.
	ruleId?: string;
}

export interface FilterRuleSerialized {
	functionName: string;
	errorMessageRegex: string; // serialized RegExp source
	regexFlags?: string;
	reason: string;
	severity: FilterSeverity;
	priority?: number;
	creationTime?: number;
	ruleId?: string;
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
 * v1.0.1 — rules are evaluated in priority order: highest `priority` first,
 * with `_creationTime` ascending as the stable tiebreaker. Treat undefined
 * priority as 0 and undefined creationTime as 0. The first match wins.
 *
 * On match : returns the rule's severity. "skip" / "log-only" → no issue.
 * No match : returns severity "create-issue", shouldCreateIssue = true.
 */
export function evaluateFilter(
	candidate: { functionName: string; errorMessage: string },
	rules: ReadonlyArray<FilterRule> = DEFAULT_FILTER_RULES,
): FilterDecision {
	// Sort copy — don't mutate the caller's array.
	const sorted = [...rules].sort((a, b) => {
		const pa = a.priority ?? 0;
		const pb = b.priority ?? 0;
		if (pa !== pb) return pb - pa; // higher priority first
		const ca = a.creationTime ?? 0;
		const cb = b.creationTime ?? 0;
		return ca - cb; // older creation time first (stable tiebreak)
	});
	for (const rule of sorted) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Pending-alias release helpers — pure, no Convex deps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The set of Convex function names that accept a `status` field which may
 * carry a new status alias during the pre-deploy smoke window.
 */
const ALIAS_FUNCTION_NAMES = [
	"tasks:list",
	"missions:list",
	"tasks:listByMission",
	"briefingNotes:list",
] as const;

/**
 * Synthesise transient FilterRules for status aliases that are part of an
 * in-flight release but have not yet reached prod. For each alias, one rule
 * per function name is produced so ArgumentValidationError noise during
 * pre-deploy smoke does not spawn GitHub issues.
 *
 * Call `setPendingAliasReleases` BEFORE the pre-deploy smoke run; call it
 * again with an empty array once the deploy is live in prod.
 */
export function synthesizePendingAliasRules(
	pendingAliases: string[],
): FilterRule[] {
	const rules: FilterRule[] = [];
	for (const alias of pendingAliases) {
		for (const functionName of ALIAS_FUNCTION_NAMES) {
			rules.push({
				functionName,
				// Matches: ArgumentValidationError … Path: .status … Value: "<alias>"
				errorMessageRegex: new RegExp(
					`ArgumentValidationError.*Path: \\.status.*Value: "${alias}"`,
				),
				reason: `Pending alias release: ${alias} not yet deployed`,
				severity: "skip",
			});
		}
	}
	return rules;
}

/**
 * Convenience boolean: is this candidate error suppressed because `alias` is
 * in the pending-alias list?
 */
export function isPendingAliasError(
	candidate: { functionName: string; errorMessage: string },
	pendingAliases: string[],
): boolean {
	const rules = synthesizePendingAliasRules(pendingAliases);
	return !evaluateFilter(candidate, rules).shouldCreateIssue;
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
		priority: raw.priority,
		creationTime: raw.creationTime,
		ruleId: raw.ruleId,
	};
}

export function serializeRule(rule: FilterRule): FilterRuleSerialized {
	return {
		functionName: rule.functionName,
		errorMessageRegex: rule.errorMessageRegex.source,
		regexFlags: rule.errorMessageRegex.flags || undefined,
		reason: rule.reason,
		severity: rule.severity,
		priority: rule.priority,
		creationTime: rule.creationTime,
		ruleId: rule.ruleId,
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
 * Internal: load active rules from `errorMonitorFilterRules`, plus any
 * synthesized rules for pending alias releases from `errorMonitorConfig`.
 * If the errorMonitorFilterRules table is empty (cold start), uses the
 * in-process DEFAULT_FILTER_RULES so noise filtering works on day-one.
 *
 * Synthesized pending-alias rules are appended AFTER DB rules — they have
 * no persistent ruleId so `incrementRuleMatch` is never called for them.
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
			priority: v.optional(v.number()),
			creationTime: v.optional(v.number()),
			ruleId: v.optional(v.string()),
		}),
	),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query("errorMonitorFilterRules")
			.withIndex("by_active", (q) => q.eq("active", true))
			.take(200);

		const dbRules: FilterRuleSerialized[] =
			rows.length === 0
				? DEFAULT_FILTER_RULES.map(serializeRule)
				: rows.map((r) => ({
						functionName: r.functionName,
						errorMessageRegex: r.errorMessageRegex,
						regexFlags: r.regexFlags,
						reason: r.reason,
						severity: r.severity,
						priority: r.priority,
						creationTime: r._creationTime,
						ruleId: r._id as string,
					}));

		// Load pending alias list from config table (key = "pendingAliasReleases").
		const configRow = await ctx.db
			.query("errorMonitorConfig")
			.withIndex("by_key", (q) => q.eq("key", "pendingAliasReleases"))
			.unique();
		const pendingAliases: string[] = configRow?.value ?? [];

		const synthesized = synthesizePendingAliasRules(pendingAliases).map(
			serializeRule,
		);

		return [...dbRules, ...synthesized];
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
		priority: v.optional(v.number()),
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
			priority: args.priority,
		});
	},
});

// v1.0.1 — observability counter bump. Called fire-and-forget from
// pollDeploymentLogs when a rule's severity is "skip" or "log-only" so
// operators can see which filter rules are actually firing in prod and
// which ones are dead weight.
export const incrementRuleMatch = internalMutation({
	args: { ruleId: v.id("errorMonitorFilterRules") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.ruleId);
		if (!row) return null;
		await ctx.db.patch(args.ruleId, {
			matchCount: (row.matchCount ?? 0) + 1,
			lastMatchedAt: Date.now(),
		});
		return null;
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
			lastMatchedAt: v.optional(v.number()),
			matchCount: v.optional(v.number()),
			priority: v.optional(v.number()),
		}),
	),
	handler: async (ctx) => {
		return await ctx.db
			.query("errorMonitorFilterRules")
			.order("desc")
			.take(200);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Pending-alias release config — dynamic filter management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the current list of status aliases that are pending deployment.
 * Returns an empty array when no aliases are pending (the normal state after
 * a successful prod deploy).
 *
 * Doctrine: add aliases BEFORE pre-deploy smoke; remove (set []) once deployed.
 */
export const getPendingAliasReleases = query({
	args: {},
	returns: v.array(v.string()),
	handler: async (ctx) => {
		const row = await ctx.db
			.query("errorMonitorConfig")
			.withIndex("by_key", (q) => q.eq("key", "pendingAliasReleases"))
			.unique();
		return row?.value ?? [];
	},
});

/**
 * Upsert the list of status aliases that are pending deployment.
 * Pass an empty array to clear (post-deploy state).
 *
 * v1.0.1 — converted to internalMutation per Eta delta-review PR #530 :
 * public mutation was a DoS surface against the auto-IRP pipeline. Lifecycle
 * operation only — invoke via internal action / script, never from MCP.
 */
export const setPendingAliasReleases = internalMutation({
	args: { aliases: v.array(v.string()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("errorMonitorConfig")
			.withIndex("by_key", (q) => q.eq("key", "pendingAliasReleases"))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, {
				value: args.aliases,
				updatedAt: Date.now(),
			});
		} else {
			await ctx.db.insert("errorMonitorConfig", {
				key: "pendingAliasReleases",
				value: args.aliases,
				updatedAt: Date.now(),
			});
		}
		return null;
	},
});
