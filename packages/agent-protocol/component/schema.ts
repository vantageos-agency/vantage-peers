import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators (mirrored from host convex/schema.ts — never import from host)
// ─────────────────────────────────────────────────────────────────────────────

// Open validator — any orchestrator name is accepted.
// Known defaults: pi, tau, phi, sigma, omega, zeta, eta, kappa, system.
// New orchestrators can be added without schema changes (see issue #132).
export const creatorValidator = v.string();

export const memoryTypeValidator = v.union(
	v.literal("user"),
	v.literal("feedback"),
	v.literal("project"),
	v.literal("reference"),
	v.literal("episode"),
);

export const severityValidator = v.union(
	v.literal("critical"),
	v.literal("major"),
	v.literal("minor"),
);

// ─────────────────────────────────────────────────────────────────────────────
// Component schema — 9 agent-protocol tables + memories stub
// (byte-for-byte mirror of host convex/schema.ts entries)
// ─────────────────────────────────────────────────────────────────────────────

export default defineSchema({
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
	// Inter-orchestrator messaging. Replaces claude-peers.
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
		.index("by_tenant_channel", ["tenantId", "channel", "createdAt"]),

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
		// Set to Clerk org slug (e.g. "iris-rh") for client-scoped rows.
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
		// Set to Clerk org slug (e.g. "iris-rh") for client-scoped rows.
		orgId: v.optional(v.string()),
	})
		.index("by_assignee", ["assignedTo", "status"])
		.index("by_project", ["project", "status"])
		.index("by_priority", ["priority", "status"])
		.index("by_status", ["status", "createdAt"])
		.index("by_mission", ["missionId", "status"])
		.index("by_instance", ["assignedToInstance", "status"])
		.index("by_orgId", ["orgId"]),

	// ── diary ──────────────────────────────────────────────────────────────────
	diary: defineTable({
		date: v.string(), // "2026-03-25" ISO date
		orchestrator: creatorValidator,
		instanceId: v.optional(v.string()), // which instance wrote this
		content: v.string(), // Full diary entry
		highlights: v.optional(v.array(v.string())),
		blockers: v.optional(v.array(v.string())),
		createdAt: v.number(),
	})
		.index("by_orchestrator_date", ["orchestrator", "date"])
		.index("by_date", ["date"]),

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
		// Set to Clerk org slug (e.g. "iris-rh") for client-scoped rows.
		orgId: v.optional(v.string()),
	})
		.index("by_topic", ["topic"])
		.index("by_creator", ["createdBy", "createdAt"])
		.index("by_orgId", ["orgId"]),

	// ── memories (stub) ──────────────────────────────────────────────────────
	// Stub table required because briefingNotes.linkedMemoryIds references v.id("memories").
	// Full memories schema lives in the data-lake component.
	// Phase D: cross-component ID references will be resolved via data-lake component mount.
	memories: defineTable({
		namespace: v.string(),
		type: memoryTypeValidator,
		content: v.string(),
		createdBy: creatorValidator,
		instanceId: v.optional(v.string()),
		relations: v.array(
			v.object({
				targetId: v.id("memories"),
				type: v.union(
					v.literal("updates"),
					v.literal("extends"),
					v.literal("derives"),
				),
			}),
		),
		isLatest: v.boolean(),
		ttl: v.optional(v.string()),
		episode: v.optional(
			v.object({
				context: v.string(),
				goal: v.string(),
				action: v.string(),
				outcome: v.string(),
				insight: v.string(),
				severity: severityValidator,
			}),
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_namespace", ["namespace", "isLatest"])
		.index("by_type", ["type", "isLatest"])
		.index("by_creator", ["createdBy", "isLatest"])
		.index("by_namespace_type", ["namespace", "type", "isLatest"]),

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

	// ── githubRepoMapping (stub) ──────────────────────────────────────────────
	// Stub required for tasksV1.complete cross-table queries.
	// Full definition lives in the host convex/schema.ts.
	githubRepoMapping: defineTable({
		repo: v.string(),
		orchestrator: v.string(),
		project: v.string(),
		active: v.boolean(),
	}).index("by_repo", ["repo"]),

	// ── issues (stub) ─────────────────────────────────────────────────────────
	// Stub required for tasksV1.complete cross-table queries.
	// Full definition lives in the host convex/schema.ts.
	issues: defineTable({
		repo: v.string(),
		issueNumber: v.number(),
		title: v.string(),
		body: v.string(),
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
		externalRepo: v.optional(v.string()),
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
		forkRepo: v.optional(v.string()),
	})
		.index("by_repo_number", ["repo", "issueNumber"])
		.index("by_status", ["status"])
		.index("by_project", ["project"])
		.index("by_assigned", ["assignedOrchestrator", "status"])
		.index("by_external_repo", ["externalRepo", "prStatus"]),

	// ── fixPatterns (stub) ───────────────────────────────────────────────────
	// Stub required for tasksV1.complete cross-table insert.
	// Full definition lives in the host convex/schema.ts.
	fixPatterns: defineTable({
		symptom: v.string(),
		rootCause: v.string(),
		validatedFix: v.optional(v.string()),
		files: v.optional(v.array(v.string())),
		tags: v.array(v.string()),
		stack: v.array(v.string()),
		sourceProject: v.optional(v.string()),
		linkedIssueIds: v.optional(v.array(v.string())),
		createdBy: creatorValidator,
		severity: severityValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_project", ["sourceProject"])
		.index("by_severity", ["severity"])
		.index("by_creator", ["createdBy"]),

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
});
