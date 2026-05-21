import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators (mirrored from host convex/schema.ts)
// ─────────────────────────────────────────────────────────────────────────────

export const memoryTypeValidator = v.union(
	v.literal("user"),
	v.literal("feedback"),
	v.literal("project"),
	v.literal("reference"),
	v.literal("episode"),
);

// Open validator — any orchestrator name is accepted.
export const creatorValidator = v.string();

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
// Component schema — memories + episodes tables
// (byte-for-byte mirror of host convex/schema.ts memories definition)
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
});
