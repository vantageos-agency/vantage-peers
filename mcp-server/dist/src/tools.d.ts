/**
 * VantagePeers MCP Tool Registrations
 *
 * This module exports registerTools(server, convex) — a single function that
 * registers all 82 tools against any McpServer instance with a given
 * ConvexHttpClient. Both the stdio entry point (server.ts) and the HTTP entry
 * point (server-http.ts) call this function so tool definitions are never
 * duplicated.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { type OAuthContext } from "./auth.js";
export declare const MAX_CONTENT_BYTES = 900000;
/**
 * Measure a string's UTF-8 byte length and throw an McpError if it exceeds
 * MAX_CONTENT_BYTES. Returns the byte count on success so callers can reuse
 * it for observability in the catch path.
 *
 * @param content   The content string to measure.
 * @param toolName  Caller tool name (used only in the error message).
 */
export declare function assertContentSize(content: string, toolName: string): number;
export declare const MAX_LIST_RESPONSE_BYTES = 60000;
export declare function capListResponseBytes(items: unknown, rawText: string, toolName: string, maxBytes?: number): string;
/**
 * Convex document IDs are 32 lowercase alphanumeric characters (a-z0-9).
 * Exported so tests can validate the schema independently of the MCP server.
 */
export declare const convexIdPattern: RegExp;
export declare const receiptIdSchema: z.ZodString;
export declare const memoryIdSchema: z.ZodString;
export declare const creatorSchema: z.ZodString;
export declare const severitySchema: z.ZodEnum<{
    critical: "critical";
    major: "major";
    minor: "minor";
}>;
export declare const flexArray: z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodString]>;
export declare const updateBriefingNoteDescription: string;
export declare const updateBriefingNoteSchema: z.ZodObject<{
    noteId: z.ZodString;
    callerOrchestrator: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    topic: z.ZodOptional<z.ZodString>;
    participants: z.ZodOptional<z.ZodArray<z.ZodString>>;
    content: z.ZodOptional<z.ZodString>;
    decisions: z.ZodOptional<z.ZodArray<z.ZodString>>;
    linkedMemoryIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const taskStatusSchema: z.ZodEnum<{
    review: "review";
    done: "done";
    todo: "todo";
    in_progress: "in_progress";
    blocked: "blocked";
}>;
export declare const missionStatusSchema: z.ZodEnum<{
    brainstorm: "brainstorm";
    plan: "plan";
    execute: "execute";
    validate: "validate";
    complete: "complete";
}>;
export declare const taskStatusFilterSchema: z.ZodUnion<readonly [z.ZodEnum<{
    review: "review";
    done: "done";
    todo: "todo";
    in_progress: "in_progress";
    blocked: "blocked";
    open: "open";
    active: "active";
    all: "all";
}>, z.ZodArray<z.ZodEnum<{
    review: "review";
    done: "done";
    todo: "todo";
    in_progress: "in_progress";
    blocked: "blocked";
}>>]>;
export declare const missionStatusFilterSchema: z.ZodUnion<readonly [z.ZodEnum<{
    open: "open";
    active: "active";
    all: "all";
    brainstorm: "brainstorm";
    plan: "plan";
    execute: "execute";
    validate: "validate";
    complete: "complete";
}>, z.ZodArray<z.ZodEnum<{
    brainstorm: "brainstorm";
    plan: "plan";
    execute: "execute";
    validate: "validate";
    complete: "complete";
}>>]>;
export declare const fieldsSchema: z.ZodEnum<{
    lite: "lite";
    full: "full";
}>;
export declare const updatedSinceSchema: z.ZodNumber;
/**
 * Derive the current VantagePeers day number from the server clock.
 * Returns 1 on or before 2026-03-06 UTC; increments by 1 per UTC day.
 */
export declare function deriveSessionDay(nowMs?: number): number;
export interface ParsedConvexError {
    code: string;
    message: string;
    path: string | null;
    hint: string | null;
}
/**
 * Parse a Convex error message string into a structured object.
 *
 * Input example (from ConvexHttpClient):
 *   "[CONVEX M(briefingNotes:create)] ArgumentValidationError: Found ID
 *    \"js72ewf0m...\" from table briefingNotes, which does not match the table
 *    name in validator v.id(\"memories\"). Path: .linkedMemoryIds[4]"
 *
 * Returns { code, message, path, hint } where:
 *  - code  = "ArgumentValidationError" (or the parsed error type)
 *  - message = the full human-readable error description after the code prefix
 *  - path  = e.g. ".linkedMemoryIds[4]" extracted from "Path: ..." suffix
 *  - hint  = a concise guidance string derived from the error, or null
 *
 * For unrecognised error strings, code = "ServerError" and path/hint = null.
 *
 * Exported for unit testing.
 */
export declare function parseConvexError(rawMessage: string): ParsedConvexError;
/**
 * Produce a structured MCP error response for any error thrown by a Convex
 * operation. For ConvexError / ArgumentValidationError the response body
 * contains a JSON object with { code, message, path, hint } so the MCP client
 * can display actionable diagnostics instead of a bare "Server Error" string.
 *
 * For unrecognised errors the response falls back to the plain text format
 * used by `mcpError`.
 */
export declare function mcpConvexError(error: unknown): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError: true;
};
export declare const whoamiOutputSchema: z.ZodObject<{
    scope_profile_name: z.ZodString;
    fromAllowList: z.ZodArray<z.ZodString>;
    namespaceReadPrefixes: z.ZodArray<z.ZodString>;
    namespaceWritePrefixes: z.ZodArray<z.ZodString>;
    suggested_orchestrator_id: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const storeMemoryOutputSchema: z.ZodObject<{
    memoryId: z.ZodString;
    namespace: z.ZodString;
    type: z.ZodEnum<{
        project: "project";
        user: "user";
        feedback: "feedback";
        reference: "reference";
        episode: "episode";
    }>;
    content: z.ZodString;
}, z.core.$strip>;
export declare const softDeleteMemoryOutputSchema: z.ZodObject<{
    deleted: z.ZodLiteral<true>;
    memoryId: z.ZodString;
}, z.core.$strip>;
export declare const getMemoryOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const recallOutputSchema: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const textSearchOutputSchema: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const hybridSearchOutputSchema: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const storeEpisodeOutputSchema: z.ZodObject<{
    memoryId: z.ZodString;
    type: z.ZodLiteral<"episode">;
    severity: z.ZodEnum<{
        critical: "critical";
        major: "major";
        minor: "minor";
    }>;
    namespace: z.ZodString;
}, z.core.$strip>;
export declare const getProfileOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const updateProfileOutputSchema: z.ZodObject<{
    profileId: z.ZodString;
    orchestratorId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const listMemoriesOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    page: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>]>;
export declare const sendMessageOutputSchema: z.ZodObject<{
    messageId: z.ZodString;
    from: z.ZodString;
    channel: z.ZodString;
}, z.core.$strip>;
export declare const checkMessagesOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    receiptId: z.ZodString;
    from: z.ZodString;
    fromInstanceId: z.ZodOptional<z.ZodString>;
    channel: z.ZodOptional<z.ZodString>;
    content: z.ZodString;
    createdAt: z.ZodNumber;
}, z.core.$strip>>, z.ZodString]>;
export declare const markAsReadOutputSchema: z.ZodObject<{
    markedAsRead: z.ZodNumber;
}, z.core.$strip>;
export declare const deleteMessageOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const setSummaryOutputSchema: z.ZodObject<{
    orchestratorId: z.ZodString;
    instanceId: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
}, z.core.$strip>;
export declare const listPeersOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    _id: z.ZodString;
    _creationTime: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    instanceId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    role: z.ZodString;
    workspace: z.ZodString;
    currentTask: z.ZodString;
    lastSeen: z.ZodString;
    sessionCount: z.ZodNumber;
}, z.core.$strip>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
}, z.core.$strip>]>;
export declare const listMessagesOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
}, z.core.$strip>]>;
export declare const listBroadcastStatusOutputSchema: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const createTaskOutputSchema: z.ZodObject<{
    taskId: z.ZodString;
    title: z.ZodString;
    assignedTo: z.ZodString;
    priority: z.ZodEnum<{
        urgent: "urgent";
        high: "high";
        medium: "medium";
        low: "low";
    }>;
    status: z.ZodEnum<{
        review: "review";
        done: "done";
        todo: "todo";
        in_progress: "in_progress";
        blocked: "blocked";
    }>;
}, z.core.$strip>;
export declare const listTasksOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>]>;
export declare const updateTaskOutputSchema: z.ZodObject<{
    taskId: z.ZodString;
    updated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const completeTaskOutputSchema: z.ZodObject<{
    taskId: z.ZodString;
    status: z.ZodLiteral<"done">;
}, z.core.$strip>;
export declare const startTaskOutputSchema: z.ZodObject<{
    taskId: z.ZodString;
    status: z.ZodLiteral<"in_progress">;
}, z.core.$strip>;
export declare const checkoutTaskOutputSchema: z.ZodUnion<readonly [z.ZodObject<{
    claimed: z.ZodLiteral<true>;
}, z.core.$strip>, z.ZodObject<{
    claimed: z.ZodLiteral<false>;
    reason: z.ZodString;
}, z.core.$strip>]>;
export declare const deleteTaskOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const blockTaskOutputSchema: z.ZodObject<{
    taskId: z.ZodString;
    status: z.ZodLiteral<"blocked">;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const addTaskDependencyOutputSchema: z.ZodObject<{
    taskId: z.ZodString;
    dependsOn: z.ZodArray<z.ZodString>;
    updated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const listTasksByMissionOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
}, z.core.$strip>]>;
export declare const createMissionOutputSchema: z.ZodObject<{
    missionId: z.ZodString;
    name: z.ZodString;
    project: z.ZodString;
    pilot: z.ZodString;
    status: z.ZodEnum<{
        brainstorm: "brainstorm";
        plan: "plan";
        execute: "execute";
        validate: "validate";
        complete: "complete";
    }>;
}, z.core.$strip>;
export declare const listMissionsOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>]>;
export declare const getMissionOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const updateMissionOutputSchema: z.ZodObject<{
    missionId: z.ZodString;
    updated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const updateMissionStatusOutputSchema: z.ZodObject<{
    missionId: z.ZodString;
    status: z.ZodEnum<{
        brainstorm: "brainstorm";
        plan: "plan";
        execute: "execute";
        validate: "validate";
        complete: "complete";
    }>;
}, z.core.$strip>;
export declare const writeDiaryOutputSchema: z.ZodObject<{
    diaryId: z.ZodString;
    date: z.ZodString;
    orchestrator: z.ZodString;
}, z.core.$strip>;
export declare const getDiaryOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const listDiariesOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>]>;
export declare const createBriefingNoteOutputSchema: z.ZodObject<{
    noteId: z.ZodString;
    title: z.ZodString;
    topic: z.ZodString;
    createdBy: z.ZodString;
}, z.core.$strip>;
export declare const updateBriefingNoteOutputSchema: z.ZodObject<{
    noteId: z.ZodString;
    updated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const getBriefingNoteOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const listBriefingNotesOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>]>;
