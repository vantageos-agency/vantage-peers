"use node";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { RECURRING_ESCALATION_TITLE_PREFIX } from "./errorMonitor";
import {
	deserializeRule,
	evaluateFilter,
	type FilterRule,
	isTransientErrorMessage,
} from "./errorMonitorFilters";
import { isDeployWindowActive } from "./errorMonitorDeployWindow";
import { computeGroupKey } from "./errorMonitorGroupKey";
import {
	assertKillSwitchHealth,
	isKillSwitchActive,
} from "./errorMonitorKillSwitch";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash |= 0;
	}
	return Math.abs(hash).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────
// createGitHubIssue — scheduled from upsertError when a new error is detected
// ─────────────────────────────────────────────────────────────────────────────

export const createGitHubIssue = internalAction({
	args: {
		errorId: v.id("errorLogs"),
		githubRepo: v.string(),
		functionName: v.string(),
		errorMessage: v.string(),
		stackTrace: v.string(),
		deployment: v.string(),
		orchestrator: v.string(),
		// Day 107 — set by upsertError when the error re-fires after the
		// 24h cross-tick window has elapsed AND the previous IRP was already
		// created. The mission title is prefixed with
		// RECURRING_ESCALATION_TITLE_PREFIX so the orchestrator can route it
		// as an escalation rather than a fresh report.
		recurringEscalation: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// D90 hardening — kill-switch guard at the createGitHubIssue layer.
		// Day 88 PR #609 guarded only pollAllDeployments; the scheduler.runAfter
		// call from upsertError bypassed that guard, letting #632 fire despite
		// AUTO_IRP_PAUSED=true on prod.
		if (isKillSwitchActive()) {
			console.log(
				"[createGitHubIssue] Skipped — AUTO_IRP_PAUSED env var is 'true'.",
			);
			return null;
		}
		// Day 128 hardening (issue #1088, Bug 1) — belt-and-suspenders guard
		// mirroring the kill-switch pattern above. upsertError's scheduler.
		// runAfter call is the primary suppression point (pollDeploymentLogs
		// skips upsertError entirely during a declared deploy window), but a
		// race (in-flight scheduled call from just before the window opened)
		// is caught here too. See errorMonitorDeployWindow.ts for the
		// non-forgeable-signal rationale.
		if (isDeployWindowActive(Date.now())) {
			console.log(
				`[createGitHubIssue] Skipped — DEPLOY_WINDOW_UNTIL_MS is active for ${args.deployment}.`,
			);
			return null;
		}
		// D90 hardening — transient retry-class classification. A "Server Error
		// + Request ID" envelope that succeeded on immediate caller-side retry
		// must NEVER escalate to a GitHub issue + IRP cascade (issue #632 root).
		if (isTransientErrorMessage(args.errorMessage)) {
			console.log(
				`[createGitHubIssue] Skipped — transient retry-class error in ${args.functionName} on ${args.deployment}.`,
			);
			return null;
		}
		const token = process.env.GITHUB_TOKEN;
		if (!token) {
			console.warn(
				"[ErrorMonitor] GITHUB_TOKEN not set — skipping issue creation",
			);
			return null;
		}

		const [owner, repo] = args.githubRepo.split("/");
		if (!owner || !repo) {
			console.warn(
				`[ErrorMonitor] Invalid githubRepo format "${args.githubRepo}" — expected "owner/repo"`,
			);
			return null;
		}

		const body = [
			"## Auto-detected Error",
			"",
			`**Deployment:** ${args.deployment}`,
			`**Function:** \`${args.functionName}\``,
			`**Detected:** ${new Date().toISOString()}`,
			"",
			"### Error Message",
			"```",
			args.errorMessage,
			"```",
			"",
			"### Stack Trace",
			"```",
			args.stackTrace.slice(0, 3000),
			"```",
			"",
			"---",
			`*Auto-created by VantagePeers Error Monitor. Orchestrator: ${args.orchestrator.charAt(0).toUpperCase() + args.orchestrator.slice(1)} — VantageOS Team | ${new Date().toISOString().split("T")[0]}*`,
		].join("\n");

		const resp = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/issues`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "vantagepeers-bot/1.0",
				},
				body: JSON.stringify({
					title: args.recurringEscalation
						? `${RECURRING_ESCALATION_TITLE_PREFIX} [Auto] Error in ${args.functionName}: ${args.errorMessage.slice(0, 80)}`
						: `[Auto] Error in ${args.functionName}: ${args.errorMessage.slice(0, 80)}`,
					body,
					labels: args.recurringEscalation
						? ["bug", "auto-detected", "recurring-24h"]
						: ["bug", "auto-detected"],
				}),
			},
		);

		if (resp.ok) {
			const issue = (await resp.json()) as { number: number };
			await ctx.runMutation(internal.errorMonitor.linkIssue, {
				errorId: args.errorId,
				issueNumber: issue.number,
				githubRepo: args.githubRepo,
			});
		} else {
			const text = await resp.text();
			console.error(
				`[ErrorMonitor] GitHub issue creation failed: ${resp.status} — ${text}`,
			);
		}

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// pollDeploymentLogs — fetch failure entries from a single deployment
// ─────────────────────────────────────────────────────────────────────────────

export const pollDeploymentLogs = internalAction({
	args: {
		deploymentName: v.string(),
		deploymentUrl: v.string(),
		deployKeyEnvVar: v.string(),
		githubRepo: v.string(),
		orchestrator: v.string(),
		lastCursor: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const deployKey = process.env[args.deployKeyEnvVar];
		if (!deployKey) {
			console.warn(
				`[ErrorMonitor] No deploy key found for env var "${args.deployKeyEnvVar}" — skipping ${args.deploymentName}`,
			);
			return null;
		}

		const cursorParam = args.lastCursor != null ? args.lastCursor : 0;
		const url = `${args.deploymentUrl}/api/stream_function_logs?cursor=${cursorParam}`;

		try {
			const resp = await fetch(url, {
				headers: {
					Authorization: `Convex ${deployKey}`,
					"Content-Type": "application/json",
				},
			});

			if (!resp.ok) {
				console.error(
					`[ErrorMonitor] Failed to fetch logs for ${args.deploymentName}: HTTP ${resp.status}`,
				);
				return null;
			}

			const data = (await resp.json()) as {
				entries?: Array<{
					kind?: string;
					identifier?: string;
					success?: boolean | null;
					error?: string | null;
					error_message?: string;
					logLines?: string[];
					timestamp?: number;
				}>;
				newCursor?: number;
			};

			// Filter to Completion entries with a non-null error field
			const failures = (data.entries ?? []).filter(
				(e) => e.kind === "Completion" && e.error != null,
			);

			// Load runtime filter rules once per poll (skips false-positive
			// classes like RBAC denies + truncated-id self-cascades). Falls back
			// to DEFAULT_FILTER_RULES inside loadActiveRules if the table is empty.
			const rawRules = await ctx.runQuery(
				internal.errorMonitorFilters.loadActiveRules,
				{},
			);
			const filterRules: FilterRule[] = rawRules.map(deserializeRule);

			// Group errors by module (file) + error message within the batch
			// e.g., audioTracks:processAudio and audioTracks:getInternal with same error → one issue
			const grouped = new Map<
				string,
				{ functionNames: string[]; errorMessage: string; logLines: string[] }
			>();

			for (const entry of failures) {
				const functionName = entry.identifier ?? "unknown";
				const errorMessage = entry.error ?? "Unknown error";
				const logLines = entry.logLines ?? [];
				// Extract module name (file) from "module:function" or "module/sub:function"
				const moduleName = functionName.includes(":")
					? functionName.split(":")[0]
					: functionName;
				// Day 107 refactor (fix-pattern m97cw4xf93qxgf3gg1f46fz4eh87xgfp).
				// groupKey is now a TUPLE (module, validator_keyword) — see
				// errorMonitorGroupKey.ts for the extraction rules. Tail variance
				// (request IDs, timestamps, hex argument blobs) is collapsed so
				// the same root cause produces a stable hash across log entries.
				const groupKey = computeGroupKey(moduleName, errorMessage);

				const existing = grouped.get(groupKey);
				if (existing) {
					if (!existing.functionNames.includes(functionName)) {
						existing.functionNames.push(functionName);
					}
					// Keep the longest log lines
					if (logLines.length > existing.logLines.length) {
						existing.logLines = logLines;
					}
				} else {
					grouped.set(groupKey, {
						functionNames: [functionName],
						errorMessage,
						logLines,
					});
				}
			}

			for (const [groupKey, group] of grouped) {
				const functionName = group.functionNames.join(", ");
				const errorMessage = group.errorMessage;
				const logLines = group.logLines;
				const hash = simpleHash(groupKey);

				// Evaluate against each individual function name in the group —
				// the joined string would never match a single-function rule.
				let decision = evaluateFilter(
					{ functionName, errorMessage },
					filterRules,
				);
				if (!decision.matchedRule) {
					for (const single of group.functionNames) {
						const d = evaluateFilter(
							{ functionName: single, errorMessage },
							filterRules,
						);
						if (d.matchedRule) {
							decision = d;
							break;
						}
					}
				}

				// v1.0.1 — observability bump for filter hits. The pure
				// `evaluateFilter` returns the matched rule's `ruleId` (when the
				// rule originated from the runtime table; in-process defaults
				// have no ruleId). Schedule a fire-and-forget mutation so we
				// don't block the poll loop on the patch.
				const ruleId = decision.matchedRule?.ruleId;
				if (
					ruleId &&
					(decision.severity === "skip" || decision.severity === "log-only")
				) {
					await ctx.runMutation(
						internal.errorMonitorFilters.incrementRuleMatch,
						{ ruleId: ruleId as Id<"errorMonitorFilterRules"> },
					);
				}

				if (decision.severity === "skip") {
					// Drop silently — false-positive class.
					continue;
				}
				if (decision.severity === "log-only") {
					console.log(
						`[ErrorMonitor] log-only filter (${decision.matchedRule?.reason ?? "n/a"}) — ${functionName}: ${errorMessage.slice(0, 120)}`,
					);
					continue;
				}

				// Day 128 hardening (issue #1088, Bug 1) — an operator-declared
				// deploy window (DEPLOY_WINDOW_UNTIL_MS env var, settable only via
				// `npx convex env set` / dashboard — never forgeable by anything a
				// probe/API caller can pass as an argument) suppresses feeding this
				// tick's errors into the escalation pipeline. Still logged for
				// observability, just never upserted/escalated. See
				// errorMonitorDeployWindow.ts for the full non-forgeable-signal
				// rationale and its explicit HONEST LIMITATION section.
				if (isDeployWindowActive(Date.now())) {
					console.log(
						`[ErrorMonitor] deploy-window active — skipping escalation pipeline for ${functionName}: ${errorMessage.slice(0, 120)}`,
					);
					continue;
				}

				await ctx.runMutation(internal.errorMonitor.upsertError, {
					hash,
					deployment: args.deploymentName,
					functionName,
					errorMessage: errorMessage.slice(0, 500),
					stackTrace: (Array.isArray(logLines)
						? logLines.join("\n")
						: String(logLines)
					).slice(0, 2000),
					githubRepo: args.githubRepo,
					orchestrator: args.orchestrator,
				});
			}

			if (data.newCursor != null) {
				await ctx.runMutation(internal.errorMonitor.updateCursor, {
					deploymentName: args.deploymentName,
					cursor: data.newCursor,
				});
			}
		} catch (err) {
			console.error(
				`[ErrorMonitor] Exception polling ${args.deploymentName}:`,
				err,
			);
		}

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// pollAllDeployments — cron entry point: polls every active deployment
// ─────────────────────────────────────────────────────────────────────────────

// R-20 — per-run bound on the polled-deployment fan-out. listActiveDeployments
// already bounds its own read to .take(50) (errorMonitor.ts), but the fan-out
// loop below bounds independently so this file is self-describing and a future
// change to the upstream cap can't silently unbound this action's runtime.
const DEPLOY_POLL_CAP = 50;

export const pollAllDeployments = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		// D90 — startup health check (belt-and-suspenders). Loudly warns in logs
		// when AUTO_IRP_PAUSED is unset so a missing env var is visible without
		// crashing the deployment. See errorMonitorKillSwitch.ts for contract.
		assertKillSwitchHealth();

		// Kill-switch: set AUTO_IRP_PAUSED=true in Convex env to skip the entire
		// auto-IRP generation pipeline (poll → upsertError → createGitHubIssue →
		// IRP mission cascade). Reversible without code re-deploy — just toggle env
		// in Convex dashboard. Introduced 2026-06-02 for pre-public repo cleanup
		// (Day 90 mission k57e4t21sr55rhz8ng554eseb987wvh3, T4 step). Unset/set-false
		// to re-enable after public switch + matcher-gap fix lands.
		// D90 hardened : uses shared isKillSwitchActive() helper. Same guard is
		// now also applied at createGitHubIssue and http.ts webhook layers.
		if (isKillSwitchActive()) {
			console.log(
				"[pollAllDeployments] Skipped — AUTO_IRP_PAUSED env var is set to 'true'.",
			);
			return null;
		}

		const allDeployments = (await ctx.runQuery(
			internal.errorMonitor.listActiveDeployments,
			{},
		)) as Array<{
			_id: string;
			name: string;
			deploymentUrl: string;
			deployKeyEnvVar: string;
			githubRepo: string;
			orchestrator: string;
			active: boolean;
			lastCursor?: number;
		}>;
		const deployments = allDeployments.slice(0, DEPLOY_POLL_CAP);

		for (const dep of deployments) {
			await ctx.runAction(internal.errorMonitorActions.pollDeploymentLogs, {
				deploymentName: dep.name,
				deploymentUrl: dep.deploymentUrl,
				deployKeyEnvVar: dep.deployKeyEnvVar,
				githubRepo: dep.githubRepo,
				orchestrator: dep.orchestrator,
				lastCursor: dep.lastCursor,
			});
		}

		console.log(
			`[pollAllDeployments] Polled ${deployments.length}/${allDeployments.length} active deployment(s) this run (cap=${DEPLOY_POLL_CAP}).`,
		);

		return null;
	},
});
