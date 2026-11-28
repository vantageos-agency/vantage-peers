"use node";
// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorAutoResolver
// ─────────────────────────────────────────────────────────────────────────────
// Day 76 doctrine mechanism 3: "any automation that creates work must resolve it."
//
// Cron entry point: scans for stale auto-IRP missions and closes them.
// The cascade-close logic lives in errorMonitor.resolveStaleIrpMission
// (a plain internalMutation, no Node runtime required) so it can be tested
// without loading this "use node" file.
//
// Resolution cascade per closed mission:
//   1. Cascade-close all open tasks (status → "done", completionNote set).
//   2. Patch mission status → "complete".
//   3. Close the GitHub issue with a factual comment (no recurrence observed since <t>).
//   4. Mark the errorLog row as autoResolved = true.
//
// Legitimate path protection: if a linked PR exists on the GH issue, the
// mission is left open regardless of how long the error has been quiet.
//
// Linked: decisions/doctrine-evidence-bound-done-2026-05-20.md,
//         cascade #492–#502 post-mortem.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { AUTO_RESOLVE_QUIET_WINDOW_MS } from "./errorMonitor";
import { buildAutoResolveNote } from "./errorMonitorAutoResolveNote";
import { reportMonitorFailure } from "./errorMonitorHealth";

const VANTAGE_SIGNATURE = "VantageOS Team";

// ─────────────────────────────────────────────────────────────────────────────
// closeGitHubIssueWithComment
// ─────────────────────────────────────────────────────────────────────────────

type CloseResult =
	| { ok: true }
	| {
			ok: false;
			stage: string;
			code:
				| "ISSUE_CLOSE_COMMENT_FAILED"
				| "ISSUE_CLOSE_STATE_FAILED"
				| "ISSUE_CLOSE_THROWN";
	  };

