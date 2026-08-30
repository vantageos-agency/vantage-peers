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
//   3. Close the GitHub issue with a standard auto-resolve comment.
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

// ─────────────────────────────────────────────────────────────────────────────
// Constants (shared with resolveStaleIrpMission in errorMonitor.ts)
// ─────────────────────────────────────────────────────────────────────────────

const AUTO_RESOLVE_NOTE =
	"Auto-resolved — error stopped recurring (no occurrences in 24h, no PR opened). " +
	"Closing to keep queues clean. Re-open if it returns.";

const VANTAGE_SIGNATURE = "VantageOS Team";

// ─────────────────────────────────────────────────────────────────────────────
// closeGitHubIssueWithComment
// ─────────────────────────────────────────────────────────────────────────────

async function closeGitHubIssueWithComment(
	githubRepo: string,
	issueNumber: number,
	token: string,
	today: string,
): Promise<void> {
	const [owner, repo] = githubRepo.split("/");
	if (!owner || !repo) return;

	const base = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
	const headers = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "vantagepeers-bot/1.0",
	};

	await fetch(`${base}/comments`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			body: `${AUTO_RESOLVE_NOTE}\n\n---\n*${VANTAGE_SIGNATURE} | ${today}*`,
		}),
	});

	await fetch(base, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ state: "closed" }),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// hasLinkedPR — check if the GH issue has a linked PR
// ─────────────────────────────────────────────────────────────────────────────

async function hasLinkedPR(
	githubRepo: string,
	issueNumber: number,
	token: string,
): Promise<boolean> {
	const [owner, repo] = githubRepo.split("/");
	if (!owner || !repo) return false;

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
	if (!resp.ok) return false;

	const events = (await resp.json()) as Array<{ event?: string }>;
	return events.some(
		(e) => e.event === "cross-referenced" || e.event === "connected",
	);
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

		let resolved = 0;
		let skipped = 0;

		for (const errorLog of staleErrors) {
			const missionId = errorLog.irpMissionId;
			if (!missionId) continue;

			// Guard: skip if a PR is already linked — active work is in progress
			if (token && errorLog.issueNumber != null && errorLog.githubRepo) {
				const hasPR = await hasLinkedPR(
					errorLog.githubRepo,
					errorLog.issueNumber,
					token,
				);
				if (hasPR) {
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
			if (token && errorLog.issueNumber != null && errorLog.githubRepo) {
				try {
					await closeGitHubIssueWithComment(
						errorLog.githubRepo,
						errorLog.issueNumber,
						token,
						today,
					);
				} catch (err) {
					console.warn(
						`[AutoResolver] GH issue close failed for #${errorLog.issueNumber}:`,
						err,
					);
				}
			}

			console.log(
				`[AutoResolver] Resolved mission ${missionId} (errorLog ${errorLog._id}): ` +
					`${result.tasksClosedCount} tasks closed, missionClosed=${result.missionClosed}.`,
			);
			resolved++;
		}

		console.log(
			`[AutoResolver] Done. Resolved: ${resolved}, skipped (PR linked): ${skipped}.`,
		);
		return null;
	},
});
