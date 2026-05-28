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
export declare const VpTaskPayloadSchema: z.ZodObject<{
    _id: z.ZodString;
    title: z.ZodString;
    status: z.ZodString;
    priority: z.ZodOptional<z.ZodString>;
    assignedTo: z.ZodOptional<z.ZodString>;
    _creationTime: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type VpTaskPayload = z.infer<typeof VpTaskPayloadSchema>;
export declare const VpMessagePayloadSchema: z.ZodObject<{
    _id: z.ZodString;
    from: z.ZodString;
    channel: z.ZodOptional<z.ZodString>;
    content: z.ZodString;
    createdAt: z.ZodNumber;
}, z.core.$strip>;
export type VpMessagePayload = z.infer<typeof VpMessagePayloadSchema>;
export declare const VpDiaryEntryPayloadSchema: z.ZodObject<{
    _id: z.ZodString;
    date: z.ZodString;
    orchestrator: z.ZodString;
    content: z.ZodString;
    highlights: z.ZodOptional<z.ZodArray<z.ZodString>>;
    blockers: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type VpDiaryEntryPayload = z.infer<typeof VpDiaryEntryPayloadSchema>;
export declare const VpMissionPayloadSchema: z.ZodObject<{
    _id: z.ZodString;
    name: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
    status: z.ZodString;
    pilot: z.ZodOptional<z.ZodString>;
    priority: z.ZodOptional<z.ZodString>;
    progress: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type VpMissionPayload = z.infer<typeof VpMissionPayloadSchema>;
export declare const VpBriefingNotePayloadSchema: z.ZodObject<{
    _id: z.ZodString;
    topic: z.ZodString;
    title: z.ZodString;
    participants: z.ZodOptional<z.ZodArray<z.ZodString>>;
    content: z.ZodOptional<z.ZodString>;
    createdBy: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type VpBriefingNotePayload = z.infer<typeof VpBriefingNotePayloadSchema>;
export declare const VpMemoryPayloadSchema: z.ZodObject<{
    _id: z.ZodString;
    namespace: z.ZodString;
    type: z.ZodString;
    content: z.ZodString;
    score: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type VpMemoryPayload = z.infer<typeof VpMemoryPayloadSchema>;
export declare const VpToolResultSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"tasks-table">;
    items: z.ZodArray<z.ZodObject<{
        _id: z.ZodString;
        title: z.ZodString;
        status: z.ZodString;
        priority: z.ZodOptional<z.ZodString>;
        assignedTo: z.ZodOptional<z.ZodString>;
        _creationTime: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"messages-feed">;
    items: z.ZodArray<z.ZodObject<{
        _id: z.ZodString;
        from: z.ZodString;
        channel: z.ZodOptional<z.ZodString>;
        content: z.ZodString;
        createdAt: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"diary-entry">;
    item: z.ZodObject<{
        _id: z.ZodString;
        date: z.ZodString;
        orchestrator: z.ZodString;
        content: z.ZodString;
        highlights: z.ZodOptional<z.ZodArray<z.ZodString>>;
        blockers: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"mission-timeline">;
    items: z.ZodArray<z.ZodObject<{
        _id: z.ZodString;
        name: z.ZodString;
        project: z.ZodOptional<z.ZodString>;
        status: z.ZodString;
        pilot: z.ZodOptional<z.ZodString>;
        priority: z.ZodOptional<z.ZodString>;
        progress: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"briefing-note">;
    item: z.ZodObject<{
        _id: z.ZodString;
        topic: z.ZodString;
        title: z.ZodString;
        participants: z.ZodOptional<z.ZodArray<z.ZodString>>;
        content: z.ZodOptional<z.ZodString>;
        createdBy: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"memory-quote">;
    items: z.ZodArray<z.ZodObject<{
        _id: z.ZodString;
        namespace: z.ZodString;
        type: z.ZodString;
        content: z.ZodString;
        score: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>], "kind">;
export type VpToolResult = z.infer<typeof VpToolResultSchema>;
