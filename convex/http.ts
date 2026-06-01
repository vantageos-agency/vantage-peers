import { httpRouter } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";

// The orchestrator field in githubRepoMapping is stored as plain string.
// We cast it to the union type expected by missions/tasks at runtime —
// validation errors will surface as 500s from the try/catch blocks below.
type CreatorLiteral =
	| "pi"
	| "tau"
	| "phi"
	| "sigma"
	| "omega"
	| "zeta"
	| "eta"
	| "system";

type AssigneeLiteral =
	| "pi"
	| "tau"
	| "phi"
	| "sigma"
	| "omega"
	| "zeta"
	| "eta"
	| "laurent";

const http = httpRouter();

http.route({
	path: "/github/webhook",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		// Always read body as text first (can only consume once)
		const body = await request.text();

		// 1. Validate signature if secret is configured
		// NOTE: process.env may not be available in httpAction (Convex runtime)
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
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(body) as Record<string, unknown>;
		} catch {
			return new Response("Invalid JSON", { status: 400 });
		}

		// 3. Get event type
		const eventType = request.headers.get("x-github-event");
		const action = payload.action;

		// 4. Get repo mapping
		const repoFullName = (payload.repository as Record<string, unknown> | undefined)?.full_name as string | undefined;
		console.log("Webhook repo:", JSON.stringify(repoFullName), "eventType:", eventType, "action:", action);
		if (!repoFullName) {
			return new Response("OK - no repo", { status: 200 });
		}

		const mapping = await ctx.runQuery(api.githubRepoMapping.getByRepo, {
			repo: repoFullName,
		});
		console.log("Mapping result:", JSON.stringify(mapping));
		if (!mapping || !mapping.active) {
			return new Response("OK - unmapped repo", { status: 200 });
		}

		const orchestrator = mapping.orchestrator as CreatorLiteral;
		const orchestratorAssignee = mapping.orchestrator as AssigneeLiteral;
		const project = mapping.project;

		// 5. Handle events

		// Helper: extract issue fields for upsert
		const extractIssueFields = (issue: Record<string, unknown>, status: "open" | "closed") => ({
			repo: repoFullName,
			issueNumber: issue.number as number,
			title: issue.title as string,
			body: (issue.body as string | null || "") as string,
			htmlUrl: issue.html_url as string,
			labels: ((issue.labels as Array<Record<string, unknown>>) || []).map((l) => l.name as string),
			status,
			githubCreatedAt: new Date(issue.created_at as string).getTime(),
			githubUpdatedAt: new Date(issue.updated_at as string).getTime(),
		});

		// --- New issue opened ---
		if (eventType === "issues" && action === "opened") {
			const issue = payload.issue as Record<string, unknown>;

			// 1. Upsert issue record
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, "open"));

			// 2. Determine priority from labels
			const isUrgent = (issue.labels as Array<Record<string, unknown>>)?.some(
				(l) =>
					(l.name as string).toLowerCase().includes("urgent") ||
					(l.name as string).toLowerCase().includes("p0"),
			);
			const priority = isUrgent ? ("urgent" as const) : ("high" as const);

			// 3. Load default mission template
			const template = await ctx.runQuery(api.missionTemplates.getByName, {
				name: "issue-resolution-v3",
			});

			// 4. Guard: no template or empty steps — notify and exit
			if (template === null || template.steps.length === 0) {
				await ctx.runMutation(api.messages.sendMessage, {
					from: "system",
					channel: orchestrator,
					content: `[GitHub] New issue #${issue.number as number}: ${issue.title as string} — template issue-resolution-v3 not found, no mission created. ${issue.html_url as string}`,
				});
				return new Response("OK - no template", { status: 200 });
			}

			// 5. Idempotency: skip if mission already exists for this issue
			const existingMissions = await ctx.runQuery(api.missions.list, {
				project,
				limit: 200,
			});
			const missionName = `Fix #${issue.number as number} — ${issue.title as string}`.slice(0, 100);
			const issuePattern = new RegExp(`#${issue.number as number}\\b`);
			const alreadyExists = existingMissions.some((m) =>
				m.name ? issuePattern.test(m.name) : false
			);
			if (alreadyExists) {
				return new Response("OK - mission exists", { status: 200 });
			}

			// 6. Create mission + tasks (must succeed before any notifications)
			let missionId: Id<"missions">;
			try {
				console.log(`Creating mission for issue #${issue.number as number}`);
				missionId = await ctx.runMutation(
					api.missions.create,
					{
						name: missionName,
						project,
						pilot: orchestrator,
						priority,
						createdBy: "system",
						agents: [mapping.orchestrator],
						status: "execute",
					},
				);
				console.log("Mission created:", missionId);

				// 7. Create tasks from template steps (T0-based numbering)
				for (let i = 0; i < template.steps.length; i++) {
					const step = template.steps[i];
					const isLastStep = i === template.steps.length - 1;
					const assignee: AssigneeLiteral = isLastStep ? "eta" : orchestratorAssignee;

					await ctx.runMutation(api.tasks.create, {
						title: `[#${issue.number as number}] T${i} — ${step.title}`,
						description: `${step.description}\n\nIssue: ${issue.html_url as string}\nIssue author: @${(issue.user as Record<string, unknown>).login as string}\nRepo: ${repoFullName}`,
						assignedTo: assignee,
						project,
						priority,
						status: "todo",
						createdBy: "system",
						missionId,
						tags: [...(step.tags ?? []), "github", "irp"],
					});
				}

				// 7b. If this issue was auto-created by the error monitor ([Auto] prefix),
				//     link the IRP mission back to the errorLog so the auto-resolver can
				//     cascade-close it when the error goes quiet.
				if ((issue.title as string).startsWith("[Auto]")) {
					await ctx.runMutation(
						internal.errorMonitor.linkIrpMissionByIssueNumber,
						{
							issueNumber: issue.number as number,
							githubRepo: repoFullName,
							missionId,
						},
					);
				}
			} catch (error) {
				console.error("Mission creation failed:", error);
				return new Response(
					`Mission creation failed: ${error instanceof Error ? error.message : String(error)}`,
					{ status: 500 },
				);
			}

			// 8. Post GitHub acknowledgment comment (T0) — AFTER mission is confirmed created
			const githubToken = process.env.GITHUB_TOKEN;
			if (githubToken) {
				const [owner, repo] = repoFullName.split("/");
				await fetch(
					`https://api.github.com/repos/${owner}/${repo}/issues/${issue.number as number}/comments`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${githubToken}`,
							"Content-Type": "application/json",
							Accept: "application/vnd.github.v3+json",
						},
						body: JSON.stringify({
							body: `Investigating — assigned to \`${orchestrator}\` (AI orchestrator). Mission created with resolution protocol.\n\nOrchestrator: ${orchestrator.charAt(0).toUpperCase() + orchestrator.slice(1)} — VantageOS Team | ${new Date().toISOString().split("T")[0]}`,
						}),
					},
				);
			}

			// 9. Notify orchestrator after mission is fully built
			await ctx.runMutation(api.messages.sendMessage, {
				from: "system",
				channel: orchestrator,
				content: `[GitHub] New issue #${issue.number as number}: ${issue.title as string}. Mission created with ${template.steps.length} IRP tasks (T0-T${template.steps.length - 1}). Last task assigned to Eta for review. ${issue.html_url as string}`,
			});
		}

		// --- Issue edited ---
		if (eventType === "issues" && action === "edited") {
			const issue = payload.issue as Record<string, unknown>;
			const status = issue.state === "closed" ? "closed" : "open";
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, status));
		}

		// --- Issue labeled ---
		if (eventType === "issues" && action === "labeled") {
			const issue = payload.issue as Record<string, unknown>;
			const label = payload.label as Record<string, unknown> | undefined;
			const status = issue.state === "closed" ? "closed" : "open";
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, status));

			// Existing behavior: notify on urgent/p0 labels
			if (
				(label?.name as string | undefined)?.toLowerCase().includes("urgent") ||
				(label?.name as string | undefined)?.toLowerCase().includes("p0")
			) {
				await ctx.runMutation(api.messages.sendMessage, {
					from: "system",
					channel: orchestrator,
					content: `[GitHub] Issue #${issue.number as number} labeled ${label?.name as string}: ${issue.title as string} — ${issue.html_url as string}`,
				});
			}
		}

		// --- Issue closed ---
		if (eventType === "issues" && action === "closed") {
			const issue = payload.issue as Record<string, unknown>;
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, "closed"));
		}

		// --- Issue reopened ---
		if (eventType === "issues" && action === "reopened") {
			const issue = payload.issue as Record<string, unknown>;
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, "open"));
		}

		// --- Issue comment created ---
		if (eventType === "issue_comment" && action === "created") {
			const comment = payload.comment as Record<string, unknown>;
			const issue = payload.issue as Record<string, unknown>;

			// Update githubUpdatedAt on the issue
			const status = issue.state === "closed" ? "closed" : "open";
			await ctx.runMutation(api.issues.upsertFromGitHub, extractIssueFields(issue, status));

			// Ignore our own bot comments (prevent loops)
			const isOwnBot =
				(comment.user as Record<string, unknown>)?.login === "elpiarthera" ||
				(comment.user as Record<string, unknown>)?.type === "Bot" ||
				(comment.body as string | undefined)?.includes("VantageOS Team");
			if (isOwnBot) {
				return new Response("OK - own bot comment", { status: 200 });
			}

			// Notify orchestrator of every external comment
			const commentBody = (comment.body as string) || "";
			await ctx.runMutation(api.messages.sendMessage, {
				from: "system",
				channel: orchestrator,
				content: `[GitHub] New comment on #${issue.number as number} by ${(comment.user as Record<string, unknown>).login as string}: ${commentBody.slice(0, 200)}${commentBody.length > 200 ? "..." : ""} — ${comment.html_url as string}`,
			});

			// Create mention task if @elpiarthera mentioned
			if (commentBody.includes("@elpiarthera")) {
				await ctx.runMutation(api.tasks.create, {
					title: `[GitHub #${issue.number as number}] Mentioned: ${issue.title as string}`,
					description: `Comment by ${(comment.user as Record<string, unknown>).login as string}: ${commentBody}\n\nURL: ${comment.html_url as string}`,
					assignedTo: orchestratorAssignee,
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
			if (template !== null && template.steps.length > 0) {
				// Check if mission already exists by searching for matching name pattern
				const existingMissions = await ctx.runQuery(api.missions.list, {
					project,
					limit: 100,
				});
				const commentIssuePattern = new RegExp(`#${issue.number as number}\\b`);
				const missionExists = existingMissions.some(
					(m) => m.name ? commentIssuePattern.test(m.name) : false
				);

				if (!missionExists && issue.state !== "closed") {
					try {
						console.log(`Creating mission for issue #${issue.number as number} (triggered by comment)`);
						const missionId: Id<"missions"> = await ctx.runMutation(
							api.missions.create,
							{
								name: `Fix #${issue.number as number} — ${issue.title as string}`,
								project,
								pilot: orchestrator,
								priority: "high",
								createdBy: "system",
								agents: [mapping.orchestrator],
								status: "execute",
							},
						);
						console.log("Mission created:", missionId);

						for (let i = 0; i < template.steps.length; i++) {
							const step = template.steps[i];
							const isLastStep = i === template.steps.length - 1;
							const stepAssignee: AssigneeLiteral = isLastStep ? "eta" : orchestratorAssignee;

							await ctx.runMutation(api.tasks.create, {
								title: `[#${issue.number as number}] T${i} — ${step.title}`,
								description: `${step.description}\n\nIssue: ${issue.html_url as string}\nIssue author: @${((issue.user as Record<string, unknown>)?.login as string) || "unknown"}\nRepo: ${repoFullName}`,
								assignedTo: stepAssignee,
								project,
								priority: "high",
								status: "todo",
								createdBy: "system",
								missionId,
								tags: [...(step.tags ?? []), "github", "irp"],
							});
						}

						await ctx.runMutation(api.messages.sendMessage, {
							from: "system",
							channel: orchestrator,
							content: `[GitHub] IRP mission created for #${issue.number as number} (triggered by new comment). ${template.steps.length} tasks assigned.`,
						});
					} catch (error) {
						console.error("Mission creation failed:", error);
						return new Response(
							`Mission creation failed: ${error instanceof Error ? error.message : String(error)}`,
							{ status: 500 },
						);
					}
				}
			}
		}

		// --- Issue assigned to elpiarthera ---
		if (eventType === "issues" && action === "assigned") {
			const issue = payload.issue as Record<string, unknown>;
			const assignee = payload.assignee as Record<string, unknown> | undefined;
			if (assignee?.login === "elpiarthera") {
				await ctx.runMutation(api.tasks.create, {
					title: `[GitHub #${issue.number as number}] Assigned: ${issue.title as string}`,
					description: `Assigned to elpiarthera\n\nURL: ${issue.html_url as string}`,
					assignedTo: orchestratorAssignee,
					project,
					priority: "high",
					status: "todo",
					createdBy: "system",
					tags: ["github", "assigned"],
				});
				await ctx.runMutation(api.messages.sendMessage, {
					from: "system",
					channel: orchestrator,
					content: `[GitHub] Assigned to you: #${issue.number as number} ${issue.title as string} — ${issue.html_url as string}`,
				});
			}
		}

		// --- Pull request opened or updated → review task for Eta ---
		if (eventType === "pull_request" && (action === "opened" || action === "synchronize")) {
			const pr = payload.pull_request as Record<string, unknown>;

			// Ignore PRs by our own bots
			if ((pr?.user as Record<string, unknown>)?.login === "elpiarthera" && (pr?.head as Record<string, unknown>)?.ref?.toString().startsWith("eta/")) {
				return new Response("OK - own bot PR", { status: 200 });
			}

			const actionLabel = action === "opened" ? "New PR" : "PR updated";

			// Create review task for Eta
			await ctx.runMutation(api.tasks.create, {
				title: `[Review] ${repoFullName} PR #${pr.number as number}: ${pr.title as string}`,
				description: `${actionLabel} by ${(pr.user as Record<string, unknown>)?.login as string ?? "unknown"}.\n\nBranch: ${(pr.head as Record<string, unknown>)?.ref as string}\nDiff: ${pr.html_url as string}/files\nURL: ${pr.html_url as string}\n\nReview required: check for bugs, conventions, test coverage, security.`,
				assignedTo: "eta",
				project,
				priority: "high",
				status: "todo",
				createdBy: "system",
				tags: ["github", "pr-review", action as string],
			});

			// Notify Eta
			await ctx.runMutation(api.messages.sendMessage, {
				from: "system",
				channel: "eta",
				content: `[GitHub] ${actionLabel}: ${repoFullName} PR #${pr.number as number} by ${(pr.user as Record<string, unknown>)?.login as string ?? "unknown"}: ${pr.title as string} — ${pr.html_url as string}`,
			});
		}

		// --- Pull request review submitted → notify pilot ---
		if (eventType === "pull_request_review" && action === "submitted") {
			const review = payload.review as Record<string, unknown>;
			const pr = payload.pull_request as Record<string, unknown>;
			const reviewState = (review.state as string || "").toUpperCase();
			const reviewer = (review.user as Record<string, unknown>)?.login as string ?? "unknown";

			// Don't notify for our own reviews
			if (reviewer === "elpiarthera") {
				return new Response("OK - own review", { status: 200 });
			}

			const reviewBody = (review.body as string || "").slice(0, 200);
			const bodySnippet = reviewBody ? ` — "${reviewBody}${(review.body as string || "").length > 200 ? "..." : ""}"` : "";

			await ctx.runMutation(api.messages.sendMessage, {
				from: "system",
				channel: orchestrator,
				content: `[GitHub] PR #${pr.number as number} review: ${reviewState} by ${reviewer}${bodySnippet}. ${pr.title as string} — ${pr.html_url as string}`,
			});
		}

		// --- Pull request merged ---
		if (eventType === "pull_request" && action === "closed") {
			const pr = payload.pull_request as Record<string, unknown>;
			if (pr?.merged) {
				// Notify orchestrator
				await ctx.runMutation(api.messages.sendMessage, {
					from: "system",
					channel: orchestrator,
					content: `[GitHub] PR #${pr.number as number} MERGED on ${repoFullName}: ${pr.title as string}. Deploy to prod now: npx convex deploy --yes`,
				});

				// Create deploy task — with dedup: closes older open deploy tasks for
				// the same project before inserting (Fix 1 + Fix 3, Day 88 A.6).
				await ctx.runMutation(internal.tasks.createDeployTaskWithDedup, {
					title: `[Deploy] PR #${pr.number as number} merged — deploy ${project} to prod`,
					description: `PR #${pr.number as number} "${pr.title as string}" was merged by ${(pr.merged_by as Record<string, unknown>)?.login as string ?? "unknown"}.\n\nAction required: deploy to production.\n\n\`\`\`bash\ngit checkout main && git pull && npx convex deploy --yes\n\`\`\`\n\nURL: ${pr.html_url as string}`,
					assignedTo: orchestratorAssignee,
					project,
					priority: "urgent",
					createdBy: "system",
					tags: ["github", "deploy", "pr-merged"],
				});
			}
		}

		return new Response("OK", { status: 200 });
	}),
});

