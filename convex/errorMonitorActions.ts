"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
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
	},
	returns: v.null(),
	handler: async (ctx, args) => {
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
			`*Auto-created by VantagePeers Error Monitor. Assigned to \`${args.orchestrator}\`.*`,
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
					title: `[Auto] Error in ${args.functionName}: ${args.errorMessage.slice(0, 80)}`,
					body,
					labels: ["bug", "auto-detected"],
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

			for (const entry of failures) {
				const functionName = entry.identifier ?? "unknown";
				const errorMessage = entry.error ?? "Unknown error";
				const logLines = entry.logLines ?? [];
				const hash = simpleHash(`${functionName}:${errorMessage}`);

				await ctx.runMutation(internal.errorMonitor.upsertError, {
					hash,
					deployment: args.deploymentName,
					functionName,
					errorMessage: errorMessage.slice(0, 500),
					stackTrace: (
						Array.isArray(logLines)
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

export const pollAllDeployments = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const deployments = (await ctx.runQuery(
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

		for (const dep of deployments) {
			await ctx.runAction(
				internal.errorMonitorActions.pollDeploymentLogs,
				{
					deploymentName: dep.name,
					deploymentUrl: dep.deploymentUrl,
					deployKeyEnvVar: dep.deployKeyEnvVar,
					githubRepo: dep.githubRepo,
					orchestrator: dep.orchestrator,
					lastCursor: dep.lastCursor,
				},
			);
		}

		return null;
	},
});
