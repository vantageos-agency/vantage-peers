/**
 * Zod discriminated union schemas for VantagePeers ui:// resources M3 json-render.
 *
 * Mission instance : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
 * M2 prepares these schemas for M3 Registry json-render + __VP_TOOL_RESULT__<json> stream marker.
 *
 * Cross-fleet : Mu vantage-bridge sidepanel S3 will consume the same schemas
 * via npm package extraction (V2 trigger 3+ MCP).
 */

import { z } from "zod";

// Single task primitive payload
export const VpTaskPayloadSchema = z.object({
	_id: z.string(),
	title: z.string(),
	status: z.string(),
	priority: z.string().optional(),
	assignedTo: z.string().optional(),
	_creationTime: z.number().optional(),
});
export type VpTaskPayload = z.infer<typeof VpTaskPayloadSchema>;

// Single message primitive payload
export const VpMessagePayloadSchema = z.object({
	_id: z.string(),
	from: z.string(),
	channel: z.string().optional(),
	content: z.string(),
	createdAt: z.number(),
});
export type VpMessagePayload = z.infer<typeof VpMessagePayloadSchema>;

// Single diary entry payload
export const VpDiaryEntryPayloadSchema = z.object({
	_id: z.string(),
	date: z.string(),
	orchestrator: z.string(),
	content: z.string(),
	highlights: z.array(z.string()).optional(),
	blockers: z.array(z.string()).optional(),
});
export type VpDiaryEntryPayload = z.infer<typeof VpDiaryEntryPayloadSchema>;

// Single mission payload
export const VpMissionPayloadSchema = z.object({
	_id: z.string(),
	name: z.string(),
	project: z.string().optional(),
	status: z.string(),
	pilot: z.string().optional(),
	priority: z.string().optional(),
	progress: z.number().optional(),
});
export type VpMissionPayload = z.infer<typeof VpMissionPayloadSchema>;

// Single briefing note payload
export const VpBriefingNotePayloadSchema = z.object({
	_id: z.string(),
	topic: z.string(),
	title: z.string(),
	participants: z.array(z.string()).optional(),
	content: z.string().optional(),
	createdBy: z.string().optional(),
});
export type VpBriefingNotePayload = z.infer<typeof VpBriefingNotePayloadSchema>;

// Single memory payload
export const VpMemoryPayloadSchema = z.object({
	_id: z.string(),
	namespace: z.string(),
	type: z.string(),
	content: z.string(),
	score: z.number().optional(),
});
export type VpMemoryPayload = z.infer<typeof VpMemoryPayloadSchema>;

// Discriminated union — VP tool result for M3 __VP_TOOL_RESULT__<json> stream marker.
// Each kind targets a specific primitive renderer.
export const VpToolResultSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("tasks-table"),
		items: z.array(VpTaskPayloadSchema),
	}),
	z.object({
		kind: z.literal("messages-feed"),
		items: z.array(VpMessagePayloadSchema),
	}),
	z.object({ kind: z.literal("diary-entry"), item: VpDiaryEntryPayloadSchema }),
	z.object({
		kind: z.literal("mission-timeline"),
		items: z.array(VpMissionPayloadSchema),
	}),
	z.object({
		kind: z.literal("briefing-note"),
		item: VpBriefingNotePayloadSchema,
	}),
	z.object({
		kind: z.literal("memory-quote"),
		items: z.array(VpMemoryPayloadSchema),
	}),
]);
export type VpToolResult = z.infer<typeof VpToolResultSchema>;