// ── credentials:issueBearerFromClerk — VP Clerk JWT → Bearer exchange ────────
// POST /issueBearerFromClerk
// Called by the webapp /auth/extension-callback page (Clerk-protected).
// Verifies Clerk JWT, resolves/creates workspace, issues 7d Bearer token.
// Raw token returned once in response; SHA-256 hash stored in userBearerTokens.
http.route({
	path: "/issueBearerFromClerk",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const mod = await import("./credentials");
		return mod.handleIssueBearerFromClerk(ctx, request);
	}),
});

// OPTIONS preflight for /issueBearerFromClerk
http.route({
	path: "/issueBearerFromClerk",
	method: "OPTIONS",
	handler: httpAction(async (ctx, request) => {
		const mod = await import("./credentials");
		return mod.handleIssueBearerFromClerk(ctx, request);
	}),
});

// ── Gumroad webhook — VantagePeers self-host pack auto-delivery ───────────────
// POST /api/gumroad-webhook
// Gumroad sends application/x-www-form-urlencoded with X-Gumroad-Signature.
// Delegates to an internal action (Node runtime) for HMAC verification,
// license generation, and Resend email delivery.
http.route({
	path: "/api/gumroad-webhook",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const body = await request.text();
		const signature = request.headers.get("X-Gumroad-Signature");

		const result = await ctx.runAction(internal.gumroadWebhook.handleGumroadWebhook, {
			body,
			signature,
		});

		return new Response(result.payload, {
			status: result.status,
			headers: { "Content-Type": "application/json" },
		});
	}),
});

export default http;
