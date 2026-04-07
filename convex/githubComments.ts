"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// postComment — post a comment on a GitHub issue via the REST API
// Scheduled from mutations (which cannot use fetch directly in a meaningful way
// for fire-and-forget side effects).
// ─────────────────────────────────────────────────────────────────────────────

export const postComment = internalAction({
	args: {
		repo: v.string(), // "owner/repo"
		issueNumber: v.number(),
		body: v.string(),
	},
	returns: v.null(),
	handler: async (_ctx, args) => {
		const token = process.env.GITHUB_TOKEN;
		if (!token) {
			console.warn("GITHUB_TOKEN not set — skipping GitHub comment");
			return null;
		}

		const [owner, repo] = args.repo.split("/");
		if (!owner || !repo) {
			console.warn(`Invalid repo format "${args.repo}" — expected "owner/repo"`);
			return null;
		}

		const response = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/issues/${args.issueNumber}/comments`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "vantage-memory-bot/1.0",
				},
				body: JSON.stringify({ body: args.body }),
			},
		);

		if (!response.ok) {
			const text = await response.text();
			console.error(
				`GitHub comment failed: ${response.status} ${response.statusText} — ${text}`,
			);
		}

		return null;
	},
});
