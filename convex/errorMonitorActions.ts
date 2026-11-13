"use node";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { RECURRING_ESCALATION_TITLE_PREFIX } from "./errorMonitor";
import { isDeployWindowActive } from "./errorMonitorDeployWindow";
import {
	deserializeRule,
	type FilterRule,
	isTransientErrorMessage,
} from "./errorMonitorFilters";
import { resolveFunctionVisibility } from "./errorMonitorFunctionVisibility";
import { computeGroupKey } from "./errorMonitorGroupKey";
import {
	assertKillSwitchHealth,
	isKillSwitchActive,
} from "./errorMonitorKillSwitch";
import { decideGroupAction } from "./errorMonitorPollDecision";
import { buildErrorTaskBody, errorTaskTag } from "./errorMonitorTaskBody";

// The backend owner: every error task goes to one named assignee in one project.
const OWNER_ASSIGNEE = "sigma";
const OWNER_PROJECT = "vantage-peers";

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
// createGitHubIssue -- scheduled from upsertError when a new error is detected
// ─────────────────────────────────────────────────────────────────────────────
// NAME IS HISTORICAL. This action no longer talks to GitHub: the repository is
// public and an issue body once echoed a client name and internal ids. It files
// ONE VantagePeers task for the backend owner (assignedTo "sigma", project
// "vantage-peers") through the existing internal door `tasks:createForWebhook`,
// and the GitHub POST / comment / open-check calls are DELETED, not gated.
// The registered name is kept so in-flight scheduled jobs and the generated
// arg-name catalogue keep resolving; renaming it is a separate change.

/** The list return is a union of lite/full shapes; read `tags` defensively. */
function hasTag(row: unknown, tag: string): boolean {
	const tags = (row as { tags?: unknown }).tags;
	return Array.isArray(tags) && tags.includes(tag);
}

/** Open statuses a repeat occurrence is deduplicated against. */
const OPEN_TASK_STATUSES = ["todo", "in_progress", "review", "blocked"];
/** Most recent open tasks of the owner read for the dedupe (newest first). */
const DEDUPE_SCAN_LIMIT = 200;

