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

		// 1. Validate signature if secret is configured
		const secret = process.env.GITHUB_WEBHOOK_SECRET;
		if (secret) {
			const signature = request.headers.get("x-hub-signature-256");
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
							body: `🔍 **Investigating** — assigned to \`${orchestrator}\` (AI orchestrator, VantageOS Team). Mission created with resolution protocol.\n\n— ${orchestrator} | ${new Date().toISOString()}`,
						}),
					},
				);
			}

			// Create mission + 12 tasks from issue-resolution-v2 template
			const template = await ctx.runQuery(api.missionTemplates.getByName, {
				name: "issue-resolution-v2",
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
						description: `${step.description}\n\nIssue: ${issue.html_url}`,
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

		// --- Issue comment with @elpiarthera mention ---
		if (eventType === "issue_comment" && action === "created") {
			const comment = payload.comment;
			const issue = payload.issue;

			// Update githubUpdatedAt on the issue
			const status = issue.state === "closed" ? "closed" : "open";
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, status as "open" | "closed"));

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
				await ctx.runMutation(api.messages.sendMessage, {
					from: "system",
					channel: orchestrator,
					content: `[GitHub] @elpiarthera mentioned in #${issue.number}: ${issue.title} — ${comment.html_url}`,
				});
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

		return new Response("OK", { status: 200 });
	}),
});

export default http;
