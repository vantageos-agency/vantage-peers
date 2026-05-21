"use node";
// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorAutoResolver
// ─────────────────────────────────────────────────────────────────────────────
// Day 76 doctrine mechanism 3: "any automation that creates work must resolve it."
//
// Cron entry point: scans for stale auto-IRP missions and closes them.
// C1 D.2 cutover: cascade-close is now delegated to the agentProtocol Component
// via components.agentProtocol.missionsV1.closeWithCascade (atomic, idempotent).
// Host side retains: GitHub issue closure, errorLog.autoResolved marking.
//
// Resolution cascade per closed mission:
//   1. Cascade-close all open tasks + mission → Component closeWithCascade.
//   2. Close the GitHub issue with a standard auto-resolve comment.
//   3. Mark the errorLog row as autoResolved = true (host-table write).
//
// Legitimate path protection: if a linked PR exists on the GH issue, the
// mission is left open regardless of how long the error has been quiet.
//
// Linked: decisions/doctrine-evidence-bound-done-2026-05-20.md,
//         cascade #492–#502 post-mortem, c1-public-apis-design-2026-05-21.md §API3.
// ─────────────────────────────────────────────────────────────────────────────

import type { FunctionReference } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { AUTO_RESOLVE_QUIET_WINDOW_MS } from "./errorMonitor";

// ── C1 D.2: Component API reference for missionsV1.closeWithCascade ──────────
// Typed reference to the agentProtocol Component's closeWithCascade mutation.
// The generated api.d.ts does not yet include agentProtocol (requires
// `npx convex dev` post Phase-E deploy). Cast is intentional — runtime mount
// is correct in convex.config.ts.
type CloseWithCascadeArgs = {
	missionId: string;
	reason: string;
	callerOrchestrator: string;
	completionNote: string;
};
type CloseWithCascadeResult = {
	missionClosed: boolean;
	tasksClosed: string[];
	tasksSkipped: Array<{ taskId: string; status: string }>;
};

const agentProtocolComponents = components as unknown as {
	agentProtocol: {
		missionsV1: {
			closeWithCascade: FunctionReference<
				"mutation",
				"internal",
				CloseWithCascadeArgs,
				CloseWithCascadeResult
			>;
		};
	};
};

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
			{ quietWindowMs: AUTO_RESOLVE_QUIET_WINDOW_MS, limit: 50 },
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

			// C1 D.2: Cascade-close via Component API (atomic, idempotent)
			// completionNote satisfies Evidence-Bound Done doctrine (≥40 chars +
			// verifiable tokens: errorLog ID + keyword references).
			const completionNote =
				`Auto-resolved by errorMonitorAutoResolver: errorLog ${errorLog._id}, ` +
				`no recurrence in 24h, no linked PR. See issue #${errorLog.issueNumber ?? "n/a"}.`;

			const result = await ctx.runMutation(
				agentProtocolComponents.agentProtocol.missionsV1.closeWithCascade,
				{
					missionId: missionId as string,
					reason: "auto-resolved: false-positive IRP, no recurrence 24h",
					callerOrchestrator: "system:errorMonitor",
					completionNote,
				},
			);

			// Mark errorLog as auto-resolved (host-table write, not in Component)
			await ctx.runMutation(internal.errorMonitor.markAutoResolved, {
				errorLogId: errorLog._id,
			});

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
					`${result.tasksClosed.length} tasks closed, missionClosed=${result.missionClosed}.`,
			);
			resolved++;
		}

		console.log(
			`[AutoResolver] Done. Resolved: ${resolved}, skipped (PR linked): ${skipped}.`,
		);
		return null;
	},
});