// Every non-2xx answer and every thrown fetch is a FAILED close, returned to
// the caller to record. Response text and thrown messages are never surfaced.
async function closeGitHubIssueWithComment(
	owner: string,
	repo: string,
	issueNumber: number,
	token: string,
	today: string,
	lastSeenMs: number,
): Promise<CloseResult> {
	const base = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
	const headers = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "vantagepeers-bot/1.0",
	};

	try {
		const comment = await fetch(`${base}/comments`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				body: `${buildAutoResolveNote(lastSeenMs)}\n\n---\n*${VANTAGE_SIGNATURE} | ${today}*`,
			}),
		});
		if (!comment.ok) {
			return {
				ok: false,
				stage: "resolve:close",
				code: "ISSUE_CLOSE_COMMENT_FAILED",
			};
		}

		const patch = await fetch(base, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ state: "closed" }),
		});
		if (!patch.ok) {
			return {
				ok: false,
				stage: "resolve:close",
				code: "ISSUE_CLOSE_STATE_FAILED",
			};
		}
		return { ok: true };
	} catch {
		return { ok: false, stage: "resolve:close", code: "ISSUE_CLOSE_THROWN" };
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// hasLinkedPR — check if the GH issue has a linked PR
// ─────────────────────────────────────────────────────────────────────────────

// "unknown" is its own answer: a failed check is NOT "no PR". Treating it as
// "no" closed missions and issues that had active work linked.
type LinkedPrResult = "yes" | "no" | "unknown";

async function hasLinkedPR(
	owner: string,
	repo: string,
	issueNumber: number,
	token: string,
): Promise<LinkedPrResult> {
	try {
		const resp = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github.mockingbird-preview+json",
					"User-Agent": "vantagepeers-bot/1.0",
				},
			},
		);
		if (!resp.ok) return "unknown";

		const events = (await resp.json()) as Array<{ event?: string }>;
		if (!Array.isArray(events)) return "unknown";
		return events.some(
			(e) => e.event === "cross-referenced" || e.event === "connected",
		)
			? "yes"
			: "no";
	} catch {
		return "unknown";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// autoResolveStaleIrp — cron entry point
// ─────────────────────────────────────────────────────────────────────────────

export const autoResolveStaleIrp = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const token = process.env.GITHUB_TOKEN;
		const today = new Date().toISOString().split("T")[0];

		const staleErrors = await ctx.runQuery(
			internal.errorMonitor.listStaleAutoIrp,
			{ quietWindowMs: AUTO_RESOLVE_QUIET_WINDOW_MS, limit: 50 }, // rate-limit exception: scheduled cron batch (cadence = crons.ts "auto-resolve stale irp" interval, 6h), not a caller-facing rate limiter; limit:50 is the real per-run cap.
		);

		if (staleErrors.length === 0) {
			console.log("[AutoResolver] No stale auto-IRP missions to resolve.");
			return null;
		}

		console.log(
			`[AutoResolver] Found ${staleErrors.length} stale auto-IRP candidates.`,
		);

		// Without a token the linked-PR guard cannot run and the issue cannot be
		// closed. Closing the mission anyway would leave work-in-progress
		// unprotected and the issue open, so nothing is closed and the stop is
		// recorded against each affected deployment.
		if (!token) {
			const deployments = new Set(staleErrors.map((e) => e.deployment));
			for (const deployment of deployments) {
				await reportMonitorFailure(ctx, {
					deployment,
					stage: "resolve:token",
					code: "GITHUB_TOKEN_MISSING",
				});
			}
			return null;
		}

		let resolved = 0;
		let skipped = 0;

		for (const errorLog of staleErrors) {
			const missionId = errorLog.irpMissionId;
			if (!missionId) {
				await reportMonitorFailure(ctx, {
					deployment: errorLog.deployment,
					stage: "resolve:mission",
					code: "MISSION_LINK_MISSING",
				});
				continue;
			}

			const hasIssue = errorLog.issueNumber != null && !!errorLog.githubRepo;
			let owner = "";
			let repo = "";
			if (hasIssue) {
				[owner, repo] = (errorLog.githubRepo ?? "").split("/");
				if (!owner || !repo) {
					await reportMonitorFailure(ctx, {
						deployment: errorLog.deployment,
						stage: "resolve:repo",
						code: "GITHUB_REPO_INVALID",
					});
					skipped++;
					continue;
				}
			}

			// Guard: skip if a PR is already linked — active work is in progress.
			// An unanswerable check also skips: unknown is not "no PR".
			if (hasIssue && errorLog.issueNumber != null) {
				const pr = await hasLinkedPR(owner, repo, errorLog.issueNumber, token);
				if (pr === "unknown") {
					await reportMonitorFailure(ctx, {
						deployment: errorLog.deployment,
						stage: "resolve:pr-check",
						code: "PR_CHECK_FAILED",
					});
					skipped++;
					continue;
				}
				if (pr === "yes") {
					console.log(
						`[AutoResolver] Skipping errorLog ${errorLog._id} — linked PR found on #${errorLog.issueNumber}.`,
					);
					skipped++;
					continue;
				}
			}

			// Cascade-close mission + tasks + mark autoResolved
			const result = await ctx.runMutation(
				internal.errorMonitor.resolveStaleIrpMission,
				{ errorLogId: errorLog._id, missionId },
			);

			// Close the GH issue
			if (hasIssue && errorLog.issueNumber != null) {
				const closed = await closeGitHubIssueWithComment(
					owner,
					repo,
					errorLog.issueNumber,
					token,
					today,
					errorLog.lastSeen,
				);
				if (!closed.ok) {
					await reportMonitorFailure(ctx, {
						deployment: errorLog.deployment,
						stage: closed.stage,
						code: closed.code,
					});
				}
			}

			console.log(
				`[AutoResolver] Closed mission ${missionId} (errorLog ${errorLog._id}): ` +
					`${result.tasksClosedCount} tasks closed, missionClosed=${result.missionClosed}.`,
			);
			resolved++;
		}

		console.log(
			`[AutoResolver] Done. Closed: ${resolved}, skipped (PR linked or check failed): ${skipped}.`,
		);
		return null;
	},
});
