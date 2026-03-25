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

export const creatorValidator = v.union(
	v.literal("pi"),
	v.literal("tau"),
	v.literal("phi"),
	v.literal("system"),
);

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
	// Inter-orchestrator messaging. Replaces claude-peers.
	// One message row per send. Recipients tracked via messageReceipts table.
	// channel: "broadcast" | "pi" | "tau" | "phi" | "pi,tau"
	// to: deprecated (kept for migration compatibility, will be removed)
	messages: defineTable({
		from: creatorValidator,
		fromInstanceId: v.optional(v.string()), // "pi-chromebook", "tau-vps-1"
		channel: v.optional(v.string()), // optional during migration
		to: v.optional(creatorValidator), // deprecated — kept for existing data
		content: v.string(),
		sessionDay: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index("by_day", ["sessionDay"])
		.index("by_from", ["from", "createdAt"])
		.index("by_channel", ["channel", "createdAt"]),

	// ── messageReceipts ──────────────────────────────────────────────────────
	// One row per recipient per message. Tracks read status.
	// check_new_messages = query receipts where recipient=X AND readAt=undefined
	messageReceipts: defineTable({
		messageId: v.id("messages"),
		recipient: creatorValidator, // role-level: "pi" | "tau" | "phi"
		recipientInstanceId: v.optional(v.string()), // instance-level: "pi-vps"
		readAt: v.optional(v.number()), // undefined = unread, ms epoch = read
	})
		.index("by_recipient_unread", ["recipient", "readAt"])
		.index("by_instance_unread", ["recipientInstanceId", "readAt"])
		.index("by_message", ["messageId"]),

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
	})
		.index("by_project", ["project", "status"])
		.index("by_pilot", ["pilot", "status"])
		.index("by_status", ["status", "createdAt"])
		.index("by_priority", ["priority", "status"]),

	// ── tasks ──────────────────────────────────────────────────────────────────
	tasks: defineTable({
		title: v.string(),
		description: v.optional(v.string()),
		project: v.optional(v.string()), // "vantage-starter", "perfect-ai-agent", etc.
		tags: v.optional(v.array(v.string())),
		assignedTo: v.union(
			v.literal("pi"),
			v.literal("tau"),
			v.literal("phi"),
			v.literal("laurent"),
		),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		status: v.union(
			v.literal("todo"),
			v.literal("in_progress"),
			v.literal("blocked"),
			v.literal("done"),
		),
		claimedByInstance: v.optional(v.string()), // which instance is working on this
		missionId: v.optional(v.id("missions")),
		estimatedMinutes: v.optional(v.number()),
		actualMinutes: v.optional(v.number()),
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		dueDate: v.optional(v.number()),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_assignee", ["assignedTo", "status"])
		.index("by_project", ["project", "status"])
		.index("by_priority", ["priority", "status"])
		.index("by_status", ["status", "createdAt"])
		.index("by_mission", ["missionId", "status"]),

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
	})
		.index("by_topic", ["topic"])
		.index("by_creator", ["createdBy", "createdAt"]),
});
