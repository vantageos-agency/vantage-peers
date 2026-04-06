import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const http = httpRouter();

http.route({
	path: "/github/webhook",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		// Always read body as text first (can only consume once)
		const body = await request.text();

		// 1. Validate webhook signature (REQUIRED — reject if no secret configured)
		const secret = process.env.GITHUB_WEBHOOK_SECRET;
		if (!secret) {
			console.error("GITHUB_WEBHOOK_SECRET not configured — rejecting webhook");
			return new Response("Webhook secret not configured", { status: 500 });
		}
		const signature = request.headers.get("x-hub-signature-256");
		if (!signature) {
			return new Response("Missing signature header", { status: 401 });
		}
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
		const expected =
			"sha256=" +
			Array.from(new Uint8Array(sig))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		if (signature !== expected) {
			return new Response("Invalid signature", { status: 401 });
		}

		// 2. Parse payload
		let payload: any;
		try {
			payload = JSON.parse(body);
		} catch {
			return new Response("Invalid JSON", { status: 400 });
		}

		// 3. Get event type
		const eventType = request.headers.get("x-github-event");
		const action = payload.action;

		// 4. Get repo mapping
		const repoFullName = payload.repository?.full_name;
		if (!repoFullName) {
			return new Response("OK - no repo", { status: 200 });
		}

		const mapping = await ctx.runQuery(api.githubRepoMapping.getByRepo, {
			repo: repoFullName,
		});
		if (!mapping || !mapping.active) {
			return new Response("OK - unmapped repo", { status: 200 });
		}

		const { orchestrator, project } = mapping;

		// 5. Handle events

		// Helper: extract issue fields for upsert
		const extractIssueFields = (issue: any, status: "open" | "closed") => ({
			repo: repoFullName,
			issueNumber: issue.number as number,
			title: issue.title as string,
			body: (issue.body || "") as string,
			htmlUrl: issue.html_url as string,
			labels: (issue.labels || []).map((l: any) => l.name as string),
			status,
			githubCreatedAt: new Date(issue.created_at).getTime(),
			githubUpdatedAt: new Date(issue.updated_at).getTime(),
		});

		// --- New issue opened ---
		if (eventType === "issues" && action === "opened") {
			const issue = payload.issue;

			// Upsert issue BEFORE creating task
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, "open"));

			const isUrgent = issue.labels?.some(
				(l: any) =>
					l.name.toLowerCase().includes("urgent") ||
					l.name.toLowerCase().includes("p0"),
			);
			await ctx.runMutation(api.tasks.create, {
				title: `[GitHub #${issue.number}] ${issue.title}`,
				description: `${issue.body || "No description"}\n\nURL: ${issue.html_url}`,
				assignedTo: orchestrator as any,
				project,
				priority: isUrgent ? "urgent" : "high",
				status: "todo",
				createdBy: "system",
				tags: ["github", "issue"],
			});
			await ctx.runMutation(api.messages.sendMessage, {
				from: "system",
				channel: orchestrator,
				content: `[GitHub] New issue #${issue.number}: ${issue.title} — ${issue.html_url}`,
			});

			// Post acknowledgment comment on GitHub
			const githubToken = process.env.GITHUB_TOKEN;
			if (githubToken) {
				const [owner, repo] = repoFullName.split("/");
				await fetch(
					`https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}/comments`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${githubToken}`,
							"Content-Type": "application/json",
							Accept: "application/vnd.github.v3+json",
						},
						body: JSON.stringify({
							body: `🔍 @${issue.user.login} **Investigating** — assigned to \`${orchestrator}\` (AI orchestrator). Mission created with resolution protocol.\n\nOrchestrator: ${orchestrator.charAt(0).toUpperCase() + orchestrator.slice(1)} — VantageOS Team | ${new Date().toISOString().split("T")[0]}`,
						}),
					},
				);
			}

			// Create mission + 12 tasks from issue-resolution-v2 template
			const template = await ctx.runQuery(api.missionTemplates.getByName, {
				name: "issue-resolution-v3",
			});
			if (template !== null) {
				const missionId: Id<"missions"> = await ctx.runMutation(
					api.missions.create,
					{
						name: `Fix #${issue.number} — ${issue.title}`,
						project,
						pilot: orchestrator as any,
						priority: isUrgent ? "urgent" : "high",
						createdBy: "system",
						agents: [orchestrator],
						status: "execute",
					},
				);

				for (let i = 0; i < template.steps.length; i++) {
					const step = template.steps[i];
					await ctx.runMutation(api.tasks.create, {
						title: `[#${issue.number}] T${i + 1} — ${step.title}`,
						description: `${step.description}\n\nIssue: ${issue.html_url}\n\nIssue author: @${issue.user.login}`,
						assignedTo: orchestrator as any,
						project,
						priority: isUrgent ? "urgent" : "high",
						// T1 (Acknowledge) is already done — the comment was posted above
						status: i === 0 ? "done" : "todo",
						createdBy: "system",
						missionId,
						tags: [...(step.tags ?? []), "github", "irp"],
					});
				}
			}
		}

		// --- Issue edited ---
		if (eventType === "issues" && action === "edited") {
			const issue = payload.issue;
			const status = issue.state === "closed" ? "closed" : "open";
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, status as "open" | "closed"));
		}

		// --- Issue labeled ---
		if (eventType === "issues" && action === "labeled") {
			const issue = payload.issue;
			const label = payload.label;
			const status = issue.state === "closed" ? "closed" : "open";
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, status as "open" | "closed"));

			// Existing behavior: notify on urgent/p0 labels
			if (
				label?.name?.toLowerCase().includes("urgent") ||
				label?.name?.toLowerCase().includes("p0")
			) {
				await ctx.runMutation(api.messages.sendMessage, {
					from: "system",
					channel: orchestrator,
					content: `[GitHub] Issue #${issue.number} labeled ${label.name}: ${issue.title} — ${issue.html_url}`,
				});
			}
		}

		// --- Issue closed ---
		if (eventType === "issues" && action === "closed") {
			const issue = payload.issue;
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, "closed"));
		}

		// --- Issue reopened ---
		if (eventType === "issues" && action === "reopened") {
			const issue = payload.issue;
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, "open"));
		}

		// --- Issue comment created ---
		if (eventType === "issue_comment" && action === "created") {
			const comment = payload.comment;
			const issue = payload.issue;

			// Update githubUpdatedAt on the issue
			const status = issue.state === "closed" ? "closed" : "open";
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, status as "open" | "closed"));

			// Ignore our own bot comments (prevent loops)
			const isOwnBot =
				comment.user?.login === "elpiarthera" ||
				comment.user?.type === "Bot" ||
				comment.body?.includes("VantageOS Team");
			if (isOwnBot) {
				return new Response("OK - own bot comment", { status: 200 });
			}

			// Notify orchestrator of every external comment
			await ctx.runMutation(api.messages.sendMessage, {
				from: "system",
				channel: orchestrator,
				content: `[GitHub] New comment on #${issue.number} by ${comment.user.login}: ${(comment.body || "").slice(0, 200)}${(comment.body || "").length > 200 ? "..." : ""} — ${comment.html_url}`,
			});

			// Create mention task if @elpiarthera mentioned
			if (comment.body?.includes("@elpiarthera")) {
				await ctx.runMutation(api.tasks.create, {
					title: `[GitHub #${issue.number}] Mentioned: ${issue.title}`,
					description: `Comment by ${comment.user.login}: ${comment.body}\n\nURL: ${comment.html_url}`,
					assignedTo: orchestrator as any,
					project,
					priority: "high",
					status: "todo",
					createdBy: "system",
					tags: ["github", "mention"],
				});
			}

			// Create IRP mission if none exists for this issue
			const template = await ctx.runQuery(api.missionTemplates.getByName, {
				name: "issue-resolution-v3",
			});
			if (template !== null) {
				// Check if mission already exists by searching for matching name pattern
				const existingMissions = await ctx.runQuery(api.missions.list, {
					project,
					limit: 100,
				});
				const missionExists = existingMissions.some(
					(m: any) => m.name?.includes(`#${issue.number}`)
				);

				if (!missionExists && issue.state !== "closed") {
					const missionId: Id<"missions"> = await ctx.runMutation(
						api.missions.create,
						{
							name: `Fix #${issue.number} — ${issue.title}`,
							project,
							pilot: orchestrator as any,
							priority: "high",
							createdBy: "system",
							agents: [orchestrator],
							status: "execute",
						},
					);

					for (let i = 0; i < template.steps.length; i++) {
						const step = template.steps[i];
						await ctx.runMutation(api.tasks.create, {
							title: `[#${issue.number}] T${i + 1} — ${step.title}`,
							description: `${step.description}\n\nIssue: ${issue.html_url}\n\nIssue author: @${issue.user?.login || "unknown"}`,
							assignedTo: orchestrator as any,
							project,
							priority: "high",
							status: i === 0 ? "done" : "todo",
							createdBy: "system",
							missionId,
							tags: [...(step.tags ?? []), "github", "irp"],
						});
					}

					await ctx.runMutation(api.messages.sendMessage, {
						from: "system",
						channel: orchestrator,
						content: `[GitHub] IRP mission created for #${issue.number} (triggered by new comment). ${template.steps.length} tasks assigned.`,
					});
				}
			}
		}

		// --- Issue assigned to elpiarthera ---
		if (eventType === "issues" && action === "assigned") {
			const issue = payload.issue;
			const assignee = payload.assignee;
			if (assignee?.login === "elpiarthera") {
				await ctx.runMutation(api.tasks.create, {
					title: `[GitHub #${issue.number}] Assigned: ${issue.title}`,
					description: `Assigned to elpiarthera\n\nURL: ${issue.html_url}`,
					assignedTo: orchestrator as any,
					project,
					priority: "high",
					status: "todo",
					createdBy: "system",
					tags: ["github", "assigned"],
				});
				await ctx.runMutation(api.messages.sendMessage, {
					from: "system",
					channel: orchestrator,
					content: `[GitHub] Assigned to you: #${issue.number} ${issue.title} — ${issue.html_url}`,
				});
			}
		}

		// --- Pull request opened or updated → review task for Eta ---
		if (eventType === "pull_request" && (action === "opened" || action === "synchronize")) {
			const pr = payload.pull_request;

			// Ignore PRs by our own bots
			if (pr?.user?.login === "elpiarthera" && pr?.head?.ref?.startsWith("eta/")) {
				return new Response("OK - own bot PR", { status: 200 });
			}

			const actionLabel = action === "opened" ? "New PR" : "PR updated";

			// Create review task for Eta
			await ctx.runMutation(api.tasks.create, {
				title: `[Review] ${repoFullName} PR #${pr.number}: ${pr.title}`,
				description: `${actionLabel} by ${pr.user?.login ?? "unknown"}.\n\nBranch: ${pr.head?.ref}\nDiff: ${pr.html_url}/files\nURL: ${pr.html_url}\n\nReview required: check for bugs, conventions, test coverage, security.`,
				assignedTo: "eta" as any,
				project,
				priority: "high",
				status: "todo",
				createdBy: "system",
				tags: ["github", "pr-review", action],
			});

			// Notify Eta
			await ctx.runMutation(api.messages.sendMessage, {
				from: "system",
				channel: "eta",
				content: `[GitHub] ${actionLabel}: ${repoFullName} PR #${pr.number} by ${pr.user?.login ?? "unknown"}: ${pr.title} — ${pr.html_url}`,
			});
		}

		// --- Pull request merged ---
		if (eventType === "pull_request" && action === "closed") {
			const pr = payload.pull_request;
			if (pr?.merged) {
				// Notify orchestrator
				await ctx.runMutation(api.messages.sendMessage, {
					from: "system",
					channel: orchestrator,
					content: `[GitHub] PR #${pr.number} MERGED on ${repoFullName}: ${pr.title}. Deploy to prod now: npx convex deploy --yes`,
				});

				// Create deploy task
				await ctx.runMutation(api.tasks.create, {
					title: `[Deploy] PR #${pr.number} merged — deploy ${project} to prod`,
					description: `PR #${pr.number} "${pr.title}" was merged by ${pr.merged_by?.login ?? "unknown"}.\n\nAction required: deploy to production.\n\n\`\`\`bash\ngit checkout main && git pull && npx convex deploy --yes\n\`\`\`\n\nURL: ${pr.html_url}`,
					assignedTo: orchestrator as any,
					project,
					priority: "urgent",
					status: "todo",
					createdBy: "system",
					tags: ["github", "deploy", "pr-merged"],
				});
			}
		}

		return new Response("OK", { status: 200 });
	}),
});

export default http;
