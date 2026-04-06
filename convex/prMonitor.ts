"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// PR Monitor — polls status of open PRs on external repos
// ─────────────────────────────────────────────────────────────────────────────

export const pollOpenPRs = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const token = process.env.GITHUB_TOKEN;
		if (!token) {
			console.warn("[PRMonitor] GITHUB_TOKEN not set — skipping");
			return null;
		}

		// Get all external issues with open PRs
		const issues = await ctx.runQuery(api.issues.listExternalOpen, {
			limit: 50,
		});

		const openPRs = issues.filter(
			(i) => i.prUrl && (i.prStatus === "open" || i.prStatus === "draft"),
		);

		if (openPRs.length === 0) {
			return null;
		}

		console.log(`[PRMonitor] Checking ${openPRs.length} open PRs`);

		for (const issue of openPRs) {
			if (!issue.prUrl || !issue.externalRepo) continue;

			// Extract PR number from URL (e.g., https://github.com/org/repo/pull/123)
			const prMatch = issue.prUrl.match(/\/pull\/(\d+)/);
			if (!prMatch) continue;
			const prNumber = prMatch[1];

			const [owner, repo] = issue.externalRepo.split("/");
			if (!owner || !repo) continue;

			try {
				const resp = await fetch(
					`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
					{
						headers: {
							Authorization: `Bearer ${token}`,
							Accept: "application/vnd.github.v3+json",
							"User-Agent": "vantagepeers-bot/1.0",
						},
					},
				);

				if (!resp.ok) {
					console.warn(
						`[PRMonitor] Failed to fetch PR ${owner}/${repo}#${prNumber}: ${resp.status}`,
					);
					continue;
				}

				const pr = (await resp.json()) as {
					state: string;
					merged: boolean;
					merged_at: string | null;
					closed_at: string | null;
				};

				let newStatus: "open" | "merged" | "closed" | null = null;

				if (pr.merged) {
					newStatus = "merged";
				} else if (pr.state === "closed") {
					newStatus = "closed";
				}

				if (newStatus && newStatus !== issue.prStatus) {
					// Update PR status
					await ctx.runMutation(api.issues.updatePrStatus, {
						repo: issue.repo,
						issueNumber: issue.issueNumber,
						prUrl: issue.prUrl!,
						prStatus: newStatus,
					});

					// Notify Pi
					await ctx.runMutation(api.messages.sendMessage, {
						from: "system",
						channel: "pi",
						content: `[PR Monitor] ${issue.externalRepo}#${prNumber} is now ${newStatus.toUpperCase()}. Issue: ${issue.title}. URL: ${issue.prUrl}`,
					});

					console.log(
						`[PRMonitor] ${issue.externalRepo}#${prNumber}: ${issue.prStatus} → ${newStatus}`,
					);
				}
			} catch (err) {
				console.warn(
					`[PRMonitor] Error checking ${owner}/${repo}#${prNumber}:`,
					err,
				);
			}
		}

		return null;
	},
});
