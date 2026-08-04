"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// Calculate stats from GitHub API (internal action — called by cron)
// ─────────────────────────────────────────────────────────────────────────────

function median(arr: number[]): number {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 !== 0
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

export const calculateStats = internalAction({
	args: {
		repo: v.string(),
		since: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const token = process.env.GITHUB_TOKEN;
		if (!token) {
			console.warn("[IssueStats] GITHUB_TOKEN not set — skipping");
			return null;
		}

		const [owner, repoName] = args.repo.split("/");
		if (!owner || !repoName) {
			console.warn(`[IssueStats] Invalid repo format: ${args.repo}`);
			return null;
		}

		const sinceDate =
			args.since ??
			new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

		let issues: Array<{
			number: number;
			title: string;
			created_at: string;
			closed_at: string | null;
			state: string;
			pull_request?: unknown;
			comments_url: string;
		}>;

		try {
			const issuesResp = await fetch(
				`https://api.github.com/repos/${owner}/${repoName}/issues?state=all&since=${sinceDate}&per_page=100&sort=created&direction=desc`,
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github.v3+json",
						"User-Agent": "vantagepeers-bot/1.0",
					},
				},
			);

			if (!issuesResp.ok) {
				console.error(
					`[IssueStats] Failed to fetch issues: ${issuesResp.status}`,
				);
				return null;
			}

			issues = (await issuesResp.json()) as typeof issues;
		} catch (err) {
			console.error(
				`[IssueStats] issues fetch failed for ${owner}/${repoName}: `,
				err,
			);
			return null;
		}

		const realIssues = issues.filter((i) => !i.pull_request);

		const timesToFirstResponse: number[] = [];
		const timesToFix: number[] = [];
		const details: Array<{
			number: number;
			title: string;
			timeToFirstResponse?: number;
			timeToFix?: number;
			status: string;
		}> = [];

		for (const issue of realIssues) {
			const createdAt = new Date(issue.created_at).getTime();
			let timeToFirstResponse: number | undefined;
			let timeToFix: number | undefined;

			try {
				const commentsResp = await fetch(
					`${issue.comments_url}?per_page=1&sort=created&direction=asc`,
					{
						headers: {
							Authorization: `Bearer ${token}`,
							Accept: "application/vnd.github.v3+json",
							"User-Agent": "vantagepeers-bot/1.0",
						},
					},
				);
				if (commentsResp.ok) {
					const comments = (await commentsResp.json()) as Array<{
						created_at: string;
					}>;
					if (comments.length > 0) {
						const firstCommentAt = new Date(
							comments[0].created_at,
						).getTime();
						timeToFirstResponse = Math.round(
							(firstCommentAt - createdAt) / 60000,
						);
						timesToFirstResponse.push(timeToFirstResponse);
					}
				}
			} catch {
				// Skip comment fetch errors
			}

			if (issue.closed_at) {
				const closedAt = new Date(issue.closed_at).getTime();
				timeToFix = Math.round((closedAt - createdAt) / 60000);
				timesToFix.push(timeToFix);
			}

			details.push({
				number: issue.number,
				title: issue.title.slice(0, 100),
				timeToFirstResponse,
				timeToFix,
				status: issue.state,
			});
		}

		const today = new Date().toISOString().split("T")[0];

		// Split before/after VantageOS Team (pivot: 2026-04-01)
		const PIVOT = new Date("2026-04-01T00:00:00Z").getTime();

		const beforeIssues = realIssues.filter(
			(i) => new Date(i.created_at).getTime() < PIVOT,
		);
		const afterIssues = realIssues.filter(
			(i) => new Date(i.created_at).getTime() >= PIVOT,
		);

		const beforeFixTimes = beforeIssues
			.filter((i) => i.closed_at)
			.map((i) =>
				Math.round(
					(new Date(i.closed_at!).getTime() -
						new Date(i.created_at).getTime()) /
						60000,
				),
			);
		const afterFixTimes = afterIssues
			.filter((i) => i.closed_at)
			.map((i) =>
				Math.round(
					(new Date(i.closed_at!).getTime() -
						new Date(i.created_at).getTime()) /
						60000,
				),
			);

		const beforeStats =
			beforeIssues.length > 0
				? {
						totalIssues: beforeIssues.length,
						resolvedIssues: beforeIssues.filter(
							(i) => i.state === "closed",
						).length,
						medianTimeToFix:
							beforeFixTimes.length > 0
								? Math.round(median(beforeFixTimes))
								: undefined,
						avgTimeToFix:
							beforeFixTimes.length > 0
								? Math.round(
										beforeFixTimes.reduce((a, b) => a + b, 0) /
											beforeFixTimes.length,
									)
								: undefined,
					}
				: undefined;

		const afterStats =
			afterIssues.length > 0
				? {
						totalIssues: afterIssues.length,
						resolvedIssues: afterIssues.filter(
							(i) => i.state === "closed",
						).length,
						medianTimeToFix:
							afterFixTimes.length > 0
								? Math.round(median(afterFixTimes))
								: undefined,
						avgTimeToFix:
							afterFixTimes.length > 0
								? Math.round(
										afterFixTimes.reduce((a, b) => a + b, 0) /
											afterFixTimes.length,
									)
								: undefined,
					}
				: undefined;

		await ctx.runMutation(internal.issueStatsQueries.upsertStats, {
			repo: args.repo,
			date: today,
			totalIssues: realIssues.length,
			resolvedIssues: realIssues.filter((i) => i.state === "closed")
				.length,
			medianTimeToFirstResponse:
				timesToFirstResponse.length > 0
					? Math.round(median(timesToFirstResponse))
					: undefined,
			medianTimeToFix:
				timesToFix.length > 0
					? Math.round(median(timesToFix))
					: undefined,
			fastestResolution:
				timesToFix.length > 0 ? Math.min(...timesToFix) : undefined,
			slowestResolution:
				timesToFix.length > 0 ? Math.max(...timesToFix) : undefined,
			avgTimeToFix:
				timesToFix.length > 0
					? Math.round(
							timesToFix.reduce((a, b) => a + b, 0) /
								timesToFix.length,
						)
					: undefined,
			beforeVantageOS: beforeStats,
			afterVantageOS: afterStats,
			issueDetails: details.slice(0, 50),
		});

		console.log(
			`[IssueStats] ${args.repo}: ${realIssues.length} issues (before: ${beforeIssues.length}, after: ${afterIssues.length}), median fix before=${beforeFixTimes.length > 0 ? Math.round(median(beforeFixTimes)) : "N/A"} min, after=${afterFixTimes.length > 0 ? Math.round(median(afterFixTimes)) : "N/A"} min`,
		);

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateAllRepos — cron entry point
// ─────────────────────────────────────────────────────────────────────────────

export const calculateAllRepos = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const mappings = (await ctx.runQuery(
			internal.issueStatsQueries.listActiveRepos,
			{},
		)) as Array<{ repo: string }>;

		for (const mapping of mappings) {
			await ctx.runAction(internal.issueStats.calculateStats, {
				repo: mapping.repo,
			});
		}

		return null;
	},
});
