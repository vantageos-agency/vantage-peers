import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators (reused across tables)
// ─────────────────────────────────────────────────────────────────────────────

export const memoryTypeValidator = v.union(
	v.literal("user"),
	v.literal("feedback"),
	v.literal("project"),
	v.literal("reference"),
	v.literal("episode"),
);

// Open validator — any orchestrator name is accepted.
// Known defaults: pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda,
// victor, proxima, theta, xi, epsilon, omicron, upsilon, system.
// New orchestrators can be added without schema changes (see issue #132).
export const creatorValidator = v.string();

// Day 130 follow-up #2 (Eta REVISE, PR #1089) — inforgeable automation
// signal. `createdBy` is a caller-supplied string on the PUBLIC
// `tasks.create` mutation, so it can be forged (e.g. `createdBy: "system"`)
// to escape the billing closure gate. `origin` is NOT accepted as an
// argument on any public mutation — only the internal webhook path
// (createOrUpdateReviewTask) writes it. The closure gate reads `origin`,
// never `createdBy`, to decide whether a task is automation-created.
export const taskOriginValidator = v.literal("automation");

export const relationTypeValidator = v.union(
	v.literal("updates"),
	v.literal("extends"),
	v.literal("derives"),
);

export const severityValidator = v.union(
	v.literal("critical"),
	v.literal("major"),
	v.literal("minor"),
);

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export default defineSchema({
	// ── memories ────────────────────────────────────────────────────────────────
	// Core memory store. Each row is one typed memory entry.
	// Supermemory pattern: updates/extends/derives relations + isLatest flag.
	// Mem0 pattern: typed memory (user/feedback/project/reference/episode).
	// Episodic type includes structured episode metadata.
	//
	// Embedding + search is handled by @convex-dev/rag (component-owned schema).
	// RAG entry key = memoryId string. Filters: namespace, type, isLatest.
	memories: defineTable({
		// Namespace: "global" | "orchestrator/pi" | "project/vantage-starter"
		namespace: v.string(),

		// Memory classification — drives retrieval strategy
		type: memoryTypeValidator,

		// Human-readable content (what the memory says)
		content: v.string(),

		// Which orchestrator (or system) created this memory
		createdBy: creatorValidator,
		instanceId: v.optional(v.string()), // which instance wrote this

		// Graph relations to other memories (Supermemory pattern)
		// "updates" supersedes target (sets target.isLatest = false)
		// "extends" adds detail to target (both remain latest)
		// "derives" is an inference drawn from target
		relations: v.array(
			v.object({
				targetId: v.id("memories"),
				type: relationTypeValidator,
			}),
		),

		// True = this is the current authoritative version.
		// False = superseded by a newer "updates" relation.
		// Search always filters isLatest=true by default.
		isLatest: v.boolean(),

		// Optional TTL hint (ISO string). Cron job handles actual expiry.
		// Example: "2026-06-01T00:00:00Z"
		ttl: v.optional(v.string()),

		// Episodic memory payload — only present when type="episode"
		episode: v.optional(
			v.object({
				context: v.string(), // Situation that triggered this episode
				goal: v.string(), // What was being attempted
				action: v.string(), // What was actually done
				outcome: v.string(), // What happened
				insight: v.string(), // The lesson extracted (procedural memory)
				severity: severityValidator,
			}),
		),

		// Timestamp (ms since epoch)
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// Primary query patterns — all filtered to isLatest for active memory reads
		.index("by_namespace", ["namespace", "isLatest"])
		.index("by_type", ["type", "isLatest"])
		.index("by_creator", ["createdBy", "isLatest"])
		.index("by_namespace_type", ["namespace", "type", "isLatest"]),

	// ── profiles ────────────────────────────────────────────────────────────────
	// One row per INSTANCE. orchestratorId = role (pi/tau/phi).
	// instanceId = unique running copy (pi-chromebook, pi-vps, tau-client-acme).
	// Multiple instances can share the same role.
	// static  = stable identity facts (role, workspace, capabilities)
	// dynamic = mutable session state (current task, last seen, session count)
	profiles: defineTable({
		// Role: "pi" | "tau" | "phi"
		orchestratorId: v.string(),

		// Unique instance identifier: "pi-chromebook" | "pi-vps" | "tau-vps-1"
		instanceId: v.optional(v.string()),

		name: v.string(),

		// Static profile — stable facts, infrequently updated
		static: v.object({
			role: v.string(),
			workspace: v.string(),
			capabilities: v.array(v.string()),
		}),

		// Dynamic profile — updated each session
		dynamic: v.object({
			currentTask: v.optional(v.string()),
			lastSeen: v.number(), // ms since epoch
			sessionCount: v.number(),
		}),
	})
		.index("by_orchestrator", ["orchestratorId"])
		.index("by_instance", ["instanceId"]),

	// ── messages ──────────────────────────────────────────────────────────────
	// Inter-orchestrator messaging. VantagePeers native (supersedes pre-VP legacy).
	// One message row per send. Recipients tracked via messageReceipts table.
	// channel: "broadcast" | "pi" | "tau" | "phi" | "pi,tau"
	messages: defineTable({
		from: creatorValidator,
		fromInstanceId: v.optional(v.string()), // "pi-chromebook", "tau-vps-1"
		tenantId: v.optional(v.string()),
		channel: v.string(),
		content: v.string(),
		sessionDay: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index("by_day", ["sessionDay"])
		.index("by_from", ["from", "createdAt"])
		.index("by_channel", ["channel", "createdAt"])
		.index("by_tenant_channel", ["tenantId", "channel", "createdAt"])
		// Day 103 — tenant-scoped listing for Clerk callers (task k176wgsrhha0fr0dxxahctvhw588q5a1).
		// by_tenant_created lets listMessages push tenantId BEFORE .take(limit) for
		// non-master callers, preventing under-fill when fleet (null-tenant) traffic
		// dominates the recent window. by_tenant_channel cannot be reused here because
		// channel is a required equality field in that compound (can't skip to createdAt).
		.index("by_tenant_created", ["tenantId", "createdAt"])
		// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r):
		// Convex native BM25 search on message body, with filterFields for the
		// common audit narrowing axes (from, channel, sessionDay).
		.searchIndex("search_content", {
			searchField: "content",
			filterFields: ["from", "channel", "sessionDay", "tenantId"],
		}),

	// ── messageReceipts ──────────────────────────────────────────────────────
	// One row per recipient per message. Tracks read status.
	// check_new_messages = query receipts where recipient=X AND readAt=undefined
	messageReceipts: defineTable({
		messageId: v.id("messages"),
		recipient: creatorValidator, // role-level: "pi" | "tau" | "phi"
		recipientInstanceId: v.optional(v.string()), // instance-level: "pi-vps"
		tenantId: v.optional(v.string()),
		readAt: v.optional(v.number()), // undefined = unread, ms epoch = read
	})
		.index("by_recipient_unread", ["recipient", "readAt"])
		.index("by_instance_unread", ["recipientInstanceId", "readAt"])
		.index("by_message", ["messageId"])
		.index("by_tenant_recipient_unread", ["tenantId", "recipient", "readAt"]),

	// ── missions ──────────────────────────────────────────────────────────────
	missions: defineTable({
		name: v.string(),
		description: v.optional(v.string()),
		project: v.string(),
		status: v.union(
			v.literal("brainstorm"),
			v.literal("plan"),
			v.literal("execute"),
			v.literal("validate"),
			v.literal("complete"),
		),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		pilot: creatorValidator,
		agents: v.array(v.string()),
		brief: v.optional(v.string()),
		startDate: v.optional(v.number()),
		targetDate: v.optional(v.number()),
		progress: v.optional(v.number()),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
		// Beta multi-tenant scope. null/undefined = master (internal Alpha).
		// Set to Clerk org slug (e.g. "acme-hr") for client-scoped rows.
		orgId: v.optional(v.string()),
	})
		.index("by_project", ["project", "status"])
		.index("by_pilot", ["pilot", "status"])
		.index("by_status", ["status", "createdAt"])
		.index("by_priority", ["priority", "status"])
		.index("by_orgId", ["orgId"]),

	// ── tasks ──────────────────────────────────────────────────────────────────
	tasks: defineTable({
		title: v.string(),
		description: v.optional(v.string()),
		project: v.optional(v.string()), // "vantage-starter", "perfect-ai-agent", etc.
		tags: v.optional(v.array(v.string())),
		// Orchestrator or person assigned — open string (issue #132)
		assignedTo: v.string(),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		status: v.union(
			v.literal("todo"),
			v.literal("in_progress"),
			v.literal("review"),
			v.literal("blocked"),
			v.literal("done"),
		),
		completionNote: v.optional(v.string()), // what was actually done — written on complete/review
		assignedToInstance: v.optional(v.string()), // instance-level assignment: "pi-vps", "tau-chromebook"
		claimedByInstance: v.optional(v.string()), // which instance is working on this
		dependsOn: v.optional(v.array(v.id("tasks"))), // tasks that must be done first
		missionId: v.optional(v.id("missions")),
		estimatedMinutes: v.optional(v.number()),
		actualMinutes: v.optional(v.number()),
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		dueDate: v.optional(v.number()),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
		// Beta multi-tenant scope. null/undefined = master (internal Alpha).
		// Set to Clerk org slug (e.g. "acme-hr") for client-scoped rows.
		orgId: v.optional(v.string()),
		// Day 130 follow-up #2 — inforgeable automation signal. ONLY the
		// internal webhook mutation (createOrUpdateReviewTask) writes this;
		// the public `tasks.create` mutation does not accept it as an arg.
		// The billing closure gate reads this field, never `createdBy`
		// (which is a caller-supplied, forgeable string on a public mutation).
		origin: v.optional(taskOriginValidator),
	})
		.index("by_assignee", ["assignedTo", "status"])
		.index("by_project", ["project", "status"])
		.index("by_priority", ["priority", "status"])
		.index("by_status", ["status", "createdAt"])
		.index("by_mission", ["missionId", "status"])
		.index("by_instance", ["assignedToInstance", "status"])
		.index("by_orgId", ["orgId"])
		// Compound indexes added to close the silent-filter-drop defect in
		// convex/tasks.ts `list`: when a caller supplies assignedTo/assignedToInstance
		// TOGETHER with project, the query must apply BOTH filters via a matching
		// index, never pick one and silently discard the other.
		.index("by_assignee_project", ["assignedTo", "project", "status"])
		.index("by_instance_project", ["assignedToInstance", "project", "status"])
		// billingSummaryByProject (convex/tasks.ts) — the period MUST bound the
		// query itself, not a post-hoc in-memory filter over a fixed-size scan
		// (Day-131 live-defect fix: recent, billable work was silently invisible
		// because the old handler capped the by_status(status, createdAt) scan
		// BEFORE ever comparing completedAt against the requested window).
		.index("by_status_completedAt", ["status", "completedAt"])
		// Same fix, pushed one level further: when the caller also supplies a
		// project filter, apply BOTH status+project+completedAt at the index
		// level so a single-project billing query is never a post-hoc filter
		// over a truncated cross-project scan (same disease, same fix).
		.index("by_status_project_completedAt", ["status", "project", "completedAt"])
		// Day-132 live-defect fix: `updatedSince` on `tasks.list` was filtered
		// IN-MEMORY after a fixed-size widened scan, so narrowing the window
		// never reduced the number of candidates fetched and the scan cap bit
		// into normal usage on exactly two branches (measured in production):
		// `assignedTo` alone, and `assignedTo` + `status`. These two compound
		// indexes end in `updatedAt` so the bound lives in the query itself —
		// no index added for missions/briefingNotes, whose branches were not
		// measured to exceed the cap.
		.index("by_assignee_updatedAt", ["assignedTo", "updatedAt"])
		.index("by_assignee_status_updatedAt", ["assignedTo", "status", "updatedAt"])
		// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r):
		// Convex native BM25 search on task title, with filterFields for the
		// common targeting axes (assignedTo, status, project, missionId).
		.searchIndex("search_title", {
			searchField: "title",
			filterFields: ["assignedTo", "status", "project", "missionId", "orgId"],
		}),

	// ── diary ──────────────────────────────────────────────────────────────────
	diary: defineTable({
		date: v.string(), // "2026-03-25" ISO date
		orchestrator: creatorValidator,
		instanceId: v.optional(v.string()), // which instance wrote this
		content: v.string(), // Full diary entry
		highlights: v.optional(v.array(v.string())),
		blockers: v.optional(v.array(v.string())),
		// v2.4.8: auth-derived author captured at write time from oauthCtx.userId.
		// Distinct from `orchestrator` (writer-intent label, client-supplied).
		// Pre-v2.4.8 entries are backfilled with orchestrator as best-guess via
		// migrations/diary_backfill_createdBy — NOT auth-verified.
		createdBy: v.optional(creatorValidator),
		createdAt: v.number(),
	})
		.index("by_orchestrator_date", ["orchestrator", "date"])
		.index("by_date", ["date"]),
	// by_createdBy_date intentionally omitted: createdBy filtering is handled
	// as a universal post-take in-memory filter (mirrors tasks.ts:371-373 pattern).
	// Adding an index pushdown optimization is deferred to a separate PR.

	// ── briefingNotes ──────────────────────────────────────────────────────────
	briefingNotes: defineTable({
		title: v.string(),
		topic: v.string(),
		participants: v.array(v.string()), // ["pi", "laurent", "tau"]
		content: v.string(), // Full briefing content
		decisions: v.optional(v.array(v.string())),
		linkedMemoryIds: v.optional(v.array(v.id("memories"))),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.optional(v.number()), // set on first update
		updatedBy: v.optional(creatorValidator), // orchestrator that last updated
		// Beta multi-tenant scope. null/undefined = master (internal Alpha).
		// Set to Clerk org slug (e.g. "acme-hr") for client-scoped rows.
		orgId: v.optional(v.string()),
	})
		.index("by_topic", ["topic"])
		.index("by_creator", ["createdBy", "createdAt"])
		.index("by_orgId", ["orgId"])
		// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r):
		// Convex native BM25 search on briefing body, with filterFields for the
		// common narrowing axes (topic, createdBy).
		.searchIndex("search_content", {
			searchField: "content",
			filterFields: ["topic", "createdBy", "orgId"],
		}),

	// ── components ──────────────────────────────────────────────────────────
	// Registry of agents, skills, hooks, plugins — backup + inventory.
	// Content stores the full file so nothing is lost if filesystem is destroyed.
	components: defineTable({
		name: v.string(),
		type: v.union(
			v.literal("agent"),
			v.literal("skill"),
			v.literal("hook"),
			v.literal("plugin"),
		),
		team: v.optional(v.string()), // e.g. "marketing", "development"
		content: v.string(), // full file content
		version: v.optional(v.string()),
		project: v.optional(v.string()),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_type", ["type"])
		.index("by_team", ["team", "type"])
		.index("by_name_type", ["name", "type"]),

	// ── mandates ──────────────────────────────────────────────────────────────
	// Cross-orchestrator service requests. One orchestrator requests a service from another.
	// Budget (token allocation) is agreed upfront; cost is recorded on settle.
	mandates: defineTable({
		requestedBy: creatorValidator, // who needs the service
		fulfilledBy: creatorValidator, // who will provide the service
		service: v.string(), // description of what is needed
		budget: v.number(), // token budget allocated
		status: v.union(
			v.literal("requested"),
			v.literal("accepted"),
			v.literal("in_progress"),
			v.literal("delivered"),
			v.literal("settled"),
		),
		linkedTaskIds: v.optional(v.array(v.id("tasks"))), // tasks created to fulfill this mandate
		tokensCost: v.optional(v.number()), // actual tokens consumed
		createdAt: v.number(),
		updatedAt: v.number(),
		completedAt: v.optional(v.number()),
		// AP2 authorization fields
		spendingLimits: v.optional(
			v.object({
				maxPerTransaction: v.number(),
				maxPerPeriod: v.number(),
				periodDays: v.optional(v.number()), // default 30
			}),
		),
		approvedCategories: v.optional(v.array(v.string())), // e.g. ["seo", "content", "development"]
		mandateDocument: v.optional(v.string()), // signed authorization text or reference
	})
		.index("by_requestedBy", ["requestedBy", "status"])
		.index("by_fulfilledBy", ["fulfilledBy", "status"])
		.index("by_status", ["status", "createdAt"]),

	// ── issues ────────────────────────────────────────────────────────────────
	// GitHub issues tracked in VantagePeers. Synced via webhook.
	issues: defineTable({
		repo: v.string(), // "myreeldream-ai/MyShortReel-beta"
		issueNumber: v.number(),
		title: v.string(),
		body: v.string(), // truncated to 2000 chars
		htmlUrl: v.string(),
		labels: v.array(v.string()),
		status: v.union(
			v.literal("open"),
			v.literal("in_progress"),
			v.literal("fixed"),
			v.literal("verified"),
			v.literal("closed"),
		),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		assignedOrchestrator: v.string(),
		project: v.string(),
		fixCommits: v.optional(v.array(v.string())),
		fixedBy: v.optional(v.string()),
		fixedAt: v.optional(v.number()),
		verifiedBy: v.optional(v.string()),
		verifiedAt: v.optional(v.number()),
		linkedTaskIds: v.optional(v.array(v.string())),
		githubCreatedAt: v.number(),
		githubUpdatedAt: v.number(),
		// External repo tracking (for Zeta contributions to third-party repos)
		externalRepo: v.optional(v.string()), // "get-convex/better-auth"
		externalIssueNumber: v.optional(v.number()),
		externalIssueUrl: v.optional(v.string()),
		prUrl: v.optional(v.string()),
		prStatus: v.optional(
			v.union(
				v.literal("draft"),
				v.literal("open"),
				v.literal("merged"),
				v.literal("closed"),
			),
		),
		forkRepo: v.optional(v.string()), // "elpiarthera/better-auth"
	})
		.index("by_repo_number", ["repo", "issueNumber"])
		.index("by_status", ["status"])
		.index("by_project", ["project"])
		.index("by_assigned", ["assignedOrchestrator", "status"])
		.index("by_external_repo", ["externalRepo", "prStatus"]),

	// ── githubRepoMapping ─────────────────────────────────────────────────────
	// Maps GitHub repos to orchestrators. Used by webhook handler to route events.
	//
	// Day 98 (k173yr5n1) — auto-IRP cascade overhaul Mechanism (a):
	//   lastDeployedSHA + lastDeployedAt track the most recent successful Convex
	//   deploy of the repo. createDeployTaskWithDedup compares pr.mergedAt vs
	//   lastDeployedAt — if a deploy completed AFTER the PR merged, the PR is
	//   already shipped via a bundled chain and no per-PR Deploy task is spawned.
	//   Recorded via githubRepoMapping.recordDeployment mutation after each
	//   successful `npx convex deploy --yes`.
	githubRepoMapping: defineTable({
		repo: v.string(), // "myreeldream-ai/MyShortReel-beta"
		orchestrator: v.string(), // "omega", "tau", "sigma", etc.
		project: v.string(), // "myreeldream", "vantage-starter", etc.
		active: v.boolean(),
		lastDeployedSHA: v.optional(v.string()), // Day 98 — most recent prod-deployed commit OID
		lastDeployedAt: v.optional(v.number()), // Day 98 — Unix ms timestamp of that deploy
	}).index("by_repo", ["repo"]),

	// ── businessUnits ─────────────────────────────────────────────────────────
	// One row per ElPi Corp business unit. Tracks strategy, structure, and KPIs.
	// managementFee: ElPi Corp takes this percentage of revenue (default 10%).
	businessUnits: defineTable({
		name: v.string(), // e.g. "VantagePeers", "VantageRegistry"
		description: v.string(),
		purpose: v.string(),
		domain: v.optional(v.string()), // e.g. "vantagepeers.com"
		orchestratorId: v.string(), // lead orchestrator — e.g. "sigma"
		status: v.union(
			v.literal("idea"),
			v.literal("building"),
			v.literal("live"),
			v.literal("revenue"),
		),
		businessModel: v.string(), // how it makes money
		targetCustomers: v.string(),
		services: v.array(v.string()), // what it offers
		pricing: v.string(),
		revenueProjections: v.object({
			y1: v.number(),
			y2: v.number(),
			y3: v.number(),
		}),
		coreTeam: v.object({
			agents: v.array(v.string()),
			skills: v.array(v.string()),
			hooks: v.array(v.string()),
			plugins: v.array(v.string()),
		}),
		coreProcesses: v.array(v.string()),
		dependencies: v.array(v.string()), // which BUs it consumes
		kpis: v.array(v.string()),
		managementFee: v.number(), // ElPi Corp % cut (default 10)
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_orchestrator", ["orchestratorId"])
		.index("by_status", ["status"])
		.index("by_name", ["name"]),

	// ── recurringTasks ────────────────────────────────────────────────────────
	// Templates for tasks that auto-create on a schedule (daily standup, weekly scan, etc.)
	// Convex cron checks every 15 min and creates tasks when nextRunAt <= now.
	recurringTasks: defineTable({
		title: v.string(),
		description: v.optional(v.string()),
		// Orchestrator or person assigned — open string (issue #132)
		assignedTo: v.string(),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		project: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		cronExpression: v.string(), // "0 9 * * *" = daily 9am, "0 9 * * 1" = Monday 9am
		lastCreatedAt: v.optional(v.number()),
		nextRunAt: v.number(),
		active: v.boolean(),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_active", ["active", "nextRunAt"])
		.index("by_assignee", ["assignedTo"]),

	// ── fixPatterns ──────────────────────────────────────────────────────────────
	// Knowledge base of fix patterns. Documents bugs, root causes, fix attempts
	// (including failures), and validated fixes. Agents search this BEFORE fixing
	// to avoid repeating mistakes. Semantic search via RAG on symptom + rootCause.
	fixPatterns: defineTable({
		symptom: v.string(), // What the bug looks like (searchable via RAG)
		rootCause: v.string(), // Why it happens
		validatedFix: v.optional(v.string()), // The fix that actually worked
		files: v.optional(v.array(v.string())), // Files involved
		tags: v.array(v.string()), // e.g. "react-hydration", "convex-subscription"
		stack: v.array(v.string()), // e.g. "next.js", "convex", "clerk"
		sourceProject: v.string(), // Origin project
		linkedIssueIds: v.optional(v.array(v.string())), // VantagePeers issue IDs
		createdBy: creatorValidator,
		severity: severityValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_project", ["sourceProject"])
		.index("by_severity", ["severity"])
		.index("by_creator", ["createdBy"]),

	// ── fixAttempts ──────────────────────────────────────────────────────────────
	// Individual fix attempts for a pattern. Separate table to avoid unbounded
	// array growth in fixPatterns documents (per Convex guidelines).
	fixAttempts: defineTable({
		patternId: v.id("fixPatterns"),
		description: v.string(), // What was tried
		commit: v.optional(v.string()), // Commit hash
		worked: v.boolean(), // Did it fix the issue?
		why: v.string(), // Why it worked or didn't
		createdBy: creatorValidator,
		createdAt: v.number(),
	})
		.index("by_pattern", ["patternId"])
		.index("by_worked", ["patternId", "worked"]),

	// ── missionTemplates ──────────────────────────────────────────────────────
	// Reusable mission templates. Each template contains an ordered list of
	// steps that get instantiated as tasks when a triggering event occurs.
	// The "issue-resolution-v2" template drives the IRP (Issue Resolution Protocol).
	missionTemplates: defineTable({
		name: v.string(),
		description: v.optional(v.string()),
		steps: v.array(
			v.object({
				title: v.string(),
				description: v.string(),
				tags: v.optional(v.array(v.string())),
				assignedTo: v.optional(v.string()), // orchestrator role, e.g. "proxima"
				assignedToInstance: v.optional(v.string()), // instance, e.g. "proxima-vps"
				dependsOn: v.optional(v.array(v.number())), // indexes of required steps (0-based)
			}),
		),
		isDefault: v.boolean(),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_name", ["name"])
		.index("by_default", ["isDefault"]),

	// ── monitoredDeployments ─────────────────────────────────────────────────
	// Registry of Convex deployments to poll for errors.
	// deployKeyEnvVar: name of the env var holding the admin deploy key.
	monitoredDeployments: defineTable({
		name: v.string(),
		deploymentUrl: v.string(),
		deployKeyEnvVar: v.string(),
		githubRepo: v.string(),
		orchestrator: v.string(),
		active: v.boolean(),
		lastCursor: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index("by_active", ["active"])
		.index("by_name", ["name"]),

	// ── issueStats ───────────────────────────────────────────────────────────
	// Daily issue resolution metrics per repo.
	issueStats: defineTable({
		repo: v.string(),
		date: v.string(), // YYYY-MM-DD
		totalIssues: v.number(),
		resolvedIssues: v.number(),
		medianTimeToFirstResponse: v.optional(v.number()), // minutes
		medianTimeToFix: v.optional(v.number()), // minutes
		fastestResolution: v.optional(v.number()), // minutes
		slowestResolution: v.optional(v.number()), // minutes
		avgTimeToFix: v.optional(v.number()), // minutes
		// Before/after VantageOS Team (pivot: 2026-04-01)
		beforeVantageOS: v.optional(
			v.object({
				totalIssues: v.number(),
				resolvedIssues: v.number(),
				medianTimeToFix: v.optional(v.number()),
				avgTimeToFix: v.optional(v.number()),
			}),
		),
		afterVantageOS: v.optional(
			v.object({
				totalIssues: v.number(),
				resolvedIssues: v.number(),
				medianTimeToFix: v.optional(v.number()),
				avgTimeToFix: v.optional(v.number()),
			}),
		),
		issueDetails: v.optional(
			v.array(
				v.object({
					number: v.number(),
					title: v.string(),
					timeToFirstResponse: v.optional(v.number()),
					timeToFix: v.optional(v.number()),
					status: v.string(),
				}),
			),
		),
		calculatedAt: v.number(),
	})
		.index("by_repo_date", ["repo", "date"])
		.index("by_date", ["date"]),

	// ── kbUploads ─────────────────────────────────────────────────────────────
	// TOFU (trust-on-first-use) storage ownership binding table.
	// Created by B5 M1 storageId org-binding defense-in-depth (mission k5779q).
	//
	// On first call to storeDocumentChunked for a given storageId, an entry is
	// inserted binding that storageId to the calling org. Subsequent calls with
	// the SAME storageId but a DIFFERENT orgId are rejected with
	// AUTH_STORAGE_NOT_OWNED to close the cross-tenant attack vector identified
	// by Eta iter-2 post-merge follow-up (PR #992, commit 16bb32d).
	//
	// Index: by_storageId — O(1) ownership lookup before ctx.storage.get().
	kbUploads: defineTable({
		storageId: v.id("_storage"),
		orgId: v.string(),
		createdAt: v.number(),
	}).index("by_storageId", ["storageId"]),

	// ── oauth_clients ─────────────────────────────────────────────────────────
	// OAuth 2.0 Dynamic Client Registration (RFC 7591).
	// One row per registered OAuth client (Claude.ai custom connector, Nadia,
	// future Perello VIP clients). Each client is bound to a scopeProfile that
	// limits the `from=` allowlist and namespace read/write prefixes.
	//
	// clientSecretHash = SHA-256 hex of the raw client secret (raw never stored).
	// Admin onboarding returns the raw secret exactly ONCE to the provisioner.
	oauth_clients: defineTable({
		clientId: v.string(), // public identifier (UUID)
		clientSecretHash: v.string(), // SHA-256 hex of raw secret
		redirectUris: v.array(v.string()),
		name: v.string(), // human label, e.g. "nadia-acme-hr"
		scopeProfile: v.string(), // FK to oauth_scope_profiles.profileId
		createdAt: v.number(),
		revokedAt: v.optional(v.number()),
		// RFC 7591 §2 token_endpoint_auth_method (D6 — confidential client validation).
		// Absent => treat as confidential ("client_secret_basic") for backward
		// compatibility; existing rows MUST be backfilled in S2 with explicit value
		// ("client_secret_basic" for confidential; "none" for known public clients).
		tokenEndpointAuthMethod: v.optional(v.string()),
	})
		.index("by_clientId", ["clientId"])
		.index("by_scopeProfile", ["scopeProfile"]),

	// ── oauth_authorization_codes ────────────────────────────────────────────
	// Short-lived authorization codes (RFC 6749 §4.1). TTL ~10 min.
	// Cleaned periodically by cron (processExpiredOauthCodes).
	oauth_authorization_codes: defineTable({
		code: v.string(), // opaque random value
		clientId: v.string(),
		redirectUri: v.string(),
		codeChallenge: v.string(), // PKCE S256 (RFC 7636)
		scope: v.string(),
		userId: v.string(), // who the code was issued for (== scopeProfile owner by default)
		expiresAt: v.number(),
	}).index("by_code", ["code"]),

	// ── oauth_access_tokens ──────────────────────────────────────────────────
	// Issued access tokens. tokenHash = SHA-256 hex of the raw token (raw never
	// stored). The HTTP bearer middleware hashes the incoming Authorization
	// header and looks the token up by hash, then enforces fromAllowList +
	// namespaceRead/Write prefixes on every MCP tool call.
	oauth_access_tokens: defineTable({
		tokenHash: v.string(),
		clientId: v.string(),
		userId: v.string(),
		scopes: v.array(v.string()), // OAuth scopes (vantage:read, vantage:write)
		scopeProfile: v.string(), // snapshot at issue time
		fromAllowList: v.array(v.string()),
		namespaceReadPrefixes: v.array(v.string()),
		namespaceWritePrefixes: v.array(v.string()),
		expiresAt: v.number(),
		refreshTokenHash: v.optional(v.string()),
		createdAt: v.number(),
		revokedAt: v.optional(v.number()),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_clientId", ["clientId"]),

	// ── oauth_refresh_tokens ─────────────────────────────────────────────────
	// Refresh tokens for renewing expired access tokens. Same hashing rules.
	oauth_refresh_tokens: defineTable({
		tokenHash: v.string(),
		clientId: v.string(),
		userId: v.string(),
		scopeProfile: v.string(),
		expiresAt: v.number(),
		createdAt: v.number(),
		revokedAt: v.optional(v.number()),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_clientId", ["clientId"]),

	// ── oauth_scope_profiles ─────────────────────────────────────────────────
	// Reusable scope templates. An OAuth client references a profile by
	// profileId; the access_token materialises the profile into the token row
	// so scope changes on the profile don't retroactively grant or revoke.
	//
	// Seeded on first deploy via oauth.seedDefaultProfiles: master, nadia-acme-hr,
	// client-generic (deny-by-default template).
	oauth_scope_profiles: defineTable({
		profileId: v.string(), // stable slug e.g. "nadia-acme-hr"
		description: v.string(),
		fromAllowList: v.array(v.string()),
		namespaceReadPrefixes: v.array(v.string()),
		namespaceWritePrefixes: v.array(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index("by_profileId", ["profileId"]),

	// ── mcpTenants ────────────────────────────────────────────────────────────
	// Registry of VIP tenants for HTTP MCP transport.
	// Each tenant has a hashed bearer token and a target Convex deployment URL.
	// The HTTP MCP server (Railway) looks up tenants by tokenHash on every request
	// and proxies to the correct Convex deployment.
	// tokenHash = SHA-256 hex of the raw bearer token (raw token never stored).
	mcpTenants: defineTable({
		tokenHash: v.string(), // SHA-256 hex of bearer token
		tenantName: v.string(), // e.g. "perello-consulting-vip-1"
		convexUrl: v.string(), // e.g. "https://xxxx.convex.cloud"
		createdAt: v.number(),
		enabledAt: v.optional(v.number()), // undefined = disabled
		lastUsedAt: v.optional(v.number()),
		revokedAt: v.optional(v.number()),
	}).index("by_tokenHash", ["tokenHash"]),

	// ── errorMonitorFilterRules ──────────────────────────────────────────────
	// Runtime-configurable filter rules for the auto-IRP bot.
	// Each rule matches (functionName, errorMessageRegex) and assigns a severity:
	//   "skip"          → drop silently, no upsert / issue
	//   "log-only"      → console.log only
	//   "create-issue"  → normal flow (used to override a default skip)
	//
	// Defaults are seeded by errorMonitorFilters.seedDefaultRules. Sigma/Pi
	// can add or disable rules without redeploying via addFilterRule /
	// disableFilterRule — internalMutation (admin-only, invoked with a deploy
	// key via `npx convex run`; converted from public to close a DoS-adjacent
	// suppression surface, see errorMonitorFilters.ts).
	//
	// Linked: memory j573cwcs3znp0xsvtg34x435jh84b0eg, pattern m978zeg4b2e9nx67z2hg5rwgfs85hf7f.
	errorMonitorFilterRules: defineTable({
		functionName: v.string(), // exact match, e.g. "tasks:complete"
		errorMessageRegex: v.string(), // RegExp source
		regexFlags: v.optional(v.string()), // e.g. "i"
		reason: v.string(), // human-readable why this is filtered
		severity: v.union(
			v.literal("skip"),
			v.literal("log-only"),
			v.literal("create-issue"),
		),
		active: v.boolean(),
		createdAt: v.number(),
		// v1.0.1 observability — added in PR follow-up to PR #354 review.
		// `lastMatchedAt` and `matchCount` are bumped from `pollDeploymentLogs`
		// via a fire-and-forget mutation when a rule's severity is "skip" or
		// "log-only" (the silenced classes), so operators can see which rules
		// are actually firing in prod and which are dead weight.
		lastMatchedAt: v.optional(v.number()), // Unix ms of last match
		matchCount: v.optional(v.number()), // running counter, treat undefined as 0
		// v1.0.1 precedence — higher `priority` = evaluated first. Stable sort
		// by `_creationTime` for ties. Treat undefined as 0 (unprioritized).
		priority: v.optional(v.number()),
	})
		.index("by_active", ["active"])
		.index("by_function", ["functionName", "active"]),

	// ── oauthClients ─────────────────────────────────────────────────────────
	// OAuth 2.1 Dynamic Client Registration (RFC 7591) clients.
	// Issued by the DCR /register endpoint without admin gating.
	// clientSecret = 64-char hex (raw value — returned once on registration,
	// stored here for PKCE / client_secret_post auth on the token endpoint).
	oauthClients: defineTable({
		clientId: v.string(), // crypto.randomUUID()
		clientSecret: v.string(), // 64-char hex (raw — transmitted once)
		clientName: v.string(),
		redirectUris: v.array(v.string()),
		createdAt: v.number(),
		scope: v.optional(v.string()), // default "mcp:full"
	}).index("by_clientId", ["clientId"]),

	// ── oauthTokens ──────────────────────────────────────────────────────────
	// Auth codes and access/refresh tokens for the DCR OAuth 2.1 flow.
	// A single row covers both the auth-code phase (authCode set, accessToken
	// absent) and the token phase (accessToken set, authCode consumed).
	// Index on authCode supports code exchange; index on accessToken supports
	// bearer validation; index on clientId supports revocation/listing.
	oauthTokens: defineTable({
		clientId: v.string(),
		accessToken: v.string(), // crypto.randomUUID()
		refreshToken: v.optional(v.string()),
		scope: v.string(),
		expiresAt: v.number(), // ms since epoch
		authCode: v.optional(v.string()), // PKCE authorization code
		codeChallenge: v.optional(v.string()),
		codeChallengeMethod: v.optional(v.string()),
		redirectUri: v.optional(v.string()),
		used: v.optional(v.boolean()), // auth code single-use flag
		createdAt: v.number(),
	})
		.index("by_accessToken", ["accessToken"])
		.index("by_authCode", ["authCode"])
		.index("by_clientId", ["clientId"])
		.index("by_refreshToken", ["refreshToken"]),

	// ── errorLogs ────────────────────────────────────────────────────────────
	// Deduplicated log of detected function errors across monitored deployments.
	// hash = simpleHash(functionName + ":" + errorMessage) for deduplication.
	//
	// Anti-flood additions (Day 76):
	//   issueCreated   — true once the GH issue + IRP mission have been created.
	//                    Prevents re-triggering if the errorLog is touched again.
	//   irpMissionId   — ID of the auto-IRP mission spawned for this error, so
	//                    the auto-resolver can cascade-close it.
	//   autoResolved   — true once the auto-resolver has closed the mission.
	//                    Prevents the resolver from double-processing.
	//   recurrenceThreshold — overrides the deployment-level default; the GH issue
	//                    is NOT created until count >= this value.
	errorLogs: defineTable({
		hash: v.string(),
		deployment: v.string(),
		functionName: v.string(),
		errorMessage: v.string(),
		stackTrace: v.optional(v.string()),
		firstSeen: v.number(),
		lastSeen: v.number(),
		count: v.number(),
		issueNumber: v.optional(v.number()),
		githubRepo: v.optional(v.string()),
		// Day 76 anti-flood fields
		issueCreated: v.optional(v.boolean()),
		irpMissionId: v.optional(v.id("missions")),
		autoResolved: v.optional(v.boolean()),
		recurrenceThreshold: v.optional(v.number()),
		// Day 128 fix (issue #1088 fabricated incident) — see
		// convex/errorMonitorRecurrence.ts. Records the `count` value at the
		// moment a 24h+ re-raise measurement window was armed. The RECURRING
		// escalation label is only emitted once NEW occurrences counted after
		// this baseline reach the effective threshold — never from group
		// identity + a stale timestamp alone.
		reRaiseBaselineCount: v.optional(v.number()),
	})
		.index("by_hash", ["hash"])
		.index("by_deployment", ["deployment"])
		.index("by_issue_created", ["issueCreated", "lastSeen"])
		.index("by_issue_number", ["issueNumber"]),

	// ── licenses ─────────────────────────────────────────────────────────────
	// Open-core license registry. Raw license keys are NEVER stored — only the
	// SHA-256 hex hash is persisted. The raw key is returned once on generate and
	// is the customer's responsibility to store safely.
	//
	// Lifecycle: generated → activated (optional, sets activatedAt) → active until
	// expiresAt, after which status moves to "expired" (handled by cron or on
	// validate). Revocation sets status="revoked" immediately.
	licenses: defineTable({
		keyHash: v.string(), // sha256 hex of the raw license key
		customerEmail: v.string(),
		customerName: v.optional(v.string()),
		productCode: v.string(), // e.g. "vantage-peers-self-host"
		tier: v.string(), // e.g. "open-core-99-eur-yr"
		purchasedAt: v.number(), // ms since epoch
		activatedAt: v.optional(v.number()), // ms since epoch, set on first activation
		expiresAt: v.number(), // purchasedAt + 365d (ms since epoch)
		gumroadOrderId: v.optional(v.string()),
		status: v.union(
			v.literal("active"),
			v.literal("trial"),
			v.literal("revoked"),
			v.literal("expired"),
		),
		githubRepos: v.optional(v.array(v.string())),
		purchaseLocale: v.optional(v.union(v.literal("en"), v.literal("fr"))),
		// Onboarding email delivery tracking (set by gumroadWebhook handler)
		emailSent: v.optional(v.boolean()),
		// Customer segmentation — set at purchase time or enriched later.
		// Unset = unknown / backwards-compat for rows created before W3.
		customerType: v.optional(
			v.union(
				v.literal("early-dev-voie-3"),
				v.literal("smb-voie-2"),
				v.literal("pro-voie-3"),
				v.literal("partner-reseller"),
				v.literal("standard"),
			),
		),
		// True if the customer has expressed interest in reselling VantagePeers.
		resellerCandidate: v.optional(v.boolean()),
	})
		.index("by_keyHash", ["keyHash"])
		.index("by_customerEmail", ["customerEmail"])
		.index("by_gumroadOrderId", ["gumroadOrderId"]),

	// ── iframeEmbedSessions ──────────────────────────────────────────────────
	// Session registry for VP Gen UI iframe embeds (SEP-1865 M3).
	// Each session is bound to an origin and carries optional tenantId + userId
	// for multi-tenant routing. Sessions expire via expiresAt; revoked flag
	// provides immediate invalidation without waiting for TTL.
	//
	// Mission : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
	iframeEmbedSessions: defineTable({
		sessionId: v.string(),
		tenantId: v.optional(v.string()),
		origin: v.string(),
		userId: v.optional(v.string()),
		createdAt: v.number(),
		lastSeenAt: v.number(),
		expiresAt: v.number(),
		revoked: v.boolean(),
	})
		.index("by_session_id", ["sessionId"])
		.index("by_origin_expires", ["origin", "expiresAt"]),

	// ── errorMonitorConfig ───────────────────────────────────────────────────
	// Singleton-ish dynamic configuration for the error-monitor subsystem.
	// Key-value store where `key` is a stable slug (e.g. "pendingAliasReleases")
	// and `value` is a string array.
	//
	// pendingAliasReleases — list of status aliases introduced in an in-flight
	// release that are not yet deployed to prod. The auto-IRP bot synthesises
	// ArgumentValidationError filter rules for each alias so that pre-deploy
	// smoke-test noise doesn't spawn GitHub issues. Remove aliases post-deploy.
	errorMonitorConfig: defineTable({
		key: v.string(), // e.g. "pendingAliasReleases"
		value: v.array(v.string()),
		updatedAt: v.number(),
	}).index("by_key", ["key"]),

	// ── taskClosureConfig ────────────────────────────────────────────────────
	// Day 130 (k17dhcmzqafve1ayzvh833kf558ae019) — server-side closure gate
	// config. Key-value store, mirrors errorMonitorConfig pattern.
	// Doctrine: no-hardcoded-business-knowledge — billable project list and
	// stale-in-progress threshold live here, never as a code constant.
	//
	// Known keys:
	//   "billableProjects"       — string[] of `task.project` values that
	//     require a machine-timestamped startedAt before closure (billing
	//     source = actualMinutes derived from startedAt→completedAt).
	//     Seeded with ["vantage-immo"] — add client projects here, not in code.
	//   "staleInProgressThresholdMs" — number encoded as a single-element
	//     string[] (["86400000"]) — age (ms) after which an in_progress task
	//     is surfaced as staleInProgress in check_messages. Default 24h.
	taskClosureConfig: defineTable({
		key: v.string(),
		value: v.array(v.string()),
		updatedAt: v.number(),
	}).index("by_key", ["key"]),

	// ── client_org_mapping ───────────────────────────────────────────────────
	// Dashboard Beta multi-tenant scope registry. One row per Clerk organisation
	// granted dashboard access. Provisioned manually by Pi / Laurent via Convex
	// dashboard or npx convex run after merge.
	//
	// clerkOrgSlug: the Clerk organisation slug (e.g. "acme-hr", "a-client-org").
	//   Maps to `identity.organizationId ?? identity.organizationSlug` in Convex
	//   auth helpers.
	// allowedOrchestrators: which orchestrator pilots/assignees this org can see.
	//   ["*"] = master sentinel = all orchestrators (Laurent / internal use).
	// scopes: permission tokens granted to this org.
	//   Known values: "view-own-tasks", "view-own-missions",
	//   "view-orchestrator-summary", "view-stats-aggregated", "cross-tenant-read".
	// isActive: false = org is disabled (returns Forbidden) without deleting the row.
	//
	// Seed rows (post-merge, Sigma runs npx convex run):
	//   acme-hr   → allowedOrchestrators=["victor"], scopes=["view-own-tasks","view-own-missions","view-orchestrator-summary"]
	//   <redacted-client> → allowedOrchestrators=["phi"],    scopes=["view-own-tasks","view-own-missions"]
	client_org_mapping: defineTable({
		clerkOrgSlug: v.string(), // "acme-hr"
		allowedOrchestrators: v.array(v.string()), // ["victor"] or ["*"] for master sentinel
		scopes: v.array(v.string()), // ["view-own-tasks", "view-own-missions", ...]
		displayName: v.string(), // "<redacted-client>"
		isActive: v.boolean(),
		createdAt: v.number(),
	})
		.index("by_clerk_slug", ["clerkOrgSlug"])
		.index("by_isActive", ["isActive"]),

	// ── userBearerTokens ─────────────────────────────────────────────────────
	// Bearer tokens issued to VP webapp users via Clerk JWT exchange
	// (POST /issueBearerFromClerk). Separate from the OAuth DCR flow in
	// oauth_access_tokens — these are user-grade tokens bound to a Clerk userId
	// rather than an OAuth client.
	//
	// tokenHash = SHA-256 hex of the raw token (raw value NEVER stored).
	// The raw bearer is returned once in the HTTP response payload and never
	// re-derivable from the database.
	//
	// TTL: 7 days (issuedAt + 604800000 ms).
	userBearerTokens: defineTable({
		tokenHash: v.string(), // SHA-256 hex of raw bearer
		clerkUserId: v.string(), // Clerk `sub` claim
		workspaceId: v.string(), // logical workspace identifier (clerkUserId-based slug)
		extId: v.string(), // Chrome extension ID that requested the token
		expiresAt: v.number(), // ms since epoch
		revoked: v.boolean(),
		createdAt: v.number(),
		lastUsedAt: v.optional(v.number()),
	})
		.index("by_token_hash", ["tokenHash"])
		.index("by_clerkUserId", ["clerkUserId"]),

	// ── credentialsAuditLog ──────────────────────────────────────────────────
	// Append-only audit trail for every Bearer issuance via issueBearerFromClerk.
	// Never updated after insert — one row per successful (or failed) issuance.
	credentialsAuditLog: defineTable({
		clerkUserId: v.string(),
		workspaceId: v.string(),
		extId: v.string(),
		extVersion: v.optional(v.string()),
		issuedAt: v.number(),
		ip: v.optional(v.string()),
		userAgent: v.optional(v.string()),
	})
		.index("by_clerkUserId", ["clerkUserId"])
		.index("by_workspaceId", ["workspaceId"]),

	// ── credentialsRateLimits ────────────────────────────────────────────────
	// Rolling rate-limit counter for issueBearerFromClerk.
	// key = "<clerkUserId>-issueBearer"
	// Resets automatically when windowStart + 60000 < now.
	credentialsRateLimits: defineTable({
		key: v.string(), // "<clerkUserId>-issueBearer"
		count: v.number(), // requests in current window
		windowStart: v.number(), // ms since epoch — start of 1-minute window
	}).index("by_key", ["key"]),

	// ── oauth_audit_log ──────────────────────────────────────────────────────
	// Append-only audit trail for administrative scope profile mutations.
	// One row per patchScopeProfileEmergency invocation.
	// actorTokenHash = sha256Hex of the callerToken (raw token never stored).
	// previousState + newState allow forensic reconstruction of leaked scopes.
	// S1.2-mutation: captures Day 90 Nadia `global` leak remediation.
	// S2.1-D9: clientsRetargeted added (additive, optional for backward compat).
	oauth_audit_log: defineTable({
		eventType: v.string(),
		actorTokenHash: v.string(),
		targetProfileId: v.string(),
		previousState: v.object({
			profileId: v.string(),
			fromAllowList: v.array(v.string()),
			namespaceReadPrefixes: v.array(v.string()),
			namespaceWritePrefixes: v.array(v.string()),
		}),
		newState: v.object({
			profileId: v.string(),
			fromAllowList: v.array(v.string()),
			namespaceReadPrefixes: v.array(v.string()),
			namespaceWritePrefixes: v.array(v.string()),
		}),
		reason: v.string(),
		cascadeRevokedCount: v.number(),
		// S2.1-D9: number of oauth_clients rows retargeted during rename (0 if no rename).
		// Optional for backward compat with pre-S2.1 rows.
		clientsRetargeted: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index("by_targetProfileId", ["targetProfileId"])
		.index("by_createdAt", ["createdAt"]),

	// ── okfDurableExportProgress ─────────────────────────────────────────────
	// I1 long-task survival — durable variant of `exportOkfBundle`
	// (convex/okfBundleDurable.ts). One row per durable job (keyed by the
	// `@vantageos/agent-engine` `jobId`), tracking pagination cursors across
	// steps so a step function can resume exactly where the previous one left
	// off. `orgId` here IS the requested namespace string (see
	// okfBundleDurable.ts comment) — kept as its own field, never trusted as a
	// client-supplied scope on any step: every step re-derives its DB reads
	// from `namespace`/`orgId` on THIS row, written once at job creation by
	// the authenticated `startOkfBundleExportDurable` mutation.
	okfDurableExportProgress: defineTable({
		jobId: v.string(), // opaque id returned by durableJob.start
		orgId: v.string(), // == namespace; tenant scope for every step read
		namespace: v.string(),
		sinceMs: v.optional(v.number()),
		memoriesCursor: v.union(v.string(), v.null()),
		memoriesDone: v.boolean(),
		briefingsCursor: v.union(v.string(), v.null()),
		briefingsDone: v.boolean(),
		tasksCursor: v.union(v.string(), v.null()),
		tasksDone: v.boolean(),
		memoryCount: v.number(),
		briefingCount: v.number(),
		taskCount: v.number(),
		stepsCompleted: v.number(),
		status: v.union(v.literal("running"), v.literal("assembled")),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_jobId", ["jobId"])
		.index("by_orgId_jobId", ["orgId", "jobId"]),

	// ── okfDurableExportEntries ──────────────────────────────────────────────
	// Serialized bundle files (path + markdown content) appended one page at a
	// time by the durable step function. `orgId` is the FIRST index field on
	// every index (multi-tenant convention) — a step for org A can never read
	// org B's rows because every query below is scoped by `.eq("orgId", ...)`
	// before anything else.
	okfDurableExportEntries: defineTable({
		orgId: v.string(),
		jobId: v.string(),
		family: v.union(
			v.literal("memory"),
			v.literal("briefing"),
			v.literal("task"),
		),
		seq: v.number(),
		path: v.string(),
		content: v.string(),
	})
		.index("by_org_job", ["orgId", "jobId"])
		.index("by_org_job_seq", ["orgId", "jobId", "seq"]),
});