export declare const registerComponentOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const listComponentsOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
}, z.core.$strip>]>;
export declare const getComponentOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const updateComponentOutputSchema: z.ZodObject<{
    componentId: z.ZodString;
    updated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const deleteComponentOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const searchComponentsOutputSchema: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const createRecurringTaskOutputSchema: z.ZodObject<{
    taskId: z.ZodString;
    cronExpression: z.ZodString;
}, z.core.$strip>;
export declare const listRecurringTasksOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
}, z.core.$strip>]>;
export declare const pauseRecurringTaskOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const resumeRecurringTaskOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const deleteRecurringTaskOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const updateRecurringTaskOutputSchema: z.ZodObject<{
    recurringTaskId: z.ZodString;
    updated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const createMandateOutputSchema: z.ZodObject<{
    mandateId: z.ZodString;
    requestedBy: z.ZodString;
    fulfilledBy: z.ZodString;
    service: z.ZodString;
    budget: z.ZodNumber;
}, z.core.$strip>;
export declare const acceptMandateOutputSchema: z.ZodObject<{
    mandateId: z.ZodString;
    status: z.ZodLiteral<"accepted">;
}, z.core.$strip>;
export declare const updateMandateOutputSchema: z.ZodObject<{
    mandateId: z.ZodString;
    updated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const settleMandateOutputSchema: z.ZodObject<{
    mandateId: z.ZodString;
    status: z.ZodLiteral<"settled">;
    finalCost: z.ZodNumber;
}, z.core.$strip>;
export declare const validateMandateSpendingOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const listMandatesOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>]>;
export declare const createBuOutputSchema: z.ZodObject<{
    buId: z.ZodString;
    name: z.ZodString;
    orchestratorId: z.ZodString;
    status: z.ZodEnum<{
        idea: "idea";
        building: "building";
        live: "live";
        revenue: "revenue";
    }>;
}, z.core.$strip>;
export declare const updateBuOutputSchema: z.ZodObject<{
    buId: z.ZodString;
    updated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const getBuOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const listBusOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>]>;
export declare const deleteBuOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const addRepoMappingOutputSchema: z.ZodObject<{
    id: z.ZodString;
    repo: z.ZodString;
    orchestrator: z.ZodString;
    project: z.ZodString;
    active: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const listRepoMappingsOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
}, z.core.$strip>]>;
export declare const removeRepoMappingOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const listIssuesOutputSchema: z.ZodObject<{
    count: z.ZodNumber;
    issues: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const getIssueOutputSchema: z.ZodNullable<z.ZodUnion<readonly [z.ZodRecord<z.ZodString, z.ZodUnknown>, z.ZodObject<{
    error: z.ZodString;
}, z.core.$strip>]>>;
export declare const updateIssueStatusOutputSchema: z.ZodObject<{
    repo: z.ZodString;
    issueNumber: z.ZodNumber;
    status: z.ZodString;
    updated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const linkCommitToIssueOutputSchema: z.ZodObject<{
    repo: z.ZodString;
    issueNumber: z.ZodNumber;
    commitSha: z.ZodString;
    fixedBy: z.ZodString;
    linked: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const verifyIssueOutputSchema: z.ZodObject<{
    repo: z.ZodString;
    issueNumber: z.ZodNumber;
    verifiedBy: z.ZodString;
    verified: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const issueStatsOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const createFixPatternOutputSchema: z.ZodObject<{
    patternId: z.ZodString;
    created: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const addFixAttemptOutputSchema: z.ZodObject<{
    attemptId: z.ZodString;
    patternId: z.ZodString;
    worked: z.ZodBoolean;
}, z.core.$strip>;
export declare const validateFixOutputSchema: z.ZodObject<{
    patternId: z.ZodString;
    validatedFix: z.ZodString;
    validated: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const searchFixPatternsOutputSchema: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const listFixPatternsOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>]>;
export declare const linkIssueToPatternOutputSchema: z.ZodObject<{
    patternId: z.ZodString;
    issueId: z.ZodString;
    linked: z.ZodLiteral<true>;
}, z.core.$strip>;
export declare const getMissionTemplateOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const updateMissionTemplateOutputSchema: z.ZodObject<{
    templateId: z.ZodString;
    name: z.ZodString;
    stepCount: z.ZodNumber;
}, z.core.$strip>;
export declare const instantiateTemplateIntoMissionOutputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const addDeploymentOutputSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    deploymentUrl: z.ZodString;
    githubRepo: z.ZodString;
    orchestrator: z.ZodString;
}, z.core.$strip>;
export declare const removeDeploymentOutputSchema: z.ZodObject<{
    removed: z.ZodString;
}, z.core.$strip>;
export declare const listErrorsOutputSchema: z.ZodUnion<readonly [z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodObject<{
    items: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    nextCursor: z.ZodNullable<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>]>;
export declare const getErrorOutputSchema: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
export declare const validateTaskPayloadOutputSchema: z.ZodObject<{
    valid: z.ZodBoolean;
    errors: z.ZodArray<z.ZodString>;
    warnings: z.ZodArray<z.ZodString>;
    payload: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare function registerTools(server: McpServer, convex: ConvexHttpClient, oauthCtx?: OAuthContext): void;