export const createGitHubIssue = internalAction({
	args: {
		errorId: v.id("errorLogs"),
		githubRepo: v.string(),
		functionName: v.string(),
		errorMessage: v.string(),
		stackTrace: v.string(),
		deployment: v.string(),
		orchestrator: v.string(),
		// Day 107 -- set by upsertError when the error re-fires after the
		// 24h cross-tick window has elapsed AND the previous report already
		// existed. The task title is prefixed with
		// RECURRING_ESCALATION_TITLE_PREFIX so it routes as an escalation.
		recurringEscalation: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// D90 hardening -- kill-switch guard at this layer. The scheduler.runAfter
		// call from upsertError bypasses the guard in pollAllDeployments.
		if (isKillSwitchActive()) {
			console.log(
				"[createGitHubIssue] Skipped -- AUTO_IRP_PAUSED env var is 'true'.",
			);
			return null;
		}
		// Day 128 hardening (issue #1088, Bug 1) -- belt-and-suspenders for an
		// in-flight scheduled call from just before a deploy window opened.
		if (isDeployWindowActive(Date.now())) {
			console.log(
				`[createGitHubIssue] Skipped -- DEPLOY_WINDOW_UNTIL_MS is active for ${args.deployment}.`,
			);
			return null;
		}
		// D90 hardening -- a transient retry-class envelope never escalates.
		if (isTransientErrorMessage(args.errorMessage)) {
			console.log(
				`[createGitHubIssue] Skipped -- transient retry-class error in ${args.functionName} on ${args.deployment}.`,
			);
			return null;
		}

		const errorLog = await ctx.runQuery(internal.errorMonitor.getErrorLogById, {
			errorId: args.errorId,
		});
		if (errorLog === null) {
			console.warn(
				`[ErrorMonitor] errorLogs row ${args.errorId} not found -- no task filed`,
			);
			return null;
		}

		const body = buildErrorTaskBody({
			functionName: args.functionName,
			errorMessage: args.errorMessage,
			hash: errorLog.hash,
			detectedAt: Date.now(),
			titlePrefix: args.recurringEscalation
				? RECURRING_ESCALATION_TITLE_PREFIX
				: undefined,
		});
		const dedupeTag = errorTaskTag(errorLog.hash);

		// Dedupe, mirroring the issue path: a repeat whose task is still OPEN
		// files nothing; a task that is done (the "closed issue") or a failed
		// read both fall through and file a new one. A failed read degrades
		// toward noise (a possible duplicate), never toward silence.
		try {
			const open = await ctx.runQuery(internal.tasks.listForWebhook, {
				// No assignedTo here: the per-hash tag below already identifies the
				// monitor's own task, and the project+status read is the shape the
				// tasks list serves for a multi-status array.
				project: OWNER_PROJECT,
				status: OPEN_TASK_STATUSES,
				limit: DEDUPE_SCAN_LIMIT,
				fields: "full",
			});
			if (
				Array.isArray(open) &&
				open.some((t) => hasTag(t, dedupeTag))
			) {
				return null;
			}
		} catch (err) {
			console.error("[ErrorMonitor] open-task dedupe read failed:", err);
		}

		await ctx.runMutation(internal.tasks.createForWebhook, {
			title: body.title,
			description: body.description,
			project: OWNER_PROJECT,
			tags: body.tags,
			assignedTo: OWNER_ASSIGNEE,
			priority: args.recurringEscalation ? "high" : "medium",
			status: "todo",
			createdBy: "error-monitor",
		});
		await ctx.runMutation(internal.errorMonitor.markTaskFiled, {
			errorId: args.errorId,
		});

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

				// The actual decision -- what should happen to this group -- is
				// a pure function (errorMonitorPollDecision.ts's
				// `decideGroupAction`), not inline logic here. This action is a
				// thin shell around it: build the group, get back an action,
				// perform the I/O the action calls for. See that module's doc
				// for why this extraction exists (coordinator feedback, task
				// k17dthw4ky2w0bhevzy3dawz9h8ezd3e) -- a decision buried in an
				// action doing live HTTP + scheduler calls cannot be
				// mutation-tested; this can.
				const action = decideGroupAction(
					{ functionNames: group.functionNames, errorMessage },
					filterRules,
					resolveFunctionVisibility,
				);

				// v1.0.1 — observability bump for filter hits. The pure
				// `evaluateFilter` (inside `decideGroupAction`) returns the
				// matched rule's `ruleId` (when the rule originated from the
				// runtime table; in-process defaults have no ruleId).
				// Schedule a fire-and-forget mutation so we don't block the
				// poll loop on the patch.
				if (
					(action.kind === "skip" || action.kind === "log-only") &&
					action.ruleId
				) {
					await ctx.runMutation(
						internal.errorMonitorFilters.incrementRuleMatch,
						{ ruleId: action.ruleId as Id<"errorMonitorFilterRules"> },
					);
				}

				if (action.kind === "skip") {
					// Drop silently — false-positive class.
					continue;
				}
				if (action.kind === "log-only") {
					console.log(
						`[ErrorMonitor] log-only filter (${action.reason}) — ${functionName}: ${errorMessage.slice(0, 120)}`,
					);
					continue;
				}
				if (action.kind === "access-refusal") {
					// Name the door only: the message may carry data.
					console.log(
						`[ErrorMonitor] access refusal (${action.reason}) -- ${functionName}`,
					);
					continue;
				}
				if (action.kind === "working-refusal") {
					// Issue #1297 (closed NOT A DEFECT, task
					// k17dthw4ky2w0bhevzy3dawz9h8ezd3e) — a validator caught a
					// malformed caller argument on a function this repo
					// registers PUBLIC. This is the protection working, not a
					// defect. See errorMonitorRefusalClassifier.ts and
					// errorMonitorPollDecision.ts for the full rationale,
					// including the honest limitation: a bad argument our OWN
					// code sends to a public function is indistinguishable
					// from an external caller's and is ALSO silenced here,
					// because Convex's log payload carries no caller-identity
					// field to tell the two apart.
					console.log(
						`[ErrorMonitor] working refusal (${action.reason}) — ${functionName}: ${errorMessage.slice(0, 120)}`,
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
