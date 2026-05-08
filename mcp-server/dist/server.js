#!/usr/bin/env node
/**
 * VantagePeers MCP Server
 * Exposes 82 Convex-backed tools to Claude Code agents via stdio transport.
 *
 * Tool categories: Memory, Profiles, Messages, Tasks, Missions, Diary,
 * Briefing Notes, Components, Recurring Tasks, Mandates, Business Units,
 * Issues, Fix Patterns, Search/RAG, Mission Templates, Error Monitoring,
 * Deployments, Repo Mappings.
 *
 * See README.md for the full tool reference.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "fs";
import { resolve } from "path";
import { z } from "zod";
// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: resolve CONVEX_URL from env or .env.local
// ─────────────────────────────────────────────────────────────────────────────
function loadConvexUrl() {
    // 1. Explicit env var always wins
    if (process.env.CONVEX_URL) {
        return process.env.CONVEX_URL;
    }
    // 2. Parse .env.local from the user's project directory (where npx is run)
    const envPath = resolve(process.cwd(), ".env.local");
    try {
        const raw = readFileSync(envPath, "utf-8");
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("CONVEX_URL=")) {
                const value = trimmed.slice("CONVEX_URL=".length).split("#")[0].trim();
                if (value)
                    return value;
            }
        }
    }
    catch {
        // .env.local not found — fall through to error
    }
    process.stderr.write("Error: CONVEX_URL not found.\n\nSet it via:\n  export CONVEX_URL=https://your-deployment.convex.cloud\n\nOr create a .env.local file with CONVEX_URL=...\n");
    process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────
// Shared Zod schemas for validated params
// ─────────────────────────────────────────────────────────────────────────────
const memoryTypeSchema = z
    .enum(["user", "feedback", "project", "reference", "episode"])
    .describe("Memory classification type");
// Open string — validated at runtime by the backend (issue #132).
// Known defaults: pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, system.
// New internal orchestrators use Greek letters (lowercase); external client orchestrators use free lowercase strings.
const creatorSchema = z
    .string()
    .describe("Orchestrator role name (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, laurent, or any custom client role (lowercase string)). " +
    "New internal orchestrators use Greek letters (lowercase); external client orchestrators use free lowercase strings.");
const severitySchema = z
    .enum(["critical", "major", "minor"])
    .describe("Episode severity — critical = cross-orchestrator lesson");
// ─────────────────────────────────────────────────────────────────────────────
// Helper: normalize string|array inputs to array (agents pass strings for arrays)
// ─────────────────────────────────────────────────────────────────────────────
function toArray(val) {
    if (val === undefined)
        return undefined;
    if (Array.isArray(val)) {
        // Unwrap double-encoded arrays: ["[\"a\",\"b\"]"] → ["a","b"]
        if (val.length === 1 && typeof val[0] === "string") {
            try {
                const parsed = JSON.parse(val[0]);
                if (Array.isArray(parsed))
                    return parsed;
            }
            catch {
                // not JSON — use as-is
            }
        }
        return val;
    }
    // Single string — might be a JSON-encoded array like "[\"a\"]"
    if (val.startsWith("[")) {
        try {
            const parsed = JSON.parse(val);
            if (Array.isArray(parsed))
                return parsed;
        }
        catch {
            // not valid JSON — wrap as single-element array
        }
    }
    return [val];
}
// Schema helper: accepts string or array of strings
const flexArray = z.union([z.array(z.string()), z.string()]);
const flexArrayOptional = flexArray.optional();
// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────
const convexUrl = loadConvexUrl();
const convex = new ConvexHttpClient(convexUrl);
const server = new McpServer({
    name: "vantage-peers",
    version: "2.0.0",
});
// ─────────────────────────────────────────────────────────────────────────────
// Helper: structured error response for MCP tool handlers
// ─────────────────────────────────────────────────────────────────────────────
function mcpError(message) {
    return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// Tool: store_memory
// ─────────────────────────────────────────────────────────────────────────────
server.tool("store_memory", "Store a typed memory entry in VantagePeers. Supports user, feedback, project, and reference types. " +
    "Optional relatesTo creates a graph relation (updates supersedes the target, extends adds detail, derives is an inference).", {
    namespace: z
        .string()
        .describe("Memory namespace — e.g. 'global', 'orchestrator/pi', 'project/vantage-starter'"),
    type: memoryTypeSchema,
    content: z
        .string()
        .describe("Human-readable memory content — what the memory says"),
    createdBy: creatorSchema,
    relatesTo: z
        .object({
        targetId: z
            .string()
            .describe("ID of the memory this relates to (Convex document ID)"),
        type: z
            .enum(["updates", "extends", "derives"])
            .describe("Relation type: updates=supersedes, extends=adds detail, derives=inference"),
    })
        .optional()
        .describe("Optional graph relation to another memory"),
    ttl: z
        .string()
        .optional()
        .describe("Optional expiry ISO timestamp e.g. '2026-06-01T00:00:00Z'"),
}, async ({ namespace, type, content, createdBy, relatesTo, ttl }) => {
    try {
        const relations = relatesTo
            ? [{ targetId: relatesTo.targetId, type: relatesTo.type }]
            : [];
        const memoryId = await convex.mutation("memories:storeMemory", {
            namespace,
            type,
            content,
            createdBy,
            relations,
            ttl,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ memoryId, namespace, type, content }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: soft_delete_memory
// ─────────────────────────────────────────────────────────────────────────────
server.tool("soft_delete_memory", "Soft-delete a memory — marks it as no longer latest so it stops appearing in recall results. " +
    "The memory is preserved for audit but excluded from search.", {
    memoryId: z.string().describe("Convex document ID of the memory to soft-delete"),
}, async ({ memoryId }) => {
    try {
        await convex.mutation("memories:softDeleteMemory", {
            memoryId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ deleted: true, memoryId }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_memory
// ─────────────────────────────────────────────────────────────────────────────
server.tool("get_memory", "Fetch a single memory by its ID. Returns full memory content including relations and episode data.", {
    memoryId: z.string().describe("Memory document ID"),
}, async ({ memoryId }) => {
    try {
        const memory = await convex.query("memories:getMemory", {
            memoryId,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(memory, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: recall
// ─────────────────────────────────────────────────────────────────────────────
server.tool("recall", "Semantic vector search over VantagePeers. Returns top K memories ranked by cosine similarity to the query. " +
    "Optionally filter by namespace and/or type.", {
    query: z
        .string()
        .describe("Natural language query to search for relevant memories"),
    namespace: z
        .string()
        .optional()
        .describe("Filter to a specific namespace — omit to search all"),
    type: memoryTypeSchema
        .optional()
        .describe("Filter to a specific memory type — omit to search all"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(5)
        .describe("Maximum number of results to return (default 5)"),
}, async ({ query, namespace, type, limit }) => {
    try {
        const results = await convex.action("search:recall", {
            query,
            namespace,
            type,
            limit: limit ?? 5,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(results, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: text_search
// ─────────────────────────────────────────────────────────────────────────────
server.tool("text_search", "BM25 full-text keyword search over memories. Use for exact keyword matching when semantic recall isn't specific enough.", {
    query: z.string().describe("Search query text"),
    namespace: z.string().optional().describe("Namespace filter (e.g. 'global', 'project/my-project')"),
    type: memoryTypeSchema.optional().describe("Filter by memory type"),
    limit: z.number().int().min(1).max(50).optional().default(10).describe("Max results"),
}, async ({ query, namespace, type, limit }) => {
    try {
        const results = await convex.action("search:textSearch", {
            query,
            namespace,
            type,
            limit: limit ?? 10,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: hybrid_search
// ─────────────────────────────────────────────────────────────────────────────
server.tool("hybrid_search", "Combined vector + BM25 search using Reciprocal Rank Fusion (RRF). Best of both worlds: semantic understanding + keyword precision.", {
    query: z.string().describe("Search query text"),
    namespace: z.string().optional().describe("Namespace filter"),
    type: memoryTypeSchema.optional().describe("Filter by memory type"),
    limit: z.number().int().min(1).max(50).optional().default(10).describe("Max results"),
    vectorWeight: z.number().min(0).max(1).optional().describe("Weight for vector results in RRF (default: 0.5)"),
    textWeight: z.number().min(0).max(1).optional().describe("Weight for text results in RRF (default: 0.5)"),
}, async ({ query, namespace, type, limit, vectorWeight, textWeight }) => {
    try {
        const results = await convex.action("search:hybridSearch", {
            query,
            namespace,
            type,
            limit: limit ?? 10,
            vectorWeight,
            textWeight,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: store_episode
// ─────────────────────────────────────────────────────────────────────────────
server.tool("store_episode", "Store an episodic memory with structured context/goal/action/outcome/insight fields. " +
    "Episodes are the 'other half' of memory — not just facts, but what happened and what was learned. " +
    "Use severity=critical for lessons that should be shared across all orchestrators.", {
    namespace: z.string().describe("Memory namespace — e.g. 'orchestrator/pi'"),
    createdBy: creatorSchema,
    context: z
        .string()
        .describe("Situation that triggered this episode — what was the setup"),
    goal: z.string().describe("What was being attempted"),
    action: z.string().describe("What was actually done"),
    outcome: z.string().describe("What happened — success or failure"),
    insight: z
        .string()
        .describe("The lesson extracted — procedural memory, what to do differently"),
    severity: severitySchema,
}, async ({ namespace, createdBy, context, goal, action, outcome, insight, severity, }) => {
    try {
        const memoryId = await convex.mutation("episodes:storeEpisode", {
            namespace,
            createdBy,
            context,
            goal,
            action,
            outcome,
            insight,
            severity,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ memoryId, type: "episode", severity, namespace }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_profile
// ─────────────────────────────────────────────────────────────────────────────
server.tool("get_profile", "Fetch an orchestrator profile (static identity + dynamic session state). " +
    "Returns null if the profile does not exist yet — call update_profile to create it.", {
    orchestratorId: z
        .string()
        .describe("Orchestrator identifier"),
}, async ({ orchestratorId }) => {
    try {
        const profile = await convex.query("profiles:getProfile", {
            orchestratorId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(profile, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_profile
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_profile", "Create or update an orchestrator profile. Provide only the fields you want to change. " +
    "static fields are stable identity facts (role, workspace, capabilities). " +
    "dynamic fields are mutable session state (currentTask, lastSeen, sessionCount).", {
    orchestratorId: z
        .string()
        .describe("Orchestrator identifier"),
    name: z.string().optional().describe("Human-readable orchestrator name"),
    static: z
        .object({
        role: z.string().describe("Orchestrator role description"),
        workspace: z.string().describe("Primary working directory"),
        capabilities: z
            .array(z.string())
            .describe("List of capability keywords"),
    })
        .optional()
        .describe("Stable identity facts — infrequently updated"),
    dynamic: z
        .object({
        currentTask: z
            .string()
            .optional()
            .describe("Current task or goal in progress"),
        lastSeen: z
            .number()
            .describe("Unix timestamp (ms) of last session start"),
        sessionCount: z.number().int().describe("Total sessions to date"),
    })
        .optional()
        .describe("Mutable session state — updated each session"),
}, async ({ orchestratorId, name, static: staticFields, dynamic }) => {
    try {
        const profileId = await convex.mutation("profiles:upsertProfile", {
            orchestratorId,
            name,
            static: staticFields,
            dynamic,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ profileId, orchestratorId, name }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_memories
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_memories", "List active memories for a namespace, ordered newest first. " +
    "Only returns isLatest=true memories (superseded memories are excluded by default). " +
    "Use type to filter to a specific memory category.", {
    namespace: z
        .string()
        .describe("Namespace to list memories from — e.g. 'global', 'orchestrator/pi'"),
    type: memoryTypeSchema
        .optional()
        .describe("Filter to a specific type — omit to return all types"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(20)
        .describe("Maximum number of memories to return (default 20)"),
}, async ({ namespace, type, limit }) => {
    try {
        const memories = await convex.query("memories:listMemories", {
            namespace,
            type,
            limit: limit ?? 20,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(memories, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: send_message
// ─────────────────────────────────────────────────────────────────────────────
server.tool("send_message", "Send a message to one, many, or all orchestrators. " +
    "channel: 'broadcast' = all, 'tau' = role DM, 'pi-vps' = instance DM, 'tau,phi' = multi. " +
    "Creates message + one receipt per recipient. Replaces claude-peers send_message.", {
    from: creatorSchema.describe("Sender role (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, or any custom role)"),
    fromInstanceId: z
        .string()
        .optional()
        .describe("Sender instance ID — e.g. 'pi-chromebook', 'tau-vps-1'"),
    channel: z
        .string()
        .describe("Recipients: 'broadcast' | 'tau' | 'pi-vps' | 'tau,phi' (comma-separated)"),
    content: z.string().describe("Message content"),
    sessionDay: z
        .number()
        .int()
        .optional()
        .describe("Day number (e.g. 19 for Day 19)"),
    tenantId: z
        .string()
        .optional()
        .describe("Tenant identifier for multi-tenant isolation"),
}, async ({ from, fromInstanceId, channel, content, sessionDay, tenantId }) => {
    try {
        const messageId = await convex.mutation("messages:sendMessage", {
            from,
            fromInstanceId,
            channel,
            content,
            sessionDay,
            tenantId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ messageId, from, channel }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: check_messages
// ─────────────────────────────────────────────────────────────────────────────
server.tool("check_messages", "Check for unread messages. Returns messages with receiptIds for marking as read. " +
    "If recipientInstanceId is provided, returns instance-targeted + role-level messages. " +
    "Replaces claude-peers check_messages.", {
    recipient: creatorSchema.describe("Orchestrator role (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, or any custom role)"),
    recipientInstanceId: z
        .string()
        .optional()
        .describe("Instance ID — e.g. 'pi-chromebook'. Gets instance + role messages."),
    tenantId: z
        .string()
        .optional()
        .describe("Filter messages to this tenant only"),
}, async ({ recipient, recipientInstanceId, tenantId }) => {
    try {
        const messages = await convex.query("messages:checkNewMessages", {
            recipient,
            recipientInstanceId,
            tenantId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: messages.length === 0
                        ? "No new messages."
                        : JSON.stringify(messages, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: mark_as_read
// ─────────────────────────────────────────────────────────────────────────────
server.tool("mark_as_read", "Mark one or more message receipts as read. Pass the receiptIds from check_messages.", {
    receiptIds: z
        .union([z.array(z.string()), z.string()])
        .describe("Receipt IDs to mark as read — array or single string"),
}, async ({ receiptIds }) => {
    try {
        // Handle all input forms: array, single string, or JSON-encoded string
        let receiptIdsArray;
        if (Array.isArray(receiptIds)) {
            receiptIdsArray = receiptIds;
        }
        else if (typeof receiptIds === "string" && receiptIds.startsWith("[")) {
            try {
                receiptIdsArray = JSON.parse(receiptIds);
            }
            catch {
                receiptIdsArray = [receiptIds];
            }
        }
        else {
            receiptIdsArray = [receiptIds];
        }
        const count = await convex.mutation("messages:markAsRead", {
            receiptIds: receiptIdsArray,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ markedAsRead: count }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: delete_message
// ─────────────────────────────────────────────────────────────────────────────
server.tool("delete_message", "Delete a message and all its receipts. Only the sender (or system) can delete a message.", {
    messageId: z.string().describe("Convex document ID of the message to delete"),
    callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — must be the sender or system"),
}, async ({ messageId, callerOrchestrator }) => {
    try {
        const result = await convex.mutation("messages:deleteMessage", {
            messageId: messageId,
            callerOrchestrator,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: set_summary
// ─────────────────────────────────────────────────────────────────────────────
server.tool("set_summary", "Set a brief summary of what you are currently working on. " +
    "Visible to other orchestrators via list_peers. Uses the profiles table. " +
    "Provide instanceId to register as a specific instance (e.g. 'pi-chromebook').", {
    orchestratorId: z
        .string()
        .describe("Orchestrator role"),
    instanceId: z
        .string()
        .optional()
        .describe("Instance ID — e.g. 'pi-chromebook', 'pi-vps', 'tau-vps-1'"),
    summary: z
        .string()
        .describe("1-2 sentence summary of current work"),
}, async ({ orchestratorId, instanceId, summary }) => {
    try {
        await convex.mutation("profiles:updateDynamic", {
            orchestratorId,
            instanceId,
            currentTask: summary,
            lastSeen: Date.now(),
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ orchestratorId, instanceId, summary }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_peers
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_peers", "List all orchestrator profiles with their current status and summary. " +
    "Replaces claude-peers list_peers.", {}, async () => {
    try {
        const profiles = await convex.query("profiles:listProfiles", {});
        const peers = profiles.map((p) => ({
            id: p.orchestratorId,
            instanceId: p.instanceId ?? p.orchestratorId,
            name: p.name,
            role: p.static.role,
            workspace: p.static.workspace,
            currentTask: p.dynamic.currentTask ?? "idle",
            lastSeen: new Date(p.dynamic.lastSeen).toISOString(),
            sessionCount: p.dynamic.sessionCount,
        }));
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(peers, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_messages
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_messages", "List message history. Filter by day or sender. For unread messages use check_messages instead.", {
    sessionDay: z
        .number()
        .int()
        .optional()
        .describe("Filter to a specific day"),
    from: creatorSchema.optional().describe("Filter by sender"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(100)
        .describe("Max messages to return (default 100)"),
}, async ({ sessionDay, from, limit }) => {
    try {
        const messages = await convex.query("messages:listMessages", {
            sessionDay,
            from,
            limit: limit ?? 100,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(messages, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_broadcast_status
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_broadcast_status", "Show who read a broadcast message and who didn't. Pass the messageId from send_message.", {
    messageId: z.string().describe("Convex document ID of the broadcast message"),
}, async ({ messageId }) => {
    try {
        const status = await convex.query("messages:listBroadcastStatus", {
            messageId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(status, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_task
// ─────────────────────────────────────────────────────────────────────────────
// Open string — validated at runtime by the backend (issue #132).
const assigneeSchema = z
    .string()
    .describe("Orchestrator to assign to (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, laurent, or any custom client role (lowercase string)). " +
    "New internal orchestrators use Greek letters (lowercase); external client orchestrators use free lowercase strings.");
const prioritySchema = z
    .enum(["urgent", "high", "medium", "low"])
    .describe("Task priority level");
const componentTypeSchema = z
    .enum(["agent", "skill", "hook", "plugin"])
    .describe("Component type");
const taskStatusSchema = z
    .enum(["todo", "in_progress", "review", "blocked", "done"])
    .describe("Task status");
server.tool("create_task", "Create a task in VantagePeers. Tasks are assigned to an orchestrator " +
    "with priority and status tracking. Optionally link to a project or mission.", {
    title: z.string().describe("Task title"),
    description: z.string().optional().describe("Detailed task description"),
    project: z
        .string()
        .optional()
        .describe("Project name — e.g. 'vantage-starter', 'perfect-ai-agent'"),
    tags: flexArrayOptional
        .describe("Optional tags for categorization"),
    assignedTo: assigneeSchema,
    assignedToInstance: z
        .string()
        .optional()
        .describe("Instance-level assignment — e.g. 'pi-vps', 'tau-chromebook'. Optional."),
    priority: prioritySchema,
    status: taskStatusSchema.default("todo"),
    dependsOn: z
        .array(z.string())
        .optional()
        .describe("Task IDs that must be completed before this task can start"),
    missionId: z
        .string()
        .optional()
        .describe("Convex document ID of the parent mission"),
    estimatedMinutes: z
        .number()
        .optional()
        .describe("Estimated duration in minutes"),
    dueDate: z
        .number()
        .optional()
        .describe("Optional due date as Unix timestamp (ms)"),
    createdBy: creatorSchema,
}, async ({ title, description, project, tags, assignedTo, assignedToInstance, priority, status, dependsOn, missionId, estimatedMinutes, dueDate, createdBy, }) => {
    try {
        const taskId = await convex.mutation("tasks:create", {
            title,
            description,
            project,
            tags: toArray(tags),
            assignedTo,
            assignedToInstance,
            priority,
            status,
            dependsOn: toArray(dependsOn),
            missionId: missionId,
            estimatedMinutes,
            dueDate,
            createdBy,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ taskId, title, assignedTo, priority, status }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_tasks
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_tasks", "List tasks from VantagePeers with optional filters. " +
    "Filter by assignee, instance, status, and/or project. Returns newest first.", {
    assignedTo: assigneeSchema.optional().describe("Filter by assignee"),
    assignedToInstance: z
        .string()
        .optional()
        .describe("Filter by instance — e.g. 'pi-vps'. Returns only tasks assigned to that instance."),
    status: taskStatusSchema.optional().describe("Filter by status"),
    project: z.string().optional().describe("Filter by project name"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of tasks to return (default 50)"),
}, async ({ assignedTo, assignedToInstance, status, project, limit }) => {
    try {
        const tasks = await convex.query("tasks:list", {
            assignedTo,
            assignedToInstance,
            status,
            project,
            limit: limit ?? 50,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(tasks, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_task", "Update any mutable field on a task. Provide only the fields you want to change. " +
    "updatedAt is set automatically.", {
    taskId: z.string().describe("Convex document ID of the task to update"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    project: z.string().optional().describe("New project"),
    tags: flexArrayOptional.describe("New tags"),
    assignedTo: assigneeSchema.optional().describe("Reassign to"),
    priority: prioritySchema.optional().describe("New priority"),
    status: taskStatusSchema.optional().describe("New status"),
    dependsOn: z
        .array(z.string())
        .optional()
        .describe("Task IDs that must be completed before this task can start"),
    missionId: z
        .string()
        .optional()
        .describe("Link to a mission (Convex document ID)"),
    estimatedMinutes: z
        .number()
        .optional()
        .describe("Estimated duration in minutes"),
    actualMinutes: z.number().optional().describe("Actual duration in minutes"),
    startedAt: z.number().optional().describe("When work started (Unix ms)"),
    completedAt: z
        .number()
        .optional()
        .describe("When work completed (Unix ms)"),
    dueDate: z.number().optional().describe("New due date (Unix ms)"),
    callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — if provided, must be creator or assignee"),
}, async ({ taskId, title, description, project, tags, assignedTo, priority, status, dependsOn, missionId, estimatedMinutes, actualMinutes, startedAt, completedAt, dueDate, callerOrchestrator, }) => {
    try {
        await convex.mutation("tasks:update", {
            taskId: taskId,
            title,
            description,
            project,
            tags: toArray(tags),
            assignedTo,
            priority,
            status,
            dependsOn: toArray(dependsOn),
            missionId: missionId,
            estimatedMinutes,
            actualMinutes,
            startedAt,
            completedAt,
            dueDate,
            callerOrchestrator,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ taskId, updated: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: complete_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("complete_task", "Mark a task as done. ALWAYS provide a completionNote describing what was actually done. " +
    "This is mandatory — never complete a task without explaining the work. " +
    "After completing, ALWAYS send_message to the task creator (check createdBy field) with a summary of what was done.", {
    taskId: z.string().describe("Convex document ID of the task to complete"),
    completionNote: z
        .string()
        .describe("What was actually done — summary of work completed"),
    callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — if provided, must be creator or assignee"),
}, async ({ taskId, completionNote, callerOrchestrator }) => {
    try {
        await convex.mutation("tasks:complete", {
            taskId: taskId,
            completionNote,
            callerOrchestrator,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ taskId, status: "done" }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: start_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("start_task", "Start a task — sets status to in_progress and records startedAt timestamp. " +
    "Use this when beginning work on a task to enable automatic duration tracking.", {
    taskId: z.string().describe("Convex document ID of the task to start"),
    callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — if provided, must be creator or assignee"),
}, async ({ taskId, callerOrchestrator }) => {
    try {
        await convex.mutation("tasks:start", {
            taskId: taskId,
            callerOrchestrator,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ taskId, status: "in_progress" }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: checkout_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("checkout_task", "Atomically claim a task. Only succeeds if task is in 'todo' status — prevents two orchestrators " +
    "from claiming the same task. Returns {claimed: true} or {claimed: false, reason: '...'}.", {
    taskId: z.string().describe("Convex document ID of the task to claim"),
    callerOrchestrator: creatorSchema.describe("Orchestrator claiming the task (e.g. sigma, pi)"),
    callerInstance: z.string().optional().describe("Instance identifier, e.g. 'sigma-vps'"),
}, async ({ taskId, callerOrchestrator, callerInstance }) => {
    try {
        const result = await convex.mutation("tasks:checkout", {
            taskId: taskId,
            callerOrchestrator,
            callerInstance,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: delete_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("delete_task", "Permanently delete a task. Only the creator (or system) can delete.", {
    taskId: z.string().describe("Convex document ID of the task to delete"),
    callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — must be creator or system"),
}, async ({ taskId, callerOrchestrator }) => {
    try {
        const result = await convex.mutation("tasks:deleteTask", {
            taskId: taskId,
            callerOrchestrator,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: block_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("block_task", "Mark a task as blocked with an optional reason. Sets status to 'blocked' and records the blocker description.", {
    taskId: z.string().describe("Convex document ID of the task to block"),
    reason: z.string().optional().describe("Why the task is blocked"),
    blockedBy: z.array(z.string()).optional().describe("Task IDs that are blocking this task"),
    callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — must be creator or assignee"),
}, async ({ taskId, reason, blockedBy, callerOrchestrator }) => {
    try {
        const updateArgs = {
            taskId: taskId,
            status: "blocked",
        };
        if (reason)
            updateArgs.completionNote = reason;
        if (blockedBy)
            updateArgs.dependsOn = blockedBy.map((id) => id);
        if (callerOrchestrator)
            updateArgs.callerOrchestrator = callerOrchestrator;
        await convex.mutation("tasks:update", updateArgs);
        return {
            content: [{ type: "text", text: JSON.stringify({ taskId, status: "blocked", reason }, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: add_task_dependency
// ─────────────────────────────────────────────────────────────────────────────
server.tool("add_task_dependency", "Add a dependency to a task. The task cannot start until all dependencies are complete. " +
    "Pass the IDs of tasks that must complete before this one can begin.", {
    taskId: z.string().describe("Convex document ID of the task that depends on others"),
    dependsOn: z.array(z.string()).describe("Task IDs that must complete first"),
    callerOrchestrator: creatorSchema.optional().describe("Optional RBAC — must be creator or assignee"),
}, async ({ taskId, dependsOn, callerOrchestrator }) => {
    try {
        const updateArgs = {
            taskId: taskId,
            dependsOn: dependsOn.map((id) => id),
        };
        if (callerOrchestrator)
            updateArgs.callerOrchestrator = callerOrchestrator;
        await convex.mutation("tasks:update", updateArgs);
        return {
            content: [{ type: "text", text: JSON.stringify({ taskId, dependsOn, updated: true }, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_tasks_by_mission
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_tasks_by_mission", "List all tasks linked to a specific mission. Optionally filter by status.", {
    missionId: z.string().describe("Convex document ID of the mission"),
    status: taskStatusSchema.optional().describe("Filter by task status"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of tasks to return (default 50)"),
}, async ({ missionId, status, limit }) => {
    try {
        const tasks = await convex.query("tasks:listByMission", {
            missionId: missionId,
            status,
            limit: limit ?? 50,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(tasks, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_mission
// ─────────────────────────────────────────────────────────────────────────────
const missionStatusSchema = z
    .enum(["brainstorm", "plan", "execute", "validate", "complete"])
    .describe("Mission lifecycle status");
server.tool("create_mission", "Create a mission in VantagePeers. Missions group related tasks under a project, " +
    "with a pilot orchestrator and assigned agents. Track progress through lifecycle statuses.", {
    name: z.string().describe("Mission name"),
    description: z.string().optional().describe("Mission description"),
    project: z
        .string()
        .describe("Project name — e.g. 'my-project', 'shared'"),
    status: missionStatusSchema.default("brainstorm"),
    priority: prioritySchema,
    pilot: creatorSchema.describe("Lead orchestrator for this mission"),
    agents: flexArray.describe("List of agent names involved"),
    brief: z.string().optional().describe("Mission brief / instructions"),
    startDate: z.number().optional().describe("Planned start date (Unix ms)"),
    targetDate: z
        .number()
        .optional()
        .describe("Target completion date (Unix ms)"),
    progress: z.number().optional().describe("Progress percentage (0-100)"),
    createdBy: creatorSchema,
}, async ({ name, description, project, status, priority, pilot, agents, brief, startDate, targetDate, progress, createdBy, }) => {
    try {
        const missionId = await convex.mutation("missions:create", {
            name,
            description,
            project,
            status,
            priority,
            pilot,
            agents: toArray(agents),
            brief,
            startDate,
            targetDate,
            progress,
            createdBy,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ missionId, name, project, pilot, status }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_missions
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_missions", "List missions from VantagePeers with optional filters. " +
    "Filter by project, pilot, and/or status. Returns newest first.", {
    project: z.string().optional().describe("Filter by project name"),
    pilot: creatorSchema.optional().describe("Filter by pilot orchestrator"),
    status: missionStatusSchema.optional().describe("Filter by status"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of missions to return (default 50)"),
}, async ({ project, pilot, status, limit }) => {
    try {
        const missions = await convex.query("missions:list", {
            project,
            pilot,
            status,
            limit: limit ?? 50,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(missions, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_mission
// ─────────────────────────────────────────────────────────────────────────────
server.tool("get_mission", "Fetch a single mission by ID. Returns full mission details including status, pilot, agents, progress, and dates.", {
    missionId: z.string().describe("Convex document ID of the mission"),
}, async ({ missionId }) => {
    try {
        const mission = await convex.query("missions:get", {
            missionId: missionId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(mission, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_mission
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_mission", "Update any mutable field on a mission. Provide only the fields you want to change. " +
    "updatedAt is set automatically.", {
    missionId: z
        .string()
        .describe("Convex document ID of the mission to update"),
    name: z.string().optional().describe("New name"),
    description: z.string().optional().describe("New description"),
    project: z.string().optional().describe("New project"),
    status: missionStatusSchema.optional().describe("New status"),
    priority: prioritySchema.optional().describe("New priority"),
    pilot: creatorSchema.optional().describe("New pilot"),
    agents: flexArrayOptional.describe("New agents list"),
    brief: z.string().optional().describe("New brief"),
    startDate: z.number().optional().describe("New start date (Unix ms)"),
    targetDate: z.number().optional().describe("New target date (Unix ms)"),
    progress: z.number().optional().describe("New progress (0-100)"),
}, async ({ missionId, name, description, project, status, priority, pilot, agents, brief, startDate, targetDate, progress, }) => {
    try {
        await convex.mutation("missions:update", {
            missionId: missionId,
            name,
            description,
            project,
            status,
            priority,
            pilot,
            agents: toArray(agents),
            brief,
            startDate,
            targetDate,
            progress,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ missionId, updated: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_mission_status
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_mission_status", "Change a mission's status. Shortcut for updating only the status field.", {
    missionId: z.string().describe("Convex document ID of the mission"),
    status: missionStatusSchema.describe("New status"),
}, async ({ missionId, status }) => {
    try {
        await convex.mutation("missions:updateStatus", {
            missionId: missionId,
            status,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ missionId, status }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: write_diary
// ─────────────────────────────────────────────────────────────────────────────
server.tool("write_diary", "Write or update a diary entry for a specific date and orchestrator. " +
    "If an entry already exists for that date+orchestrator, it will be updated (upsert).", {
    date: z.string().describe("ISO date string — e.g. '2026-03-25'"),
    orchestrator: creatorSchema.describe("Which orchestrator is writing"),
    content: z.string().describe("Full diary entry content"),
    highlights: flexArrayOptional
        .describe("Key highlights of the day"),
    blockers: flexArrayOptional.describe("Blockers encountered"),
}, async ({ date, orchestrator, content, highlights, blockers }) => {
    try {
        const diaryId = await convex.mutation("diary:write", {
            date,
            orchestrator,
            content,
            highlights: toArray(highlights),
            blockers: toArray(blockers),
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ diaryId, date, orchestrator }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_diary
// ─────────────────────────────────────────────────────────────────────────────
server.tool("get_diary", "Fetch a diary entry for a specific date and orchestrator. Returns null if no entry exists.", {
    date: z.string().describe("ISO date string — e.g. '2026-03-25'"),
    orchestrator: creatorSchema.describe("Which orchestrator's diary to fetch"),
}, async ({ date, orchestrator }) => {
    try {
        const entry = await convex.query("diary:get", {
            date,
            orchestrator,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(entry, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_diaries
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_diaries", "List diary entries, optionally filtered by orchestrator. Returns newest first.", {
    orchestrator: creatorSchema
        .optional()
        .describe("Filter to a specific orchestrator — omit for all"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum entries to return (default 20)"),
}, async ({ orchestrator, limit }) => {
    try {
        const entries = await convex.query("diary:list", {
            orchestrator,
            limit: limit ?? 20,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(entries, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_briefing_note
// ─────────────────────────────────────────────────────────────────────────────
server.tool("create_briefing_note", "Create a briefing note — a structured record of a topic discussion, with participants, " +
    "content, optional decisions, and optional links to existing memories.", {
    title: z.string().describe("Briefing note title"),
    topic: z
        .string()
        .describe("Topic category — e.g. 'architecture', 'revenue', 'product'"),
    participants: z
        .union([z.array(z.string()), z.string()])
        .describe("Who participated — e.g. ['pi', 'sigma'] or 'pi'"),
    content: z.string().describe("Full briefing content"),
    decisions: flexArrayOptional
        .describe("Decisions made during the briefing"),
    linkedMemoryIds: flexArrayOptional
        .describe("Convex document IDs of related memories"),
    createdBy: creatorSchema,
}, async ({ title, topic, participants, content, decisions, linkedMemoryIds, createdBy, }) => {
    try {
        const noteId = await convex.mutation("briefingNotes:create", {
            title,
            topic,
            participants: toArray(participants),
            content,
            decisions: toArray(decisions),
            linkedMemoryIds: toArray(linkedMemoryIds),
            createdBy,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ noteId, title, topic, createdBy }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_briefing_note
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_briefing_note", "Update an existing briefing note. Partial-update — only provided fields are patched. " +
    "Arrays (decisions, linkedMemoryIds, participants) are FULL REPLACE, not append. " +
    "RBAC : caller must be createdBy or 'system'. " +
    "Sets updatedAt + updatedBy automatically.", {
    noteId: z
        .string()
        .describe("Convex document ID of the briefing note to update"),
    callerOrchestrator: creatorSchema.describe("Orchestrator role making the update — must match createdBy or be 'system' (RBAC deny-by-default)"),
    title: z.string().optional().describe("Optional new title — full replace"),
    topic: z.string().optional().describe("Optional new topic — full replace"),
    participants: z
        .array(z.string())
        .optional()
        .describe("Optional new participants array — full replace, not append"),
    content: z
        .string()
        .optional()
        .describe("Optional new content — full replace"),
    decisions: z
        .array(z.string())
        .optional()
        .describe("Optional new decisions array — full replace, not append"),
    linkedMemoryIds: z
        .array(z.string())
        .optional()
        .describe("Optional new linkedMemoryIds array — full replace, not append. Each ID must point to memories table."),
}, async ({ noteId, callerOrchestrator, title, topic, participants, content, decisions, linkedMemoryIds, }) => {
    try {
        await convex.mutation("briefingNotes:update", {
            noteId: noteId,
            callerOrchestrator,
            title,
            topic,
            participants,
            content,
            decisions,
            linkedMemoryIds: linkedMemoryIds,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ noteId, updated: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_briefing_notes
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_briefing_notes", "List briefing notes, optionally filtered by topic. Returns newest first.", {
    topic: z
        .string()
        .optional()
        .describe("Filter to a specific topic — omit for all"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum notes to return (default 20)"),
}, async ({ topic, limit }) => {
    try {
        const notes = await convex.query("briefingNotes:list", {
            topic,
            limit: limit ?? 20,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(notes, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: register_component
// ─────────────────────────────────────────────────────────────────────────────
server.tool("register_component", "Register or update a component (agent, skill, hook, or plugin) in the registry. " +
    "Upserts by name+type — if a component with the same name and type exists, it updates the content.", {
    name: z.string().describe("Component name — e.g. 'copywriter', 'check-tasks'"),
    type: componentTypeSchema,
    team: z
        .string()
        .optional()
        .describe("Team this component belongs to — e.g. 'marketing', 'development'"),
    content: z.string().describe("Full file content of the component"),
    version: z.string().optional().describe("Version string — e.g. '1.0.0'"),
    project: z.string().optional().describe("Project this component belongs to"),
    createdBy: creatorSchema,
}, async ({ name, type, team, content, version, project, createdBy }) => {
    try {
        const result = await convex.mutation("components:register", {
            name,
            type,
            team,
            content,
            version,
            project,
            createdBy,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_components
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_components", "List registered components. Filter by type (agent/skill/hook/plugin) and/or team.", {
    type: componentTypeSchema.optional().describe("Filter by component type"),
    team: z.string().optional().describe("Filter by team"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(100)
        .describe("Maximum components to return (default 100)"),
}, async ({ type, team, limit }) => {
    try {
        const components = await convex.query("components:list", {
            type,
            team,
            limit: limit ?? 100,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(components, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_component
// ─────────────────────────────────────────────────────────────────────────────
server.tool("get_component", "Fetch a single component by name and type. Returns the full content.", {
    name: z.string().describe("Component name"),
    type: componentTypeSchema,
}, async ({ name, type }) => {
    try {
        const component = await convex.query("components:get", {
            name,
            type,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(component, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_component
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_component", "Update a component's fields. Provide only the fields you want to change.", {
    componentId: z.string().describe("Convex document ID of the component"),
    name: z.string().optional().describe("New component name"),
    team: z.string().optional().describe("New team name"),
    content: z.string().optional().describe("New content/source code"),
    version: z.string().optional().describe("New version string"),
    project: z.string().optional().describe("New project name"),
}, async ({ componentId, ...fields }) => {
    try {
        const result = await convex.mutation("components:update", {
            componentId: componentId,
            ...fields,
        });
        return {
            content: [{ type: "text", text: JSON.stringify({ componentId: result, updated: true }, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: delete_component
// ─────────────────────────────────────────────────────────────────────────────
server.tool("delete_component", "Delete a component from the registry by ID.", {
    componentId: z.string().describe("Convex document ID of the component to delete"),
}, async ({ componentId }) => {
    try {
        const result = await convex.mutation("components:remove", {
            componentId: componentId,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: search_components
// ─────────────────────────────────────────────────────────────────────────────
server.tool("search_components", "Search components by name or team substring. Optionally filter by type.", {
    query: z.string().describe("Search term to match against component name or team"),
    type: componentTypeSchema.optional().describe("Filter by component type"),
    limit: z.number().int().optional().describe("Max results (default 50)"),
}, async ({ query, type, limit }) => {
    try {
        const results = await convex.query("components:search", {
            query,
            type,
            limit,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_recurring_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("create_recurring_task", "Create a recurring task that auto-creates tasks on a schedule. " +
    "Uses cron expressions: '0 9 * * *' = daily 9am, '0 9 * * 1' = Monday 9am, '*/30 * * * *' = every 30min.", {
    title: z.string().describe("Task title — created each time the cron fires"),
    description: z.string().optional().describe("Task description"),
    assignedTo: assigneeSchema.describe("Who gets the created tasks"),
    priority: z.enum(["urgent", "high", "medium", "low"]).describe("Priority of created tasks"),
    project: z.string().optional().describe("Project name"),
    tags: flexArray.optional().describe("Tags for created tasks"),
    cronExpression: z.string().describe("5-field cron: minute hour day-of-month month day-of-week"),
    createdBy: creatorSchema,
}, async ({ title, description, assignedTo, priority, project, tags, cronExpression, createdBy }) => {
    try {
        const tagsArray = tags ? (Array.isArray(tags) ? tags : [tags]) : undefined;
        const taskId = await convex.mutation("recurringTasks:create", {
            title,
            description,
            assignedTo,
            priority,
            project,
            tags: tagsArray,
            cronExpression,
            createdBy,
        });
        return {
            content: [{ type: "text", text: JSON.stringify({ taskId, cronExpression }, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_recurring_tasks
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_recurring_tasks", "List recurring task templates. Filter by assignee or active status.", {
    assignedTo: assigneeSchema.optional().describe("Filter by assignee"),
    active: z.boolean().optional().describe("Filter by active status"),
    limit: z.number().int().min(1).max(200).optional().default(50).describe("Max results"),
}, async ({ assignedTo, active, limit }) => {
    try {
        const tasks = await convex.query("recurringTasks:list", {
            assignedTo,
            active,
            limit: limit ?? 50,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: pause_recurring_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("pause_recurring_task", "Pause a recurring task — stops auto-creating tasks until resumed.", {
    taskId: z.string().describe("Recurring task ID"),
}, async ({ taskId }) => {
    try {
        const result = await convex.mutation("recurringTasks:pause", {
            taskId: taskId,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: resume_recurring_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("resume_recurring_task", "Resume a paused recurring task — recalculates next run time.", {
    taskId: z.string().describe("Recurring task ID"),
}, async ({ taskId }) => {
    try {
        const result = await convex.mutation("recurringTasks:resume", {
            taskId: taskId,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: delete_recurring_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("delete_recurring_task", "Permanently delete a recurring task template.", {
    taskId: z.string().describe("Recurring task ID"),
}, async ({ taskId }) => {
    try {
        const result = await convex.mutation("recurringTasks:remove", {
            taskId: taskId,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_recurring_task
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_recurring_task", "Update a recurring task's fields. Provide only the fields you want to change. " +
    "If cronExpression is updated, nextRunAt is automatically recalculated.", {
    recurringTaskId: z.string().describe("Convex document ID of the recurring task"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    assignedTo: creatorSchema.optional().describe("New assignee"),
    priority: prioritySchema.optional().describe("New priority"),
    project: z.string().optional().describe("New project name"),
    tags: z.array(z.string()).optional().describe("New tags array"),
    cronExpression: z.string().optional().describe("New cron expression (5-field)"),
}, async ({ recurringTaskId, ...fields }) => {
    try {
        const result = await convex.mutation("recurringTasks:update", {
            recurringTaskId: recurringTaskId,
            ...fields,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ recurringTaskId: result, updated: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Mandate tools
// ─────────────────────────────────────────────────────────────────────────────
const mandateStatusSchema = z
    .enum(["requested", "accepted", "in_progress", "delivered", "settled"])
    .describe("Mandate lifecycle status");
// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_mandate
// ─────────────────────────────────────────────────────────────────────────────
server.tool("create_mandate", "Create a cross-orchestrator service mandate. One orchestrator requests a service from another " +
    "with an agreed token budget. The mandate lifecycle: requested → accepted → in_progress → delivered → settled.", {
    requestedBy: creatorSchema.describe("Orchestrator who needs the service"),
    fulfilledBy: creatorSchema.describe("Orchestrator who will provide the service"),
    service: z.string().describe("Description of what service is needed"),
    budget: z.number().describe("Token budget allocated for this mandate"),
    spendingLimits: z.object({
        maxPerTransaction: z.number(),
        maxPerPeriod: z.number(),
        periodDays: z.number().optional(),
    }).optional().describe("AP2 spending limits"),
    approvedCategories: z.array(z.string()).optional().describe("Approved service categories"),
    mandateDocument: z.string().optional().describe("Signed authorization document or reference"),
}, async ({ requestedBy, fulfilledBy, service, budget, spendingLimits, approvedCategories, mandateDocument }) => {
    try {
        const mandateId = await convex.mutation("mandates:create", {
            requestedBy,
            fulfilledBy,
            service,
            budget,
            spendingLimits,
            approvedCategories,
            mandateDocument,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ mandateId, requestedBy, fulfilledBy, service, budget }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: accept_mandate
// ─────────────────────────────────────────────────────────────────────────────
server.tool("accept_mandate", "Accept a mandate — sets status to 'accepted'. Only the fulfilledBy orchestrator (or system) can accept.", {
    mandateId: z.string().describe("Convex document ID of the mandate to accept"),
    callerOrchestrator: creatorSchema.describe("Must be the fulfilledBy orchestrator or system"),
}, async ({ mandateId, callerOrchestrator }) => {
    try {
        await convex.mutation("mandates:accept", {
            mandateId: mandateId,
            callerOrchestrator,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ mandateId, status: "accepted" }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_mandate
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_mandate", "Update a mandate's status, tokensCost, or linkedTaskIds. " +
    "Only the fulfilledBy orchestrator (or system) can update. Provide only fields you want to change.", {
    mandateId: z.string().describe("Convex document ID of the mandate to update"),
    callerOrchestrator: creatorSchema.describe("Must be the fulfilledBy orchestrator or system"),
    status: mandateStatusSchema.optional().describe("New status"),
    tokensCost: z.number().optional().describe("Tokens consumed so far"),
    linkedTaskIds: z
        .array(z.string())
        .optional()
        .describe("Task IDs created to fulfill this mandate"),
}, async ({ mandateId, callerOrchestrator, status, tokensCost, linkedTaskIds }) => {
    try {
        await convex.mutation("mandates:update", {
            mandateId: mandateId,
            callerOrchestrator,
            status,
            tokensCost,
            linkedTaskIds: linkedTaskIds,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ mandateId, updated: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: settle_mandate
// ─────────────────────────────────────────────────────────────────────────────
server.tool("settle_mandate", "Settle a mandate — confirms delivery and records the final token cost. " +
    "Sets status to 'settled'. Only the requestedBy orchestrator (the payer) or system can settle.", {
    mandateId: z.string().describe("Convex document ID of the mandate to settle"),
    callerOrchestrator: creatorSchema.describe("Must be the requestedBy orchestrator or system"),
    finalCost: z.number().describe("Final actual token cost to record"),
}, async ({ mandateId, callerOrchestrator, finalCost }) => {
    try {
        await convex.mutation("mandates:settle", {
            mandateId: mandateId,
            callerOrchestrator,
            finalCost,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ mandateId, status: "settled", finalCost }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: validate_mandate_spending
// ─────────────────────────────────────────────────────────────────────────────
server.tool("validate_mandate_spending", "Check if a proposed spend is within a mandate's AP2 spending limits. Returns within/exceeded status with details.", {
    mandateId: z.string().describe("Mandate ID to validate against"),
    proposedAmount: z.number().describe("Proposed token spend amount to validate"),
}, async ({ mandateId, proposedAmount }) => {
    try {
        const result = await convex.query("mandates:validateSpending", {
            mandateId: mandateId,
            proposedAmount,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_mandates
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_mandates", "List mandates with optional filters. Filter by requestedBy, fulfilledBy, and/or status. " +
    "Returns newest first. Use to track service agreements between orchestrators.", {
    requestedBy: creatorSchema.optional().describe("Filter by the orchestrator who requested the service"),
    fulfilledBy: creatorSchema.optional().describe("Filter by the orchestrator providing the service"),
    status: mandateStatusSchema.optional().describe("Filter by mandate status"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum mandates to return (default 50)"),
}, async ({ requestedBy, fulfilledBy, status, limit }) => {
    try {
        const mandates = await convex.query("mandates:list", {
            requestedBy,
            fulfilledBy,
            status,
            limit: limit ?? 50,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(mandates, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Business Unit tools
// ─────────────────────────────────────────────────────────────────────────────
const buStatusSchema = z
    .enum(["idea", "building", "live", "revenue"])
    .describe("Business unit lifecycle status");
const revenueProjectionsSchema = z
    .object({
    y1: z.number().describe("Year 1 revenue projection"),
    y2: z.number().describe("Year 2 revenue projection"),
    y3: z.number().describe("Year 3 revenue projection"),
})
    .describe("3-year revenue projections");
const coreTeamSchema = z
    .object({
    agents: z.array(z.string()).describe("Agent names involved"),
    skills: z.array(z.string()).describe("Skill names deployed"),
    hooks: z.array(z.string()).describe("Hook names deployed"),
    plugins: z.array(z.string()).describe("Plugin names deployed"),
})
    .describe("Core team composition — agents, skills, hooks, plugins");
// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_bu
// ─────────────────────────────────────────────────────────────────────────────
server.tool("create_bu", "Create a new business unit. Captures strategy, business model, team, and KPIs. " +
    "managementFee defaults to 10 (percentage of revenue).", {
    name: z.string().describe("Business unit name — e.g. 'VantagePeers'"),
    description: z.string().describe("Short description of the BU"),
    purpose: z.string().describe("Why this BU exists — strategic purpose"),
    domain: z.string().optional().describe("Primary domain — e.g. 'vantagepeers.com'"),
    orchestratorId: z
        .string()
        .describe("Lead orchestrator managing this BU — e.g. 'sigma'"),
    status: buStatusSchema,
    businessModel: z.string().describe("How this BU makes money"),
    targetCustomers: z.string().describe("Who the customers are"),
    services: flexArray.describe("List of services offered"),
    pricing: z.string().describe("Pricing model description"),
    revenueProjections: revenueProjectionsSchema,
    coreTeam: coreTeamSchema,
    coreProcesses: flexArray.describe("Core operational processes"),
    dependencies: flexArray.describe("Other BU names this BU depends on"),
    kpis: flexArray.describe("Key performance indicators"),
    managementFee: z
        .number()
        .optional()
        .default(10)
        .describe("Management fee percentage (default 10)"),
}, async ({ name, description, purpose, domain, orchestratorId, status, businessModel, targetCustomers, services, pricing, revenueProjections, coreTeam, coreProcesses, dependencies, kpis, managementFee, }) => {
    try {
        const buId = await convex.mutation("businessUnits:create", {
            name,
            description,
            purpose,
            domain,
            orchestratorId,
            status,
            businessModel,
            targetCustomers,
            services: toArray(services),
            pricing,
            revenueProjections,
            coreTeam,
            coreProcesses: toArray(coreProcesses),
            dependencies: toArray(dependencies),
            kpis: toArray(kpis),
            managementFee: managementFee ?? 10,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ buId, name, orchestratorId, status }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_bu
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_bu", "Update any mutable field on a business unit. Provide only the fields you want to change. " +
    "updatedAt is set automatically.", {
    buId: z.string().describe("Convex document ID of the business unit to update"),
    name: z.string().optional().describe("New name"),
    description: z.string().optional().describe("New description"),
    purpose: z.string().optional().describe("New purpose"),
    domain: z.string().optional().describe("New domain"),
    orchestratorId: z.string().optional().describe("New lead orchestrator"),
    status: buStatusSchema.optional().describe("New status"),
    businessModel: z.string().optional().describe("New business model"),
    targetCustomers: z.string().optional().describe("New target customers"),
    services: flexArrayOptional.describe("New services list"),
    pricing: z.string().optional().describe("New pricing model"),
    revenueProjections: revenueProjectionsSchema.optional().describe("Updated revenue projections"),
    coreTeam: coreTeamSchema.optional().describe("Updated core team"),
    coreProcesses: flexArrayOptional.describe("New core processes"),
    dependencies: flexArrayOptional.describe("New dependencies"),
    kpis: flexArrayOptional.describe("New KPIs"),
    managementFee: z.number().optional().describe("New management fee %"),
}, async ({ buId, name, description, purpose, domain, orchestratorId, status, businessModel, targetCustomers, services, pricing, revenueProjections, coreTeam, coreProcesses, dependencies, kpis, managementFee, }) => {
    try {
        await convex.mutation("businessUnits:update", {
            buId: buId,
            name,
            description,
            purpose,
            domain,
            orchestratorId,
            status,
            businessModel,
            targetCustomers,
            services: toArray(services),
            pricing,
            revenueProjections,
            coreTeam,
            coreProcesses: toArray(coreProcesses),
            dependencies: toArray(dependencies),
            kpis: toArray(kpis),
            managementFee,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ buId, updated: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_bu
// ─────────────────────────────────────────────────────────────────────────────
server.tool("get_bu", "Fetch a single business unit by its Convex document ID. Returns null if not found.", {
    buId: z.string().describe("Convex document ID of the business unit"),
}, async ({ buId }) => {
    try {
        const bu = await convex.query("businessUnits:get", {
            buId: buId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(bu, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_bus
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_bus", "List business units with optional filters. Filter by orchestratorId and/or status. " +
    "Returns newest first.", {
    orchestratorId: z
        .string()
        .optional()
        .describe("Filter by lead orchestrator — e.g. 'sigma'"),
    status: buStatusSchema.optional().describe("Filter by status"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum BUs to return (default 50)"),
}, async ({ orchestratorId, status, limit }) => {
    try {
        const bus = await convex.query("businessUnits:list", {
            orchestratorId,
            status,
            limit: limit ?? 50,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(bus, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: delete_bu
// ─────────────────────────────────────────────────────────────────────────────
server.tool("delete_bu", "Delete a business unit by ID. This action is permanent.", {
    buId: z.string().describe("Convex document ID of the business unit to delete"),
}, async ({ buId }) => {
    try {
        const result = await convex.mutation("businessUnits:remove", {
            buId: buId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: add_repo_mapping
// ─────────────────────────────────────────────────────────────────────────────
server.tool("add_repo_mapping", "Add or update a GitHub repo → orchestrator mapping. Used by the webhook pipeline to route GitHub events to the right orchestrator.", {
    repo: z
        .string()
        .describe("Full repo name — e.g. 'elpiarthera/vantage-peers'"),
    orchestrator: z
        .string()
        .describe("Target orchestrator — e.g. 'sigma', 'omega', 'tau'"),
    project: z
        .string()
        .describe("Project name — e.g. 'vantage-peers', 'myreeldream'"),
    active: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether this mapping is active (default true)"),
}, async ({ repo, orchestrator, project, active }) => {
    try {
        const id = await convex.mutation("githubRepoMapping:add", {
            repo,
            orchestrator,
            project,
            active,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ id, repo, orchestrator, project, active }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_repo_mappings
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_repo_mappings", "List all GitHub repo → orchestrator mappings. Shows which repos are monitored and which orchestrator handles each.", {}, async () => {
    try {
        const mappings = await convex.query("githubRepoMapping:list", {});
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(mappings, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: remove_repo_mapping
// ─────────────────────────────────────────────────────────────────────────────
server.tool("remove_repo_mapping", "Remove a GitHub repo mapping by repo name. Stops routing webhook events for this repo.", {
    repo: z
        .string()
        .describe("Full repo name to remove — e.g. 'elpiarthera/vantage-peers'"),
}, async ({ repo }) => {
    try {
        const result = await convex.mutation("githubRepoMapping:remove", {
            repo,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ repo, ...result }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_issues
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_issues", "List GitHub issues tracked in VantagePeers. Filter by project, status, or assigned orchestrator.", {
    project: z
        .string()
        .optional()
        .describe("Filter by project name — e.g. 'myreeldream', 'vantage-starter'"),
    status: z
        .enum(["open", "in_progress", "fixed", "verified", "closed"])
        .optional()
        .describe("Filter by issue status"),
    assignedTo: z
        .string()
        .optional()
        .describe("Filter by assigned orchestrator — e.g. 'omega', 'sigma'"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of issues to return (default 50)"),
}, async ({ project, status, assignedTo, limit }) => {
    try {
        let results;
        if (assignedTo) {
            results = await convex.query("issues:listByOrchestrator", {
                assignedOrchestrator: assignedTo,
                status: status,
                limit: limit ?? 50,
            });
        }
        else if (project) {
            results = await convex.query("issues:listByProject", {
                project,
                status: status,
                limit: limit ?? 50,
            });
        }
        else if (status) {
            results = await convex.query("issues:listByStatus", {
                status: status,
                limit: limit ?? 50,
            });
        }
        else {
            results = await convex.query("issues:listByProject", {
                project: "",
                limit: limit ?? 50,
            });
        }
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ count: results.length, issues: results }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_issue
// ─────────────────────────────────────────────────────────────────────────────
server.tool("get_issue", "Get a single GitHub issue by repo and issue number.", {
    repo: z.string().describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
    issueNumber: z.number().int().describe("GitHub issue number"),
}, async ({ repo, issueNumber }) => {
    try {
        const issue = await convex.query("issues:getByRepoNumber", {
            repo,
            issueNumber,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(issue ?? { error: "Issue not found" }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_issue_status
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_issue_status", "Update the status of a tracked GitHub issue.", {
    repo: z.string().describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
    issueNumber: z.number().int().describe("GitHub issue number"),
    status: z
        .enum(["open", "in_progress", "fixed", "verified", "closed"])
        .describe("New status for the issue"),
}, async ({ repo, issueNumber, status }) => {
    try {
        await convex.mutation("issues:updateStatus", {
            repo,
            issueNumber,
            status,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ repo, issueNumber, status, updated: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: link_commit_to_issue
// ─────────────────────────────────────────────────────────────────────────────
server.tool("link_commit_to_issue", "Link a fix commit SHA to a GitHub issue. Records who fixed it and when.", {
    repo: z.string().describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
    issueNumber: z.number().int().describe("GitHub issue number"),
    commitSha: z.string().describe("Git commit SHA that fixes this issue"),
    fixedBy: z.string().describe("Who fixed it — orchestrator name or person"),
}, async ({ repo, issueNumber, commitSha, fixedBy }) => {
    try {
        await convex.mutation("issues:linkCommit", {
            repo,
            issueNumber,
            commitSha,
            fixedBy,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ repo, issueNumber, commitSha, fixedBy, linked: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: verify_issue
// ─────────────────────────────────────────────────────────────────────────────
server.tool("verify_issue", "Mark a GitHub issue as verified (fix confirmed). Sets status to 'verified'.", {
    repo: z.string().describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
    issueNumber: z.number().int().describe("GitHub issue number"),
    verifiedBy: z.string().describe("Who verified the fix — orchestrator name or person"),
}, async ({ repo, issueNumber, verifiedBy }) => {
    try {
        await convex.mutation("issues:verify", {
            repo,
            issueNumber,
            verifiedBy,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ repo, issueNumber, verifiedBy, verified: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: issue_stats
// ─────────────────────────────────────────────────────────────────────────────
server.tool("issue_stats", "Get issue count statistics grouped by status. Optionally filter by project.", {
    project: z
        .string()
        .optional()
        .describe("Filter stats to a specific project — omit for all projects"),
}, async ({ project }) => {
    try {
        const stats = await convex.query("issues:getStats", {
            project,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(stats, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_fix_pattern
// ─────────────────────────────────────────────────────────────────────────────
server.tool("create_fix_pattern", "Create a fix pattern in the knowledge base. Documents a bug symptom, root cause, and optional validated fix. Agents search this BEFORE fixing to avoid repeating mistakes.", {
    symptom: z.string().describe("What the bug looks like — the user-visible problem"),
    rootCause: z.string().describe("Why the bug happens — the underlying technical cause"),
    tags: flexArray.describe("Tags for categorization — e.g. 'react-hydration', 'convex-subscription'"),
    stack: flexArray.describe("Tech stack involved — e.g. 'next.js', 'convex', 'clerk'"),
    sourceProject: z.string().describe("Project where this was discovered — e.g. 'myreeldream'"),
    createdBy: creatorSchema,
    severity: severitySchema,
    validatedFix: z.string().optional().describe("The fix that worked — set later if not known yet"),
    files: flexArrayOptional.describe("Files involved in the fix"),
    linkedIssueIds: flexArrayOptional.describe("VantagePeers issue IDs linked to this pattern"),
}, async ({ symptom, rootCause, tags, stack, sourceProject, createdBy, severity, validatedFix, files, linkedIssueIds }) => {
    try {
        const patternId = await convex.mutation("fixPatterns:create", {
            symptom,
            rootCause,
            tags: toArray(tags) ?? [],
            stack: toArray(stack) ?? [],
            sourceProject,
            createdBy,
            severity,
            validatedFix,
            files: toArray(files),
            linkedIssueIds: toArray(linkedIssueIds),
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ patternId, created: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: add_fix_attempt
// ─────────────────────────────────────────────────────────────────────────────
server.tool("add_fix_attempt", "Add a fix attempt to a pattern. Documents what was tried, whether it worked, and why. If worked=true and pattern has no validatedFix, auto-sets it.", {
    patternId: z.string().describe("ID of the fix pattern"),
    description: z.string().describe("What was tried — the fix approach"),
    worked: z.boolean().describe("Did this fix the issue?"),
    why: z.string().describe("Why it worked or didn't — the reasoning"),
    createdBy: creatorSchema,
    commit: z.string().optional().describe("Git commit hash of this attempt"),
}, async ({ patternId, description, worked, why, createdBy, commit }) => {
    try {
        const attemptId = await convex.mutation("fixPatterns:addAttempt", {
            patternId: patternId,
            description,
            worked,
            why,
            createdBy,
            commit,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ attemptId, patternId, worked }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: validate_fix
// ─────────────────────────────────────────────────────────────────────────────
server.tool("validate_fix", "Set or update the validated fix on a pattern. Use after confirming a fix works.", {
    patternId: z.string().describe("ID of the fix pattern"),
    validatedFix: z.string().describe("Description of the validated fix"),
}, async ({ patternId, validatedFix }) => {
    try {
        await convex.mutation("fixPatterns:validate", {
            patternId: patternId,
            validatedFix,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ patternId, validatedFix, validated: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: search_fix_patterns
// ─────────────────────────────────────────────────────────────────────────────
server.tool("search_fix_patterns", "Semantic search over fix patterns. Use this BEFORE fixing a bug to check if it's been seen before. Returns patterns ranked by relevance.", {
    query: z.string().describe("Describe the problem — e.g. 'message disappears after sending'"),
    limit: z.number().int().optional().describe("Max results to return (default 10)"),
}, async ({ query, limit }) => {
    try {
        const results = await convex.action("search:searchFixPatterns", {
            query,
            limit,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(results, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_fix_patterns
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_fix_patterns", "List fix patterns, optionally filtered by project. Returns patterns sorted by creation date (newest first).", {
    project: z.string().optional().describe("Filter by source project — omit for all"),
    limit: z.number().int().optional().describe("Max results (default 50)"),
}, async ({ project, limit }) => {
    try {
        if (project) {
            const results = await convex.query("fixPatterns:listByProject", {
                sourceProject: project,
                limit,
            });
            return {
                content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
            };
        }
        // No project filter — list all patterns
        const allResults = await convex.query("fixPatterns:listAll", {
            limit,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(allResults, null, 2) }],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: link_issue_to_pattern
// ─────────────────────────────────────────────────────────────────────────────
server.tool("link_issue_to_pattern", "Link a VantagePeers issue to a fix pattern. Creates a bidirectional reference.", {
    patternId: z.string().describe("ID of the fix pattern"),
    issueId: z.string().describe("VantagePeers issue ID to link"),
}, async ({ patternId, issueId }) => {
    try {
        await convex.mutation("fixPatterns:linkIssue", {
            patternId: patternId,
            issueId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ patternId, issueId, linked: true }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_mission_template
// ─────────────────────────────────────────────────────────────────────────────
server.tool("get_mission_template", "Fetch a mission template by name. Returns the template with all steps, or null if not found. " +
    "Use 'issue-resolution-v2' for the default Issue Resolution Protocol.", {
    name: z.string().describe("Template name — e.g. 'issue-resolution-v2'"),
}, async ({ name }) => {
    try {
        const template = await convex.query("missionTemplates:getByName", { name });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(template, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: update_mission_template
// ─────────────────────────────────────────────────────────────────────────────
server.tool("update_mission_template", "Create or update a mission template by name. " +
    "Each step has a title, description, and optional tags. " +
    "If the template already exists it is overwritten (upsert by name).", {
    name: z.string().describe("Template name — must be unique, e.g. 'issue-resolution-v2'"),
    description: z.string().optional().describe("Human-readable description of the template"),
    steps: z
        .array(z.object({
        title: z.string().describe("Step title"),
        description: z.string().describe("What to do in this step"),
        tags: z.array(z.string()).optional().describe("Optional tags for the step"),
    }))
        .describe("Ordered list of steps — each becomes one task when instantiated"),
    createdBy: creatorSchema.describe("Who is creating/updating the template"),
    isDefault: z.boolean().optional().describe("Mark as the default template for its type"),
}, async ({ name, description, steps, createdBy, isDefault }) => {
    try {
        const templateId = await convex.mutation("missionTemplates:upsert", {
            name,
            description,
            steps,
            createdBy,
            isDefault,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ templateId, name, stepCount: steps.length }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: add_deployment
// ─────────────────────────────────────────────────────────────────────────────
server.tool("add_deployment", "Register a Convex deployment for proactive error monitoring. " +
    "The deployKeyEnvVar must be the name of a Convex environment variable (not the key itself) " +
    "holding the admin deploy key for that deployment. Once registered, the cron polls it every 5 minutes.", {
    name: z
        .string()
        .describe("Short unique name for this deployment — e.g. 'your-deployment-123'"),
    deploymentUrl: z
        .string()
        .describe("Full Convex deployment URL — e.g. 'https://your-deployment-123.convex.cloud'"),
    deployKeyEnvVar: z
        .string()
        .describe("Name of the Convex env var holding the admin deploy key — e.g. 'DEPLOY_KEY_GUINEAPIG'"),
    githubRepo: z
        .string()
        .describe("GitHub repo in 'owner/repo' format where issues will be created — e.g. 'ElPiCorp/vantage-peers'"),
    orchestrator: z
        .string()
        .describe("Orchestrator responsible for this deployment — e.g. 'sigma'"),
}, async ({ name, deploymentUrl, deployKeyEnvVar, githubRepo, orchestrator }) => {
    try {
        const id = await convex.mutation("errorMonitor:addDeployment", {
            name,
            deploymentUrl,
            deployKeyEnvVar,
            githubRepo,
            orchestrator,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ id, name, deploymentUrl, githubRepo, orchestrator }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: remove_deployment
// ─────────────────────────────────────────────────────────────────────────────
server.tool("remove_deployment", "Deactivate a monitored deployment. The deployment record is preserved but polling stops.", {
    name: z
        .string()
        .describe("Name of the deployment to deactivate — e.g. 'your-deployment-123'"),
}, async ({ name }) => {
    try {
        await convex.mutation("errorMonitor:removeDeployment", { name });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ removed: name }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_errors
// ─────────────────────────────────────────────────────────────────────────────
server.tool("list_errors", "List detected errors from monitored deployments, ordered newest first. " +
    "Each entry includes deduplication count and the linked GitHub issue number if one was created.", {
    deployment: z
        .string()
        .optional()
        .describe("Filter to a specific deployment name — omit to list errors across all deployments"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of errors to return (default 50)"),
}, async ({ deployment, limit }) => {
    try {
        const errors = await convex.query("errorMonitor:listErrors", {
            deployment,
            limit: limit ?? 50,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(errors, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_error
// ─────────────────────────────────────────────────────────────────────────────
server.tool("get_error", "Fetch a single error log entry by its Convex document ID, including stack trace and issue linkage.", {
    errorId: z
        .string()
        .describe("Convex document ID of the errorLogs entry"),
}, async ({ errorId }) => {
    try {
        const error = await convex.query("errorMonitor:getError", {
            errorId: errorId,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(error, null, 2),
                },
            ],
        };
    }
    catch (error) {
        return mcpError(error.message ?? String(error));
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// Start server on stdio transport
// ─────────────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
