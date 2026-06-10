import { httpRouter } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { isKillSwitchActive } from "./errorMonitorKillSwitch";

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

			// D90 hardening — kill-switch guard at the webhook IRP-cascade layer.
			// Day 91 issue #632 fired despite AUTO_IRP_PAUSED=true because the
			// webhook handler created the 14-task cascade unconditionally once a
			// GH issue existed (even from manual `gh issue create` or external).
			// For [Auto]-prefixed issues (created by the auto-IRP bot itself),
			// honor the kill-switch and skip mission + cascade creation entirely.
			if (
				isKillSwitchActive() &&
				(issue.title as string).startsWith("[Auto]")
			) {
				console.log(
					`[webhook.issues.opened] Skipped IRP cascade for #${issue.number as number} — AUTO_IRP_PAUSED=true and title is [Auto]-prefixed.`,
				);
				return new Response("OK - kill-switch active", { status: 200 });
			}

			// 5. Idempotency: skip if mission already exists for this issue
			const existingMissions = await ctx.runQuery(api.missions.list, {
				project,
				limit: 200,
			});
			const missionName = `Fix #${issue.number as number} — ${issue.title as string}`.slice(0, 100);
			const issuePattern = new RegExp(`#${issue.number as number}\\b`);
			const cascadeTitlePrefix = `[#${issue.number as number}]`;
			const alreadyExists = existingMissions.some((m) =>
				m.name ? issuePattern.test(m.name) : false
			);
			if (alreadyExists) {
				return new Response("OK - mission exists", { status: 200 });
			}

			// 5b. Day 98 (k173yr5n1) Mechanism (b) — multi-issue collapse.
			// If any open Sigma-class task already references #N in its
			// description AND that task is NOT itself a cascade task (title
			// would start with `[#N]`), the issue is covered by an existing
			// bundled fix (e.g. Cat A k17e611z4 = "close issues #655, #644,
			// #643, #642"). Spawn a single [Bridge] task instead of the full
			// T0..T(N-1) cascade.
			const openTasksRaw = await ctx.runQuery(api.tasks.list, {
				status: ["todo", "in_progress", "review", "blocked"],
				assignedTo: orchestrator,
				limit: 200,
				fields: "full",
			});
			// fields="full" guarantees Doc<"tasks"> shape at runtime; the return
			// validator is omitted on api.tasks.list (see comment there) so we
			// narrow here.
			const openTasks = openTasksRaw as unknown as Doc<"tasks">[];
			const coveringTask = openTasks.find((t) => {
				if (!t.description) return false;
				if (!issuePattern.test(t.description)) return false;
				if (t.title.startsWith(cascadeTitlePrefix)) return false;
				return true;
			});
			if (coveringTask) {
				await ctx.runMutation(api.tasks.create, {
					title: `[Bridge #${issue.number as number}] covered by task ${coveringTask._id}`,
					description: `New GitHub issue #${issue.number as number} "${issue.title as string}" detected by webhook. Existing open task ${coveringTask._id} ("${coveringTask.title}") already references this issue in its scope — no T0..T(N-1) cascade spawned (Day 98 multi-issue collapse).\n\nWhen the covering task closes, manually verify this issue is resolved + close on GitHub. The auto-resolver (Mechanism c) will cascade-close this Bridge once the covering task is done AND the GH issue is closed.\n\nIssue: ${issue.html_url as string}\nIssue author: @${(issue.user as Record<string, unknown>).login as string}\nRepo: ${repoFullName}`,
					assignedTo: orchestratorAssignee,
					project,
					priority,
					status: "todo",
					createdBy: "system",
					tags: ["github", "irp", "bridge", "day-98-collapse"],
				});
				console.log(
					`[webhook.issues.opened] Day 98 multi-issue collapse — Bridge task for #${issue.number as number} covered by ${coveringTask._id}; cascade skipped.`,
				);
				return new Response("OK - bridged to existing task", { status: 200 });
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
					// Day 98 F4 — Mechanism (b) multi-issue collapse extended to
					// issue_comment.created. PR #703 + #704 Eta APPROVED comments
					// fired this branch and spawned 14-task cascades each. If
					// any open orchestrator task already references #N, spawn
					// one [Bridge] task instead of the full cascade.
					const commentCascadePrefix = `[#${issue.number as number}]`;
					const openCascadeTasks = (await ctx.runQuery(api.tasks.list, {
						status: ["todo", "in_progress", "review", "blocked"],
						assignedTo: orchestrator,
						limit: 200,
						fields: "full",
					})) as unknown as Doc<"tasks">[];
					const commentCoveringTask = openCascadeTasks.find((t) => {
						if (!t.description) return false;
						if (!commentIssuePattern.test(t.description)) return false;
						if (t.title.startsWith(commentCascadePrefix)) return false;
						return true;
					});
					if (commentCoveringTask) {
						await ctx.runMutation(api.tasks.create, {
							title: `[Bridge #${issue.number as number}] covered by task ${commentCoveringTask._id}`,
							description: `Comment-triggered IRP cascade for #${issue.number as number} "${issue.title as string}" suppressed by Day 98 F4 multi-issue collapse. Existing open task ${commentCoveringTask._id} ("${commentCoveringTask.title}") already references this issue.\n\nIssue: ${issue.html_url as string}\nRepo: ${repoFullName}`,
							assignedTo: orchestratorAssignee,
							project,
							priority: "medium",
							status: "todo",
							createdBy: "system",
							tags: ["github", "irp", "bridge", "day-98-collapse", "comment-trigger"],
						});
						console.log(
							`[webhook.issue_comment.created] Day 98 F4 multi-issue collapse — Bridge task for #${issue.number as number} covered by ${commentCoveringTask._id}; cascade skipped.`,
						);
						return new Response("OK - bridged to existing task", { status: 200 });
					}

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

				// Create deploy task (with Fix 1 pre-create dedup + Fix 3 supersede +
				// Day 98 k173yr5n1 Mechanism (a) bundled-deploy dedup by timestamp).
				const mergedAtIso = pr.merged_at as string | undefined;
				const prMergedAt =
					mergedAtIso && !Number.isNaN(Date.parse(mergedAtIso))
						? Date.parse(mergedAtIso)
						: undefined;
				await ctx.runMutation(internal.tasks.createDeployTaskWithDedup, {
					title: `[Deploy] PR #${pr.number as number} merged — deploy ${project} to prod`,
					description: `PR #${pr.number as number} "${pr.title as string}" was merged by ${(pr.merged_by as Record<string, unknown>)?.login as string ?? "unknown"}.\n\nAction required: deploy to production.\n\n\`\`\`bash\ngit checkout main && git pull && npx convex deploy --yes\n\`\`\`\n\nURL: ${pr.html_url as string}`,
					assignedTo: orchestratorAssignee,
					project,
					priority: "urgent",
					createdBy: "system",
					tags: ["github", "deploy", "pr-merged"],
					prMergedAt,
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

// ─────────────────────────────────────────────────────────────────────────────
// /api/eta/verify-publish-token — Feature D backend validation for hook v1.2.0
//
// POST body: {"taskId": "k...", "expectedSha": "<sha>"}
// Header:    Authorization: Bearer <BEARER_SECRET_MASTER>
//
// Hook enforce-eta-approval-before-npm-publish v1.2.0 calls this to verify
// an Eta APPROVED token before allowing npm publish. Curl-able from any
// orchestrator host (no CONVEX_DEPLOYMENT required — that's the point).
//
// Response 200 {valid: true, taskId, completedAt, noteExcerpt} when:
//   - master bearer valid (constant-time compare)
//   - task exists
//   - task.assignedTo === "eta"
//   - task.status === "done"
//   - task.completionNote contains expectedSha (case-insensitive substring)
//
// Response 200 {valid: false, reason: "<machine-readable>"} when any check fails.
//   reasons: bearer-invalid / invalid-body / missing-fields / task-not-found
//            / wrong-assignee / wrong-status / sha-not-in-note
//
// Response 401 when no Authorization header.
// Response 500 when BEARER_SECRET_MASTER env var is missing (server misconfig).
//
// Read-only + idempotent + leaks only the verification verdict + minimal
// audit metadata (completedAt, first 200 chars of note).
// ─────────────────────────────────────────────────────────────────────────────

async function timingSafeEqualHttp(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.length !== bBytes.length) {
		const dummy = new Uint8Array(aBytes.length);
		const aKey = await crypto.subtle.importKey(
			"raw",
			aBytes,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		await crypto.subtle.sign("HMAC", aKey, dummy);
		return false;
	}
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

http.route({
	path: "/api/eta/verify-publish-token",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const authHeader = request.headers.get("Authorization") ?? "";
		const presented = authHeader.replace(/^Bearer\s+/i, "").trim();
		if (!presented) {
			return new Response("missing-bearer", { status: 401 });
		}
		const masterSecret = process.env.BEARER_SECRET_MASTER ?? "";
		if (!masterSecret) {
			return new Response("server-misconfig", { status: 500 });
		}
		const valid = await timingSafeEqualHttp(presented, masterSecret);
		if (!valid) {
			return Response.json({ valid: false, reason: "bearer-invalid" });
		}

		let body: { taskId?: string; expectedSha?: string };
		try {
			body = await request.json();
		} catch {
			return Response.json({ valid: false, reason: "invalid-body" });
		}
		const { taskId, expectedSha } = body;
		if (!taskId || !expectedSha) {
			return Response.json({ valid: false, reason: "missing-fields" });
		}

		const task = await ctx.runQuery(api.tasks.getById, {
			taskId: taskId as Id<"tasks">,
		});
		if (!task) {
			return Response.json({ valid: false, reason: "task-not-found" });
		}
		if (task.assignedTo !== "eta") {
			return Response.json({
				valid: false,
				reason: "wrong-assignee",
				got: task.assignedTo,
			});
		}
		if (task.status !== "done") {
			return Response.json({
				valid: false,
				reason: "wrong-status",
				got: task.status,
			});
		}
		const note = task.completionNote ?? "";
		if (!note.toLowerCase().includes(expectedSha.toLowerCase())) {
			return Response.json({
				valid: false,
				reason: "sha-not-in-note",
				hint: `expected SHA prefix '${expectedSha.slice(0, 12)}' not found in completionNote (first 200 chars: ${note.slice(0, 200)})`,
			});
		}
		return Response.json({
			valid: true,
			taskId,
			completedAt: task.completedAt ?? task.updatedAt,
			noteExcerpt: note.slice(0, 200),
		});
	}),
});

export default http;
