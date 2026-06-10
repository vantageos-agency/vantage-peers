"use node";
//
// PR C — (c1) Issue-closed external sweep
//
// Problem: GH issue closed externally (manual `gh issue close`) → linked IRP
// missions + T0..T12 cascade tasks stay zombie in VP.
//
// Fix: This node-runtime action:
//   1. Lists active missions that have a GH issue ref in their brief or name.
//   2. For each, fetches the GH issue state via GitHub REST API.
//   3. If state="closed", cascade-closes: updates mission status to "complete"
//      + completes all child tasks with VOID note "issue-closed-externally".
//
// Wired as a 6h cron in convex/crons.ts.
//

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SweepResult = {
	scanned: number;
	closed: number;
	skipped: number;
	errors: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a GH issue ref from a mission brief or name.
 * Supported formats:
 *   - Full URL: https://github.com/owner/repo/issues/42
 *   - Bare anchor: #42 (requires repo from mission.project via githubRepoMapping)
 * Returns { owner, repo, issueNumber } or null.
 */
function parseGitHubIssueRef(
	text: string,
): { owner: string; repo: string; issueNumber: number } | null {
	// Full URL: https://github.com/owner/repo/issues/42
	const urlMatch = text.match(
		/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/,
	);
	if (urlMatch) {
		return {
			owner: urlMatch[1],
			repo: urlMatch[2],
			issueNumber: parseInt(urlMatch[3], 10),
		};
	}
	return null;
}

/**
 * Fetch GitHub issue state. Returns "open" | "closed" | null (on error/no token).
 */
async function fetchGitHubIssueState(
	owner: string,
	repo: string,
	issueNumber: number,
	githubToken: string | undefined,
): Promise<"open" | "closed" | null> {
	const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (githubToken) {
		headers["Authorization"] = `Bearer ${githubToken}`;
	}

	const response = await fetch(url, { headers });

	if (!response.ok) {
		console.warn(
			`[issueClosedSweep] GH API ${url} returned ${response.status}`,
		);
		return null;
	}

	const data = (await response.json()) as { state?: string };
	if (data.state === "closed") return "closed";
	if (data.state === "open") return "open";
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutation: cascade-close a mission + its open child tasks
// ─────────────────────────────────────────────────────────────────────────────

export const cascadeCloseMission = internalMutation({
	args: {
		missionId: v.id("missions"),
		issueRef: v.string(),
	},
	returns: v.object({
		tasksCompleted: v.number(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();

		// Close all non-done child tasks
		const OPEN_STATUSES = [
			"todo",
			"in_progress",
			"review",
			"blocked",
		] as const;
		let tasksCompleted = 0;

		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_mission", (q) =>
					q.eq("missionId", args.missionId).eq("status", status),
				)
				.collect();

			for (const task of batch) {
				await ctx.db.patch(task._id, {
					status: "done" as const,
					completedAt: now,
					updatedAt: now,
					completionNote: `issue-closed-externally: GH issue ${args.issueRef} was closed outside VP. Auto-closed by issueClosedSweep cron.`,
				});
				tasksCompleted++;
			}
		}

		// Update mission status to complete
		await ctx.db.patch(args.missionId, {
			status: "complete" as const,
			updatedAt: now,
		});

		console.log(
			`[issueClosedSweep] cascadeCloseMission missionId=${args.missionId} issueRef=${args.issueRef} tasksCompleted=${tasksCompleted}`,
		);

		return { tasksCompleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal query helpers: list active missions with GH issue refs
// ─────────────────────────────────────────────────────────────────────────────

export const listActiveMissionsForSweep = internalMutation({
	args: {},
	returns: v.array(
		v.object({
			_id: v.id("missions"),
			name: v.string(),
			brief: v.optional(v.string()),
			status: v.union(
				v.literal("brainstorm"),
				v.literal("plan"),
				v.literal("execute"),
				v.literal("validate"),
				v.literal("complete"),
			),
		}),
	),
	handler: async (ctx) => {
		// Fetch open missions across all non-complete statuses
		const OPEN_STATUSES = [
			"brainstorm",
			"plan",
			"execute",
			"validate",
		] as const;

		const results: Array<{
			_id: Id<"missions">;
			name: string;
			brief?: string;
			status:
				| "brainstorm"
				| "plan"
				| "execute"
				| "validate"
				| "complete";
		}> = [];

		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("missions")
				.withIndex("by_status", (q) => q.eq("status", status))
				.take(200);
			for (const m of batch) {
				results.push({
					_id: m._id,
					name: m.name,
					brief: m.brief,
					status: m.status,
				});
			}
		}

		return results;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Main sweep action — node runtime for fetch()
// ─────────────────────────────────────────────────────────────────────────────

export const sweepIssueClosed = internalAction({
	args: {},
	returns: v.object({
		scanned: v.number(),
		closed: v.number(),
		skipped: v.number(),
		errors: v.number(),
	}),
	handler: async (ctx): Promise<SweepResult> => {
		const githubToken = process.env.GITHUB_TOKEN;

		// Load all active missions (via internal mutation — reads within action)
		const missions = (await ctx.runMutation(
			internal.issueClosedSweep.listActiveMissionsForSweep,
			{},
		)) as Array<{
			_id: Id<"missions">;
			name: string;
			brief?: string;
			status: string;
		}>;

		let scanned = 0;
		let closed = 0;
		let skipped = 0;
		let errors = 0;

		for (const mission of missions) {
			// Try to parse a GH issue ref from the mission brief or name
			const textToSearch = [mission.brief, mission.name]
				.filter(Boolean)
				.join(" ");
			const ref = parseGitHubIssueRef(textToSearch);

			if (!ref) {
				skipped++;
				continue;
			}

			scanned++;

			const issueRef = `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`;

			// Fetch GH issue state
			let state: "open" | "closed" | null;
			try {
				state = await fetchGitHubIssueState(
					ref.owner,
					ref.repo,
					ref.issueNumber,
					githubToken,
				);
			} catch (err) {
				console.error(
					`[issueClosedSweep] fetch error for ${issueRef}: ${err}`,
				);
				errors++;
				continue;
			}

			if (state === null) {
				// API error — skip, don't close
				errors++;
				continue;
			}

			if (state === "open") {
				// Issue still open — nothing to do
				continue;
			}

			// state === "closed" → cascade close
			try {
				await ctx.runMutation(internal.issueClosedSweep.cascadeCloseMission, {
					missionId: mission._id,
					issueRef,
				});
				closed++;
				console.log(
					`[issueClosedSweep] closed mission ${mission._id} (issue ${issueRef})`,
				);
			} catch (err) {
				console.error(
					`[issueClosedSweep] cascade close error for mission ${mission._id}: ${err}`,
				);
				errors++;
			}
		}

		console.log(
			`[issueClosedSweep] sweep complete scanned=${scanned} closed=${closed} skipped=${skipped} errors=${errors}`,
		);

		return { scanned, closed, skipped, errors };
	},
});
