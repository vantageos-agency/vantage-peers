/**
 * VantagePeers MCP Tool Registrations
 *
 * This module exports registerTools(server, convex) — a single function that
 * registers all 82 tools against any McpServer instance with a given
 * ConvexHttpClient. Both the stdio entry point (server.ts) and the HTTP entry
 * point (server-http.ts) call this function so tool definitions are never
 * duplicated.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkFromAllowed, checkNamespaceRead, checkNamespaceWrite, isMasterScope, } from "./auth.js";
import { wrapToolResult } from "./ui-resources/stream-marker.js";
// ─────────────────────────────────────────────────────────────────────────────
// VP_EMIT_UI_MARKERS gate
//
// When VP_EMIT_UI_MARKERS=1 the 6 list/get tools that have a matching
// ui:// primitive append a __VP_TOOL_RESULT__<json>__END__ marker after the
// existing JSON payload. The Gen UI iframe bridge detects this marker and
// renders the structured primitive inline. Default is OFF so prod behaviour
// is unchanged.
// ─────────────────────────────────────────────────────────────────────────────
const UI_MARKERS_ENABLED = process.env.VP_EMIT_UI_MARKERS === "1" ||
    process.env.VP_EMIT_UI_MARKERS === "true";
/**
 * Append a stream marker to a text response when UI markers are enabled.
 * `buildPayload` is called only when the flag is ON to avoid any overhead.
 */
function appendMarkerIfEnabled(text, buildPayload) {
    if (!UI_MARKERS_ENABLED)
        return text;
    try {
        const payload = buildPayload();
        if (payload === null)
            return text;
        return `${text}\n${wrapToolResult(payload)}`;
    }
    catch {
        // Never break the primary response — marker emission is best-effort.
        return text;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight content size guard
//
// Convex has a 1 MiB HTTP body limit. When MCP tools forward oversized
// `content` arguments, Convex returns an opaque "Server Error" that clients
// cannot interpret. We enforce a conservative 900 KB ceiling client-side so
// the caller receives an explicit InvalidParams error with byte-level detail
// and the recommended remediation (deliverable .md file pattern).
//
// 900,000 bytes ≈ 130,000 French words — far beyond any realistic briefing
// note, diary entry, memory snippet, or component source file. The 148 KB
// of headroom absorbs the JSON framing and other argument overhead before
// Convex's real 1,048,576-byte limit.
// ─────────────────────────────────────────────────────────────────────────────
export const MAX_CONTENT_BYTES = 900_000;
/**
 * Measure a string's UTF-8 byte length and throw an McpError if it exceeds
 * MAX_CONTENT_BYTES. Returns the byte count on success so callers can reuse
 * it for observability in the catch path.
 *
 * @param content   The content string to measure.
 * @param toolName  Caller tool name (used only in the error message).
 */
export function assertContentSize(content, toolName) {
    const contentBytes = new TextEncoder().encode(content).length;
    if (contentBytes > MAX_CONTENT_BYTES) {
        throw new McpError(ErrorCode.InvalidParams, `[${toolName}] Content too large: ${contentBytes} bytes, max ${MAX_CONTENT_BYTES} bytes (~${Math.floor(MAX_CONTENT_BYTES / 6)} words). Use deliverable .md file pattern for large content (commit to repo + reference from ${toolName}).`);
    }
    return contentBytes;
}
// ─────────────────────────────────────────────────────────────────────────────
// List response byte cap (overflow protection for MCP clients)
//
// MCP clients (Claude.ai, ChatGPT, Claude Code) reject tool results that
// exceed their token budget — typical ceiling ~25k tokens ≈ 75 KB JSON.
// When that happens the entire response is lost to a downstream truncation
// error and the user must fall back to reading the on-disk overflow file.
//
// `capListResponseBytes` guards every bulk list_* tool: if the serialized
// payload exceeds MAX_LIST_RESPONSE_BYTES (60 KB), it truncates the items
// array (halving until it fits) and wraps the result in a _meta envelope
// that tells the caller exactly how to refine the query.
//
// 60 KB leaves headroom for tool-call JSON framing and the UI stream marker
// before any MCP client hits its own ceiling. The cap is byte-counted on the
// raw JSON string, not on item count, because content-heavy rows
// (memories / diaries / briefing notes) blow past 30 items easily.
// ─────────────────────────────────────────────────────────────────────────────
export const MAX_LIST_RESPONSE_BYTES = 60_000;
export function capListResponseBytes(items, rawText, toolName, maxBytes = MAX_LIST_RESPONSE_BYTES) {
    const byteLen = Buffer.byteLength(rawText, "utf8");
    if (byteLen <= maxBytes)
        return rawText;
    if (!Array.isArray(items) || items.length === 0)
        return rawText;
    let n = items.length;
    let truncated = items;
    let truncatedText = rawText;
    while (n > 1) {
        n = Math.max(1, Math.floor(n / 2));
        truncated = items.slice(0, n);
        truncatedText = JSON.stringify(truncated, null, 2);
        if (Buffer.byteLength(truncatedText, "utf8") <= maxBytes - 600)
            break;
    }
    const envelope = {
        _meta: {
            _truncated: true,
            _showing: truncated.length,
            _total: items.length,
            _bytesOriginal: byteLen,
            _bytesCap: maxBytes,
            _tool: toolName,
            _advice: `Response exceeded ${maxBytes} bytes. Showing first ${truncated.length}/${items.length}. ` +
                `Pass fields="lite", a smaller limit, stricter filters (status, assignedTo, project, namespace, updatedSince), or paginate.`,
        },
        items: truncated,
    };
    return JSON.stringify(envelope, null, 2);
}
// ─────────────────────────────────────────────────────────────────────────────
// Shared Zod schemas
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Convex document IDs are 32 lowercase alphanumeric characters (a-z0-9).
 * Exported so tests can validate the schema independently of the MCP server.
 */
export const convexIdPattern = /^[a-z0-9]{32}$/;
export const receiptIdSchema = z
    .string()
    .regex(convexIdPattern, "receiptId must be a 32-char lowercase alphanumeric Convex ID");
export const memoryIdSchema = z
    .string()
    .regex(convexIdPattern, "Invalid memory ID format (expected 32-char Convex ID)");
const memoryTypeSchema = z
    .enum(["user", "feedback", "project", "reference", "episode"])
    .describe("Memory classification type");
export const creatorSchema = z
    .string()
    .describe("Orchestrator role name (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, epsilon, omicron, upsilon, laurent, or any custom client role (lowercase string)). " +
    "New internal orchestrators use Greek letters (lowercase); external client orchestrators use free lowercase strings.");
export const severitySchema = z
    .enum(["critical", "major", "minor"])
    .describe("Episode severity — critical = cross-orchestrator lesson");
export const flexArray = z.union([z.array(z.string()), z.string()]);
const flexArrayOptional = flexArray.optional();
// ─────────────────────────────────────────────────────────────────────────────
// update_briefing_note — Zod schema + description
//
// Mirrors `api.briefingNotes.update` Convex mutation. `noteId` is a permissive
// `z.string()` because Convex `v.id("briefingNotes")` enforces the real shape
// server-side (same pattern as `update_task`). `callerOrchestrator` is REQUIRED
// (deny-by-default RBAC per memory j573cwcs3znp0xsvtg34x435jh84b0eg). Arrays
// are FULL REPLACE — to clear, pass an empty array; to keep, omit entirely.
// ─────────────────────────────────────────────────────────────────────────────
export const updateBriefingNoteDescription = "Update an existing briefing note. Partial-update — only provided fields are patched. " +
    "Arrays (decisions, linkedMemoryIds, participants) are FULL REPLACE, not append. " +
    "RBAC : caller must be createdBy or 'system'. " +
    "Sets updatedAt + updatedBy automatically.";
export const updateBriefingNoteSchema = z.object({
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
        .array(memoryIdSchema)
        .optional()
        .describe("Optional new linkedMemoryIds array — full replace, not append. " +
        "DISCLAIMER: Memory IDs only — NOT briefingNotes IDs or any other table. " +
        "Passing a briefingNotes ID causes ArgumentValidationError at path .linkedMemoryIds[N]."),
});
const assigneeSchema = z
    .string()
    .describe("Orchestrator to assign to (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, epsilon, omicron, upsilon, laurent, or any custom client role (lowercase string)). " +
    "New internal orchestrators use Greek letters (lowercase); external client orchestrators use free lowercase strings.");
const prioritySchema = z
    .enum(["urgent", "high", "medium", "low"])
    .describe("Task priority level");
const componentTypeSchema = z
    .enum(["agent", "skill", "hook", "plugin"])
    .describe("Component type");
const taskStatusValues = [
    "todo",
    "in_progress",
    "review",
    "blocked",
    "done",
];
const taskStatusAliases = ["open", "active", "all"];
export const taskStatusSchema = z
    .enum(taskStatusValues)
    .describe("Task status");
const missionStatusValues = [
    "brainstorm",
    "plan",
    "execute",
    "validate",
    "complete",
];
const missionStatusAliases = ["open", "active", "all"];
export const missionStatusSchema = z
    .enum(missionStatusValues)
    .describe("Mission lifecycle status");
// v2.3.2 — filter-only schemas: expose status aliases ("open"/"active"/"all")
// AND multi-status arrays to the MCP client. Backend (convex/tasks.ts +
// convex/missions.ts) handles alias expansion + array validation.
// Aliases NOT allowed inside arrays (matches backend rejection).
export const taskStatusFilterSchema = z
    .union([
    z.enum([...taskStatusValues, ...taskStatusAliases]),
    z.array(z.enum(taskStatusValues)).min(1),
])
    .describe('Task status filter. Single status ("todo"|"in_progress"|"review"|"blocked"|"done"), ' +
    'alias ("open" = todo+in_progress+review+blocked, "active" = todo+in_progress, "all" = no filter), ' +
    "or array of direct statuses (no aliases inside array).");
export const missionStatusFilterSchema = z
    .union([
    z.enum([...missionStatusValues, ...missionStatusAliases]),
    z.array(z.enum(missionStatusValues)).min(1),
])
    .describe('Mission status filter. Single status ("brainstorm"|"plan"|"execute"|"validate"|"complete"), ' +
    'alias ("open" = brainstorm+plan+execute+validate, "active" = plan+execute, "all" = no filter), ' +
    "or array of direct statuses (no aliases inside array).");
// v2.3.2 — fields projection toggle. "lite" returns compact projection
// (5-10× smaller payload), "full" (default) returns full doc.
export const fieldsSchema = z
    .enum(["lite", "full"])
    .describe('Field projection — "lite" returns compact fields only ' +
    "(typical 5-10× smaller payload for large list scans), " +
    '"full" (default) returns the full document.');
// v2.3.3 — Unix timestamp ms filter for "updated since".
// Pass `Date.now() - 24*60*60*1000` for "last 24h" pattern.
export const updatedSinceSchema = z
    .number()
    .int()
    .positive()
    .describe("Unix timestamp (ms) — return only rows whose updatedAt >= this value. " +
    "Typical usage: Date.now() - 24*60*60*1000 for last-24h window.");
const mandateStatusSchema = z
    .enum(["requested", "accepted", "in_progress", "delivered", "settled"])
    .describe("Mandate lifecycle status");
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
// Helper: normalize string|array inputs to array
// ─────────────────────────────────────────────────────────────────────────────
function toArray(val) {
    if (val === undefined)
        return undefined;
    if (Array.isArray(val)) {
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
// ─────────────────────────────────────────────────────────────────────────────
// Helper: structured error response
// ─────────────────────────────────────────────────────────────────────────────
function mcpError(message) {
    return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
    };
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
export function parseConvexError(rawMessage) {
    // Known Convex validation/runtime error codes surfaced as plaintext
    const knownCodes = [
        "ArgumentValidationError",
        "AuthorizationError",
        "ConvexError",
        "SchemaValidationError",
        "QueryError",
        "MutationError",
        "ActionError",
    ];
    // Strip the [CONVEX M(path)] / [CONVEX Q(path)] prefix if present
    const stripped = rawMessage.replace(/^\[CONVEX [A-Z]+\([^\]]*\)\]\s*/, "");
    // Detect the error code
    let code = "ServerError";
    let remainder = stripped;
    for (const candidate of knownCodes) {
        if (stripped.startsWith(candidate + ":") ||
            stripped.startsWith(candidate + " ")) {
            code = candidate;
            remainder = stripped.slice(candidate.length).replace(/^[:\s]+/, "");
            break;
        }
    }
    // Extract "Path: .<fieldPath>" from the tail of the message
    // Convex appends this as the last sentence: "Path: .linkedMemoryIds[4]"
    let path = null;
    const pathMatch = remainder.match(/\bPath:\s*([\w.[\]"']+)\s*$/);
    if (pathMatch) {
        path = pathMatch[1];
        remainder = remainder
            .slice(0, pathMatch.index)
            .trim()
            .replace(/\.\s*$/, "");
    }
    // Build a concise hint for common patterns
    let hint = null;
    if (code === "ArgumentValidationError") {
        const tableMatch = remainder.match(/from table (\w+),.*validator v\.id\("(\w+)"\)/);
        if (tableMatch) {
            hint = `ID belongs to table "${tableMatch[1]}" but validator expects v.id("${tableMatch[2]}"). Check that you are passing the correct document ID from the "${tableMatch[2]}" table.`;
        }
    }
    return { code, message: remainder || rawMessage, path, hint };
}
/**
 * Produce a structured MCP error response for any error thrown by a Convex
 * operation. For ConvexError / ArgumentValidationError the response body
 * contains a JSON object with { code, message, path, hint } so the MCP client
 * can display actionable diagnostics instead of a bare "Server Error" string.
 *
 * For unrecognised errors the response falls back to the plain text format
 * used by `mcpError`.
 */
export function mcpConvexError(error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const parsed = parseConvexError(rawMessage);
    // For ArgumentValidationError and other known Convex codes, return structured JSON
    if (parsed.code !== "ServerError") {
        const payload = {
            code: parsed.code,
            message: parsed.message,
        };
        if (parsed.path !== null)
            payload.path = parsed.path;
        if (parsed.hint !== null)
            payload.hint = parsed.hint;
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(payload, null, 2),
                },
            ],
            isError: true,
        };
    }
    // Fallback: generic error, preserve existing plain-text format
    return {
        content: [{ type: "text", text: `Error: ${rawMessage}` }],
        isError: true,
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// Main export: register all tools against a server + convex client pair
// ─────────────────────────────────────────────────────────────────────────────
export function registerTools(server, convex, oauthCtx) {
    // ── scope guards (no-op when oauthCtx is undefined — legacy bearer path) ────
    const guardFrom = (from) => {
        const err = checkFromAllowed(oauthCtx, from);
        return err ? mcpError(err) : null;
    };
    const guardRead = (namespace) => {
        const err = checkNamespaceRead(oauthCtx, namespace);
        return err ? mcpError(err) : null;
    };
    const guardWrite = (namespace) => {
        const err = checkNamespaceWrite(oauthCtx, namespace);
        return err ? mcpError(err) : null;
    };
    // Some tools take no identity/namespace arg (e.g. soft_delete_memory only
    // takes an ID). When the underlying mutation cannot enforce per-resource
    // RBAC, we restrict the whole tool to master scope. Legacy bearer
    // (oauthCtx=undefined) and master-scope both pass through.
    const guardMasterOnly = (toolName) => {
        if (!oauthCtx)
            return null;
        if (isMasterScope(oauthCtx))
            return null;
        return mcpError(`Forbidden: ${toolName} requires master scope (current: ${oauthCtx.scopeProfile}).`);
    };
    // ── store_memory ────────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Store memory",
    }, async ({ namespace, type, content, createdBy, relatesTo, ttl }) => {
        let contentBytes = 0;
        try {
            contentBytes = assertContentSize(content, "store_memory");
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
            const nsDenied = guardWrite(namespace);
            if (nsDenied)
                return nsDenied;
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
            if (error instanceof McpError)
                throw error;
            console.error("[store_memory] mutation failed", {
                contentBytes,
                namespace,
                type,
                createdBy,
                errorMessage: error?.message ?? String(error),
            });
            return mcpError(error.message ?? String(error));
        }
    });
    // ── soft_delete_memory ──────────────────────────────────────────────────────
    server.tool("soft_delete_memory", "Soft-delete a memory — marks it as no longer latest so it stops appearing in recall results. " +
        "The memory is preserved for audit but excluded from search.", {
        memoryId: z
            .string()
            .describe("Convex document ID of the memory to soft-delete"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        title: "Delete memory (soft)",
    }, async ({ memoryId }) => {
        try {
            const denied = guardMasterOnly("soft_delete_memory");
            if (denied)
                return denied;
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
    // ── get_memory ──────────────────────────────────────────────────────────────
    server.tool("get_memory", "Fetch a single memory by its ID. Returns full memory content including relations and episode data.", {
        memoryId: z.string().describe("Memory document ID"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Get memory",
    }, async ({ memoryId }) => {
        try {
            const _scopeDenied = guardMasterOnly("get_memory");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── recall ──────────────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Recall memories",
    }, async ({ query, namespace, type, limit }) => {
        try {
            const nsDenied = guardRead(namespace);
            if (nsDenied)
                return nsDenied;
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
    // ── text_search ─────────────────────────────────────────────────────────────
    server.tool("text_search", "BM25 full-text keyword search over memories. Use for exact keyword matching when semantic recall isn't specific enough.", {
        query: z.string().describe("Search query text"),
        namespace: z
            .string()
            .optional()
            .describe("Namespace filter (e.g. 'global', 'project/my-project')"),
        type: memoryTypeSchema.optional().describe("Filter by memory type"),
        limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(10)
            .describe("Max results"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Search memories (text)",
    }, async ({ query, namespace, type, limit }) => {
        try {
            const nsDenied = guardRead(namespace);
            if (nsDenied)
                return nsDenied;
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
    // ── hybrid_search ───────────────────────────────────────────────────────────
    server.tool("hybrid_search", "Combined vector + BM25 search using Reciprocal Rank Fusion (RRF). Best of both worlds: semantic understanding + keyword precision.", {
        query: z.string().describe("Search query text"),
        namespace: z.string().optional().describe("Namespace filter"),
        type: memoryTypeSchema.optional().describe("Filter by memory type"),
        limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .default(10)
            .describe("Max results"),
        vectorWeight: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Weight for vector results in RRF (default: 0.5)"),
        textWeight: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Weight for text results in RRF (default: 0.5)"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Search memories (hybrid)",
    }, async ({ query, namespace, type, limit, vectorWeight, textWeight }) => {
        try {
            const nsDenied = guardRead(namespace);
            if (nsDenied)
                return nsDenied;
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
    // ── store_episode ───────────────────────────────────────────────────────────
    server.tool("store_episode", "Store an episodic memory with structured context/goal/action/outcome/insight fields. " +
        "Episodes are the 'other half' of memory — not just facts, but what happened and what was learned. " +
        "Use severity=critical for lessons that should be shared across all orchestrators.", {
        namespace: z
            .string()
            .describe("Memory namespace — e.g. 'orchestrator/pi'"),
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Store episode",
    }, async ({ namespace, createdBy, context, goal, action, outcome, insight, severity, }) => {
        try {
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
            const nsDenied = guardWrite(namespace);
            if (nsDenied)
                return nsDenied;
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
    // ── get_profile ─────────────────────────────────────────────────────────────
    server.tool("get_profile", "Fetch an orchestrator profile (static identity + dynamic session state). " +
        "Returns null if the profile does not exist yet — call update_profile to create it.", {
        orchestratorId: z.string().describe("Orchestrator identifier"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Get orchestrator profile",
    }, async ({ orchestratorId }) => {
        try {
            const _scopeDenied = guardMasterOnly("get_profile");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── update_profile ──────────────────────────────────────────────────────────
    server.tool("update_profile", "Create or update an orchestrator profile. Provide only the fields you want to change. " +
        "static fields are stable identity facts (role, workspace, capabilities). " +
        "dynamic fields are mutable session state (currentTask, lastSeen, sessionCount).", {
        orchestratorId: z.string().describe("Orchestrator identifier"),
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update orchestrator profile",
    }, async ({ orchestratorId, name, static: staticFields, dynamic }) => {
        try {
            const fromDenied = guardFrom(orchestratorId);
            if (fromDenied)
                return fromDenied;
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
    // ── list_memories ───────────────────────────────────────────────────────────
    server.tool("list_memories", "List active memories for a namespace, ordered newest first. " +
        "Only returns isLatest=true memories (superseded memories are excluded by default). " +
        "Use type to filter to a specific memory category.", {
        namespace: z
            .string()
            .describe("Namespace to list memories from — e.g. 'global', 'orchestrator/pi'"),
        type: memoryTypeSchema
            .optional()
            .describe("Filter to a specific type — omit to return all types"),
        createdBy: assigneeSchema
            .optional()
            .describe("Filter by creator/orchestrator role — mirrors list_tasks pattern for cross-tool consistency."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .default(20)
            .describe("Maximum number of memories to return (default 20)"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List memories",
    }, async ({ namespace, type, createdBy, limit }) => {
        try {
            const nsDenied = guardRead(namespace);
            if (nsDenied)
                return nsDenied;
            const memories = await convex.query("memories:listMemories", {
                namespace,
                type,
                createdBy,
                limit: limit ?? 20,
            });
            const rawList = Array.isArray(memories)
                ? memories
                : Array.isArray(memories?.page)
                    ? memories.page
                    : [];
            const baseText = capListResponseBytes(memories, JSON.stringify(memories, null, 2), "list_memories");
            const text = appendMarkerIfEnabled(baseText, () => ({
                kind: "memory-quote",
                items: rawList.map((m) => ({
                    _id: m._id,
                    namespace: m.namespace,
                    type: m.type,
                    content: m.content,
                    score: m.score,
                })),
            }));
            return {
                content: [{ type: "text", text }],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── send_message ────────────────────────────────────────────────────────────
    server.tool("send_message", "Send a message to one, many, or all orchestrators. " +
        "channel: 'broadcast' = all, 'tau' = role DM, 'pi-vps' = instance DM, 'tau,phi' = multi. " +
        "Creates message + one receipt per recipient. Replaces claude-peers send_message.", {
        from: creatorSchema.describe("Sender role (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, epsilon, omicron, upsilon, or any custom role)"),
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Send message",
    }, async ({ from, fromInstanceId, channel, content, sessionDay, tenantId, }) => {
        let contentBytes = 0;
        try {
            contentBytes = assertContentSize(content, "send_message");
            const fromDenied = guardFrom(from);
            if (fromDenied)
                return fromDenied;
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
            if (error instanceof McpError)
                throw error;
            console.error("[send_message] mutation failed", {
                contentBytes,
                from,
                channel,
                errorMessage: error?.message ?? String(error),
            });
            return mcpError(error.message ?? String(error));
        }
    });
    // ── check_messages ──────────────────────────────────────────────────────────
    server.tool("check_messages", "Check for unread messages. Returns messages with receiptIds for marking as read. " +
        "If recipientInstanceId is provided, returns instance-targeted + role-level messages. " +
        "Replaces claude-peers check_messages.", {
        recipient: creatorSchema.describe("Orchestrator role (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, epsilon, omicron, upsilon, or any custom role)"),
        recipientInstanceId: z
            .string()
            .optional()
            .describe("Instance ID — e.g. 'pi-chromebook'. Gets instance + role messages."),
        tenantId: z
            .string()
            .optional()
            .describe("Filter messages to this tenant only"),
        since: z
            .number()
            .int()
            .optional()
            .describe("Unix timestamp (ms). If provided, only messages with _creationTime > since are returned. Use for incremental polling — pass the timestamp of your last check to get only new messages. Omit for full unread backlog."),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Check messages",
    }, async ({ recipient, recipientInstanceId, tenantId, since }) => {
        try {
            // Non-master: force recipient to caller's own userId. Anything else
            // would let the client read another tenant's inbox.
            if (oauthCtx && !isMasterScope(oauthCtx)) {
                if (recipient !== oauthCtx.userId) {
                    return mcpError(`Forbidden: check_messages can only read messages for your own identity ('${oauthCtx.userId}'), not '${recipient}'.`);
                }
            }
            const messages = await convex.query("messages:checkNewMessages", {
                recipient,
                recipientInstanceId,
                tenantId,
                since,
            });
            if (messages.length === 0) {
                return {
                    content: [{ type: "text", text: "No new messages." }],
                };
            }
            const payload = messages.map((m) => ({
                receiptId: m.receiptId,
                from: m.from,
                fromInstanceId: m.fromInstanceId,
                channel: m.channel,
                content: m.content,
                createdAt: m.createdAt,
            }));
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(payload, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── mark_as_read ────────────────────────────────────────────────────────────
    server.tool("mark_as_read", "Mark one or more message receipts as read. Pass the receiptIds from check_messages.", {
        receiptIds: z
            .union([z.array(receiptIdSchema).min(1), receiptIdSchema])
            .describe("Receipt IDs to mark as read — array or single string"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Mark messages as read",
    }, async ({ receiptIds }) => {
        try {
            let receiptIdsArray;
            if (Array.isArray(receiptIds)) {
                receiptIdsArray = receiptIds;
            }
            else if (typeof receiptIds === "string" &&
                receiptIds.startsWith("[")) {
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
    // ── delete_message ──────────────────────────────────────────────────────────
    server.tool("delete_message", "Delete a message and all its receipts. Only the sender (or system) can delete a message.", {
        messageId: z
            .string()
            .describe("Convex document ID of the message to delete"),
        callerOrchestrator: creatorSchema
            .optional()
            .describe("Optional RBAC — must be the sender or system"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        title: "Delete message",
    }, async ({ messageId, callerOrchestrator }) => {
        try {
            if (callerOrchestrator) {
                const fromDenied = guardFrom(callerOrchestrator);
                if (fromDenied)
                    return fromDenied;
            }
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
    // ── set_summary ─────────────────────────────────────────────────────────────
    server.tool("set_summary", "Set a brief summary of what you are currently working on. " +
        "Visible to other orchestrators via list_peers. Uses the profiles table. " +
        "Provide instanceId to register as a specific instance (e.g. 'pi-chromebook').", {
        orchestratorId: z.string().describe("Orchestrator role"),
        instanceId: z
            .string()
            .optional()
            .describe("Instance ID — e.g. 'pi-chromebook', 'pi-vps', 'tau-vps-1'"),
        summary: z.string().describe("1-2 sentence summary of current work"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Set instance summary",
    }, async ({ orchestratorId, instanceId, summary }) => {
        try {
            const fromDenied = guardFrom(orchestratorId);
            if (fromDenied)
                return fromDenied;
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
    // ── list_peers ──────────────────────────────────────────────────────────────
    server.tool("list_peers", "List all orchestrator profiles with their current status and summary. " +
        "Replaces claude-peers list_peers.", {}, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List peers",
    }, async () => {
        try {
            const _scopeDenied = guardMasterOnly("list_peers");
            if (_scopeDenied)
                return _scopeDenied;
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
                        text: capListResponseBytes(peers, JSON.stringify(peers, null, 2), "list_peers"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── list_messages ───────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List messages",
    }, async ({ sessionDay, from, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_messages");
            if (_scopeDenied)
                return _scopeDenied;
            const messages = await convex.query("messages:listMessages", {
                sessionDay,
                from,
                limit: limit ?? 100,
            });
            const baseText = capListResponseBytes(messages, JSON.stringify(messages, null, 2), "list_messages");
            const text = appendMarkerIfEnabled(baseText, () => ({
                kind: "messages-feed",
                items: Array.isArray(messages)
                    ? messages.map((m) => ({
                        _id: m._id,
                        from: m.from,
                        channel: m.channel,
                        content: m.content,
                        createdAt: m.createdAt,
                    }))
                    : [],
            }));
            return {
                content: [{ type: "text", text }],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── list_broadcast_status ───────────────────────────────────────────────────
    server.tool("list_broadcast_status", "Show who read a broadcast message and who didn't. Pass the messageId from send_message.", {
        messageId: z
            .string()
            .describe("Convex document ID of the broadcast message"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List broadcast status",
    }, async ({ messageId }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_broadcast_status");
            if (_scopeDenied)
                return _scopeDenied;
            const status = await convex.query("messages:listBroadcastStatus", {
                messageId,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: capListResponseBytes(status, JSON.stringify(status, null, 2), "list_broadcast_status"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── create_task ─────────────────────────────────────────────────────────────
    server.tool("create_task", "Create a task in VantagePeers. Tasks are assigned to an orchestrator " +
        "with priority and status tracking. Optionally link to a project or mission.", {
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Detailed task description"),
        project: z
            .string()
            .optional()
            .describe("Project name — e.g. 'vantage-starter', 'perfect-ai-agent'"),
        tags: flexArrayOptional.describe("Optional tags for categorization"),
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Create task",
    }, async ({ title, description, project, tags, assignedTo, assignedToInstance, priority, status, dependsOn, missionId, estimatedMinutes, dueDate, createdBy, }) => {
        try {
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
            const assigneeDenied = guardFrom(assignedTo);
            if (assigneeDenied)
                return assigneeDenied;
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
    // ── list_tasks ──────────────────────────────────────────────────────────────
    server.tool("list_tasks", "List tasks from VantagePeers with optional filters. " +
        "Filter by assignee, instance, status, and/or project. Returns newest first.", {
        assignedTo: assigneeSchema.optional().describe("Filter by assignee"),
        assignedToInstance: z
            .string()
            .optional()
            .describe("Filter by instance — e.g. 'pi-vps'. Returns only tasks assigned to that instance."),
        status: taskStatusFilterSchema
            .optional()
            .describe("Filter by status (single, alias, or array)"),
        project: z.string().optional().describe("Filter by project name"),
        limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Maximum number of tasks to return. Default 50 with fields=lite, auto-clamped to 30 when fields=full and no explicit limit (overflow protection)."),
        fields: fieldsSchema
            .optional()
            .describe('Field projection ("lite"|"full")'),
        createdBy: assigneeSchema
            .optional()
            .describe("Filter by task creator (e.g. 'pi' to find Pi-dispatched tasks)"),
        updatedSince: updatedSinceSchema.optional(),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List tasks",
    }, async ({ assignedTo, assignedToInstance, status, project, limit, fields, createdBy, updatedSince, }) => {
        try {
            // Non-master: must scope to own identity. If neither assignedTo
            // nor createdBy matches the caller's userId, reject — otherwise
            // the query would span the whole tenant table.
            if (oauthCtx && !isMasterScope(oauthCtx)) {
                const myId = oauthCtx.userId;
                const scopedToSelf = assignedTo === myId || createdBy === myId;
                if (!scopedToSelf) {
                    return mcpError(`Forbidden: list_tasks requires assignedTo='${myId}' or createdBy='${myId}' for non-master scope (current: ${oauthCtx.scopeProfile}).`);
                }
            }
            const tasks = await convex.query("tasks:list", {
                assignedTo,
                assignedToInstance,
                status,
                project,
                limit,
                fields,
                createdBy,
                updatedSince,
            });
            const baseText = capListResponseBytes(tasks, JSON.stringify(tasks, null, 2), "list_tasks");
            const text = appendMarkerIfEnabled(baseText, () => ({
                kind: "tasks-table",
                items: Array.isArray(tasks)
                    ? tasks.map((t) => ({
                        _id: t._id,
                        title: t.title,
                        status: t.status,
                        priority: t.priority,
                        assignedTo: t.assignedTo,
                        _creationTime: t._creationTime,
                    }))
                    : [],
            }));
            return {
                content: [{ type: "text", text }],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── update_task ─────────────────────────────────────────────────────────────
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
        actualMinutes: z
            .number()
            .optional()
            .describe("Actual duration in minutes"),
        startedAt: z.number().optional().describe("When work started (Unix ms)"),
        completedAt: z
            .number()
            .optional()
            .describe("When work completed (Unix ms)"),
        dueDate: z.number().optional().describe("New due date (Unix ms)"),
        callerOrchestrator: creatorSchema
            .optional()
            .describe("Optional RBAC — if provided, must be creator or assignee"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update task",
    }, async ({ taskId, title, description, project, tags, assignedTo, priority, status, dependsOn, missionId, estimatedMinutes, actualMinutes, startedAt, completedAt, dueDate, callerOrchestrator, }) => {
        try {
            if (callerOrchestrator) {
                const fromDenied = guardFrom(callerOrchestrator);
                if (fromDenied)
                    return fromDenied;
            }
            if (assignedTo) {
                const assigneeDenied = guardFrom(assignedTo);
                if (assigneeDenied)
                    return assigneeDenied;
            }
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
    // ── complete_task ───────────────────────────────────────────────────────────
    server.tool("complete_task", "Mark a task as done. ALWAYS provide a completionNote describing what was actually done. " +
        "This is mandatory — never complete a task without explaining the work. " +
        "After completing, ALWAYS send_message to the task creator (check createdBy field) with a summary of what was done.", {
        taskId: z.string().describe("Convex document ID of the task to complete"),
        completionNote: z
            .string()
            .describe("What was actually done — summary of work completed"),
        callerOrchestrator: creatorSchema
            .optional()
            .describe("Optional RBAC — if provided, must be creator or assignee"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Complete task",
    }, async ({ taskId, completionNote, callerOrchestrator }) => {
        try {
            if (callerOrchestrator) {
                const fromDenied = guardFrom(callerOrchestrator);
                if (fromDenied)
                    return fromDenied;
            }
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
    // ── start_task ──────────────────────────────────────────────────────────────
    server.tool("start_task", "Start a task — sets status to in_progress and records startedAt timestamp. " +
        "Use this when beginning work on a task to enable automatic duration tracking.", {
        taskId: z.string().describe("Convex document ID of the task to start"),
        callerOrchestrator: creatorSchema
            .optional()
            .describe("Optional RBAC — if provided, must be creator or assignee"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Start task",
    }, async ({ taskId, callerOrchestrator }) => {
        try {
            if (callerOrchestrator) {
                const fromDenied = guardFrom(callerOrchestrator);
                if (fromDenied)
                    return fromDenied;
            }
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
    // ── checkout_task ───────────────────────────────────────────────────────────
    server.tool("checkout_task", "Atomically claim a task. Only succeeds if task is in 'todo' status — prevents two orchestrators " +
        "from claiming the same task. Returns {claimed: true} or {claimed: false, reason: '...'}.", {
        taskId: z.string().describe("Convex document ID of the task to claim"),
        callerOrchestrator: creatorSchema.describe("Orchestrator claiming the task (e.g. sigma, pi)"),
        callerInstance: z
            .string()
            .optional()
            .describe("Instance identifier, e.g. 'sigma-vps'"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Checkout task",
    }, async ({ taskId, callerOrchestrator, callerInstance }) => {
        try {
            const fromDenied = guardFrom(callerOrchestrator);
            if (fromDenied)
                return fromDenied;
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
    // ── delete_task ─────────────────────────────────────────────────────────────
    server.tool("delete_task", "Permanently delete a task. Only the creator (or system) can delete.", {
        taskId: z.string().describe("Convex document ID of the task to delete"),
        callerOrchestrator: creatorSchema
            .optional()
            .describe("Optional RBAC — must be creator or system"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        title: "Delete task",
    }, async ({ taskId, callerOrchestrator }) => {
        try {
            if (callerOrchestrator) {
                const fromDenied = guardFrom(callerOrchestrator);
                if (fromDenied)
                    return fromDenied;
            }
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
    // ── block_task ──────────────────────────────────────────────────────────────
    server.tool("block_task", "Mark a task as blocked with an optional reason. Sets status to 'blocked' and records the blocker description.", {
        taskId: z.string().describe("Convex document ID of the task to block"),
        reason: z.string().optional().describe("Why the task is blocked"),
        blockedBy: z
            .array(z.string())
            .optional()
            .describe("Task IDs that are blocking this task"),
        callerOrchestrator: creatorSchema
            .optional()
            .describe("Optional RBAC — must be creator or assignee"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        title: "Block task",
    }, async ({ taskId, reason, blockedBy, callerOrchestrator }) => {
        try {
            if (callerOrchestrator) {
                const fromDenied = guardFrom(callerOrchestrator);
                if (fromDenied)
                    return fromDenied;
            }
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
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ taskId, status: "blocked", reason }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── add_task_dependency ─────────────────────────────────────────────────────
    server.tool("add_task_dependency", "Add a dependency to a task. The task cannot start until all dependencies are complete. " +
        "Pass the IDs of tasks that must complete before this one can begin.", {
        taskId: z
            .string()
            .describe("Convex document ID of the task that depends on others"),
        dependsOn: z
            .array(z.string())
            .describe("Task IDs that must complete first"),
        callerOrchestrator: creatorSchema
            .optional()
            .describe("Optional RBAC — must be creator or assignee"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Add task dependency",
    }, async ({ taskId, dependsOn, callerOrchestrator }) => {
        try {
            if (callerOrchestrator) {
                const fromDenied = guardFrom(callerOrchestrator);
                if (fromDenied)
                    return fromDenied;
            }
            const updateArgs = {
                taskId: taskId,
                dependsOn: dependsOn.map((id) => id),
            };
            if (callerOrchestrator)
                updateArgs.callerOrchestrator = callerOrchestrator;
            await convex.mutation("tasks:update", updateArgs);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ taskId, dependsOn, updated: true }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── list_tasks_by_mission ───────────────────────────────────────────────────
    server.tool("list_tasks_by_mission", "List all tasks linked to a specific mission. Optionally filter by status.", {
        missionId: z.string().describe("Convex document ID of the mission"),
        status: taskStatusFilterSchema
            .optional()
            .describe("Filter by task status (single, alias, or array)"),
        limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Maximum number of tasks to return. Default 50 with fields=lite, auto-clamped to 30 when fields=full and no explicit limit."),
        fields: fieldsSchema
            .optional()
            .describe('Field projection ("lite"|"full")'),
        createdBy: assigneeSchema.optional().describe("Filter by task creator"),
        updatedSince: updatedSinceSchema.optional(),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List tasks by mission",
    }, async ({ missionId, status, limit, fields, createdBy, updatedSince }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_tasks_by_mission");
            if (_scopeDenied)
                return _scopeDenied;
            const tasks = await convex.query("tasks:listByMission", {
                missionId: missionId,
                status,
                limit,
                fields,
                createdBy,
                updatedSince,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: capListResponseBytes(tasks, JSON.stringify(tasks, null, 2), "list_tasks_by_mission"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── create_mission ──────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Create mission",
    }, async ({ name, description, project, status, priority, pilot, agents, brief, startDate, targetDate, progress, createdBy, }) => {
        try {
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
            const pilotDenied = guardFrom(pilot);
            if (pilotDenied)
                return pilotDenied;
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
    // ── list_missions ───────────────────────────────────────────────────────────
    server.tool("list_missions", "List missions from VantagePeers with optional filters. " +
        "Filter by project, pilot, and/or status. Returns newest first.", {
        project: z.string().optional().describe("Filter by project name"),
        pilot: creatorSchema.optional().describe("Filter by pilot orchestrator"),
        status: missionStatusFilterSchema
            .optional()
            .describe("Filter by status (single, alias, or array)"),
        limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Maximum number of missions to return. Default 50 with fields=lite, auto-clamped to 30 when fields=full and no explicit limit."),
        fields: fieldsSchema
            .optional()
            .describe('Field projection ("lite"|"full")'),
        updatedSince: updatedSinceSchema.optional(),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List missions",
    }, async ({ project, pilot, status, limit, fields, updatedSince }) => {
        try {
            // Non-master: must pilot=<own-userId>. Otherwise the query spans
            // every tenant's missions.
            if (oauthCtx && !isMasterScope(oauthCtx)) {
                if (pilot !== oauthCtx.userId) {
                    return mcpError(`Forbidden: list_missions requires pilot='${oauthCtx.userId}' for non-master scope (current: ${oauthCtx.scopeProfile}).`);
                }
            }
            const missions = await convex.query("missions:list", {
                project,
                pilot,
                status,
                limit,
                fields,
                updatedSince,
            });
            const baseText = capListResponseBytes(missions, JSON.stringify(missions, null, 2), "list_missions");
            const text = appendMarkerIfEnabled(baseText, () => ({
                kind: "mission-timeline",
                items: Array.isArray(missions)
                    ? missions.map((m) => ({
                        _id: m._id,
                        name: m.name,
                        project: m.project,
                        status: m.status,
                        pilot: m.pilot,
                        priority: m.priority,
                        progress: m.progress,
                    }))
                    : [],
            }));
            return {
                content: [{ type: "text", text }],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── get_mission ─────────────────────────────────────────────────────────────
    server.tool("get_mission", "Fetch a single mission by ID. Returns full mission details including status, pilot, agents, progress, and dates.", {
        missionId: z.string().describe("Convex document ID of the mission"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Get mission",
    }, async ({ missionId }) => {
        try {
            const _scopeDenied = guardMasterOnly("get_mission");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── update_mission ──────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update mission",
    }, async ({ missionId, name, description, project, status, priority, pilot, agents, brief, startDate, targetDate, progress, }) => {
        try {
            if (pilot) {
                const pilotDenied = guardFrom(pilot);
                if (pilotDenied)
                    return pilotDenied;
            }
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
    // ── update_mission_status ───────────────────────────────────────────────────
    server.tool("update_mission_status", "Change a mission's status. Shortcut for updating only the status field.", {
        missionId: z.string().describe("Convex document ID of the mission"),
        status: missionStatusSchema.describe("New status"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update mission status",
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
    // ── write_diary ─────────────────────────────────────────────────────────────
    server.tool("write_diary", "Write or update a diary entry for a specific date and orchestrator. " +
        "If an entry already exists for that date+orchestrator, it will be updated (upsert).", {
        date: z.string().describe("ISO date string — e.g. '2026-03-25'"),
        orchestrator: creatorSchema.describe("Which orchestrator is writing"),
        content: z.string().describe("Full diary entry content"),
        highlights: flexArrayOptional.describe("Key highlights of the day"),
        blockers: flexArrayOptional.describe("Blockers encountered"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Write diary entry",
    }, async ({ date, orchestrator, content, highlights, blockers }) => {
        let contentBytes = 0;
        try {
            contentBytes = assertContentSize(content, "write_diary");
            const fromDenied = guardFrom(orchestrator);
            if (fromDenied)
                return fromDenied;
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
            if (error instanceof McpError)
                throw error;
            console.error("[write_diary] mutation failed", {
                contentBytes,
                date,
                orchestrator,
                errorMessage: error?.message ?? String(error),
            });
            return mcpError(error.message ?? String(error));
        }
    });
    // ── get_diary ───────────────────────────────────────────────────────────────
    server.tool("get_diary", "Fetch a diary entry for a specific date and orchestrator. Returns null if no entry exists.", {
        date: z.string().describe("ISO date string — e.g. '2026-03-25'"),
        orchestrator: creatorSchema.describe("Which orchestrator's diary to fetch"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Get diary entry",
    }, async ({ date, orchestrator }) => {
        try {
            const _scopeDenied = guardMasterOnly("get_diary");
            if (_scopeDenied)
                return _scopeDenied;
            const entry = await convex.query("diary:get", {
                date,
                orchestrator,
            });
            const baseText = JSON.stringify(entry, null, 2);
            const text = appendMarkerIfEnabled(baseText, () => {
                if (!entry)
                    return null;
                return {
                    kind: "diary-entry",
                    item: {
                        _id: entry._id,
                        date: entry.date,
                        orchestrator: entry.orchestrator,
                        content: entry.content,
                        highlights: entry.highlights,
                        blockers: entry.blockers,
                    },
                };
            });
            return {
                content: [{ type: "text", text }],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── list_diaries ────────────────────────────────────────────────────────────
    server.tool("list_diaries", "List diary entries, optionally filtered by orchestrator. Returns newest first.", {
        orchestrator: creatorSchema
            .optional()
            .describe("Filter to a specific orchestrator — omit for all"),
        createdBy: assigneeSchema
            .optional()
            .describe("Filter by creator/orchestrator role — alias of `orchestrator` for cross-tool consistency (mirrors list_tasks pattern). If both are passed, `createdBy` wins."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .default(20)
            .describe("Maximum entries to return (default 20)"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List diary entries",
    }, async ({ orchestrator, createdBy, limit }) => {
        try {
            // createdBy is an alias of orchestrator (diary's author field). If both set, createdBy wins.
            const effectiveOrchestrator = createdBy ?? orchestrator;
            // Non-master: must scope to own orchestrator id.
            if (oauthCtx && !isMasterScope(oauthCtx)) {
                if (effectiveOrchestrator !== oauthCtx.userId) {
                    return mcpError(`Forbidden: list_diaries requires orchestrator='${oauthCtx.userId}' for non-master scope (current: ${oauthCtx.scopeProfile}).`);
                }
            }
            const entries = await convex.query("diary:list", {
                orchestrator: effectiveOrchestrator,
                limit: limit ?? 20,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: capListResponseBytes(entries, JSON.stringify(entries, null, 2), "list_diaries"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── create_briefing_note ────────────────────────────────────────────────────
    server.tool("create_briefing_note", "Create a briefing note — a structured record of a topic discussion, with participants, " +
        "content, optional decisions, and optional links to existing memories. " +
        "linkedMemoryIds MUST contain IDs from the memories table only — NOT briefingNotes IDs or IDs from any other table. " +
        "IMPORTANT: If you need to cross-link briefing notes together, use linkedBriefingIds (not yet shipped) — " +
        "passing a briefingNotes document ID into linkedMemoryIds will produce an ArgumentValidationError at the Convex validator boundary.", {
        title: z.string().describe("Briefing note title"),
        topic: z
            .string()
            .describe("Topic category — e.g. 'architecture', 'revenue', 'product'"),
        participants: z
            .union([z.array(z.string()), z.string()])
            .describe("Who participated — e.g. ['pi', 'sigma'] or 'pi'"),
        content: z.string().describe("Full briefing content"),
        decisions: flexArrayOptional.describe("Decisions made during the briefing"),
        linkedMemoryIds: z
            .array(memoryIdSchema)
            .optional()
            .describe("Convex document IDs of related memories — each must be a 32-char ID from the memories table, NOT briefingNotes or any other table. " +
            "DISCLAIMER: Memory IDs only. Do NOT pass briefingNotes IDs here — they share the same 32-char alphanumeric format but belong to a different table. " +
            "Passing a briefingNotes ID will fail with ArgumentValidationError at path .linkedMemoryIds[N]. " +
            "If cross-linking briefings is needed, request the linkedBriefingIds feature instead."),
        createdBy: creatorSchema,
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Create briefing note",
    }, async ({ title, topic, participants, content, decisions, linkedMemoryIds, createdBy, }) => {
        let contentBytes = 0;
        try {
            contentBytes = assertContentSize(content, "create_briefing_note");
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
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
            if (error instanceof McpError)
                throw error;
            console.error("[create_briefing_note] mutation failed", {
                contentBytes,
                fromOrchestrator: createdBy,
                topic,
                title,
                errorMessage: error?.message ?? String(error),
            });
            return mcpConvexError(error);
        }
    });
    // ── update_briefing_note ────────────────────────────────────────────────────
    server.tool("update_briefing_note", updateBriefingNoteDescription, updateBriefingNoteSchema.shape, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update briefing note",
    }, async ({ noteId, callerOrchestrator, title, topic, participants, content, decisions, linkedMemoryIds, }) => {
        let contentBytes = 0;
        try {
            if (content !== undefined) {
                contentBytes = assertContentSize(content, "update_briefing_note");
            }
            const fromDenied = guardFrom(callerOrchestrator);
            if (fromDenied)
                return fromDenied;
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
            if (error instanceof McpError)
                throw error;
            console.error("[update_briefing_note] mutation failed", {
                contentBytes,
                callerOrchestrator,
                noteId,
                errorMessage: error?.message ?? String(error),
            });
            return mcpConvexError(error);
        }
    });
    // ── list_briefing_notes ─────────────────────────────────────────────────────
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
            .describe("Maximum notes to return. Default 20 with fields=lite, auto-clamped to 15 when fields=full and no explicit limit."),
        fields: fieldsSchema
            .optional()
            .describe('Field projection ("lite"|"full")'),
        updatedSince: updatedSinceSchema.optional(),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List briefing notes",
    }, async ({ topic, limit, fields, updatedSince }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_briefing_notes");
            if (_scopeDenied)
                return _scopeDenied;
            const notes = await convex.query("briefingNotes:list", {
                topic,
                limit,
                fields,
                updatedSince,
            });
            const baseText = capListResponseBytes(notes, JSON.stringify(notes, null, 2), "list_briefing_notes");
            const text = appendMarkerIfEnabled(baseText, () => {
                const items = Array.isArray(notes) ? notes : [];
                if (items.length === 0)
                    return null;
                // Emit the first note as a briefing-note item for the primitive renderer.
                const first = items[0];
                return {
                    kind: "briefing-note",
                    item: {
                        _id: first._id,
                        topic: first.topic,
                        title: first.title,
                        participants: first.participants,
                        content: first.content,
                        createdBy: first.createdBy,
                    },
                };
            });
            return {
                content: [{ type: "text", text }],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── register_component ──────────────────────────────────────────────────────
    server.tool("register_component", "Register or update a component (agent, skill, hook, or plugin) in the registry. " +
        "Upserts by name+type — if a component with the same name and type exists, it updates the content.", {
        name: z
            .string()
            .describe("Component name — e.g. 'copywriter', 'check-tasks'"),
        type: componentTypeSchema,
        team: z
            .string()
            .optional()
            .describe("Team this component belongs to — e.g. 'marketing', 'development'"),
        content: z.string().describe("Full file content of the component"),
        version: z.string().optional().describe("Version string — e.g. '1.0.0'"),
        project: z
            .string()
            .optional()
            .describe("Project this component belongs to"),
        createdBy: creatorSchema,
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Register component",
    }, async ({ name, type, team, content, version, project, createdBy }) => {
        let contentBytes = 0;
        try {
            contentBytes = assertContentSize(content, "register_component");
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
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
            if (error instanceof McpError)
                throw error;
            console.error("[register_component] mutation failed", {
                contentBytes,
                name,
                type,
                createdBy,
                errorMessage: error?.message ?? String(error),
            });
            return mcpError(error.message ?? String(error));
        }
    });
    // ── list_components ─────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List components",
    }, async ({ type, team, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_components");
            if (_scopeDenied)
                return _scopeDenied;
            const components = await convex.query("components:list", {
                type,
                team,
                limit: limit ?? 100,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: capListResponseBytes(components, JSON.stringify(components, null, 2), "list_components"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── get_component ───────────────────────────────────────────────────────────
    server.tool("get_component", "Fetch a single component by name and type. Returns the full content.", {
        name: z.string().describe("Component name"),
        type: componentTypeSchema,
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Get component",
    }, async ({ name, type }) => {
        try {
            const _scopeDenied = guardMasterOnly("get_component");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── update_component ────────────────────────────────────────────────────────
    server.tool("update_component", "Update a component's fields. Provide only the fields you want to change.", {
        componentId: z.string().describe("Convex document ID of the component"),
        name: z.string().optional().describe("New component name"),
        team: z.string().optional().describe("New team name"),
        content: z.string().optional().describe("New content/source code"),
        version: z.string().optional().describe("New version string"),
        project: z.string().optional().describe("New project name"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update component",
    }, async ({ componentId, ...fields }) => {
        let contentBytes = 0;
        try {
            if (typeof fields.content === "string") {
                contentBytes = assertContentSize(fields.content, "update_component");
            }
            const result = await convex.mutation("components:update", {
                componentId: componentId,
                ...fields,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ componentId: result, updated: true }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            if (error instanceof McpError)
                throw error;
            console.error("[update_component] mutation failed", {
                contentBytes,
                componentId,
                errorMessage: error?.message ?? String(error),
            });
            return mcpError(error.message ?? String(error));
        }
    });
    // ── delete_component ────────────────────────────────────────────────────────
    server.tool("delete_component", "Delete a component from the registry by ID.", {
        componentId: z
            .string()
            .describe("Convex document ID of the component to delete"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        title: "Delete component",
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
    // ── search_components ───────────────────────────────────────────────────────
    server.tool("search_components", "Search components by name or team substring. Optionally filter by type.", {
        query: z
            .string()
            .describe("Search term to match against component name or team"),
        type: componentTypeSchema.optional().describe("Filter by component type"),
        limit: z.number().int().optional().describe("Max results (default 50)"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Search components",
    }, async ({ query, type, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("search_components");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── create_recurring_task ───────────────────────────────────────────────────
    server.tool("create_recurring_task", "Create a recurring task that auto-creates tasks on a schedule. " +
        "Uses cron expressions: '0 9 * * *' = daily 9am, '0 9 * * 1' = Monday 9am, '*/30 * * * *' = every 30min.", {
        title: z
            .string()
            .describe("Task title — created each time the cron fires"),
        description: z.string().optional().describe("Task description"),
        assignedTo: assigneeSchema.describe("Who gets the created tasks"),
        priority: z
            .enum(["urgent", "high", "medium", "low"])
            .describe("Priority of created tasks"),
        project: z.string().optional().describe("Project name"),
        tags: flexArray.optional().describe("Tags for created tasks"),
        cronExpression: z
            .string()
            .describe("5-field cron: minute hour day-of-month month day-of-week"),
        createdBy: creatorSchema,
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Create recurring task",
    }, async ({ title, description, assignedTo, priority, project, tags, cronExpression, createdBy, }) => {
        try {
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
            const assigneeDenied = guardFrom(assignedTo);
            if (assigneeDenied)
                return assigneeDenied;
            const tagsArray = tags
                ? Array.isArray(tags)
                    ? tags
                    : [tags]
                : undefined;
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
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ taskId, cronExpression }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── list_recurring_tasks ────────────────────────────────────────────────────
    server.tool("list_recurring_tasks", "List recurring task templates. Filter by assignee or active status.", {
        assignedTo: assigneeSchema.optional().describe("Filter by assignee"),
        active: z.boolean().optional().describe("Filter by active status"),
        limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .default(50)
            .describe("Max results"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List recurring tasks",
    }, async ({ assignedTo, active, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_recurring_tasks");
            if (_scopeDenied)
                return _scopeDenied;
            const tasks = await convex.query("recurringTasks:list", {
                assignedTo,
                active,
                limit: limit ?? 50,
            });
            return {
                content: [{ type: "text", text: capListResponseBytes(tasks, JSON.stringify(tasks, null, 2), "list_recurring_tasks") }],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── pause_recurring_task ────────────────────────────────────────────────────
    server.tool("pause_recurring_task", "Pause a recurring task — stops auto-creating tasks until resumed.", {
        taskId: z.string().describe("Recurring task ID"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Pause recurring task",
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
    // ── resume_recurring_task ───────────────────────────────────────────────────
    server.tool("resume_recurring_task", "Resume a paused recurring task — recalculates next run time.", {
        taskId: z.string().describe("Recurring task ID"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Resume recurring task",
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
    // ── delete_recurring_task ───────────────────────────────────────────────────
    server.tool("delete_recurring_task", "Permanently delete a recurring task template.", {
        taskId: z.string().describe("Recurring task ID"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        title: "Delete recurring task",
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
    // ── update_recurring_task ───────────────────────────────────────────────────
    server.tool("update_recurring_task", "Update a recurring task's fields. Provide only the fields you want to change. " +
        "If cronExpression is updated, nextRunAt is automatically recalculated.", {
        recurringTaskId: z
            .string()
            .describe("Convex document ID of the recurring task"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
        assignedTo: creatorSchema.optional().describe("New assignee"),
        priority: prioritySchema.optional().describe("New priority"),
        project: z.string().optional().describe("New project name"),
        tags: z.array(z.string()).optional().describe("New tags array"),
        cronExpression: z
            .string()
            .optional()
            .describe("New cron expression (5-field)"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update recurring task",
    }, async ({ recurringTaskId, ...fields }) => {
        try {
            if (fields.assignedTo) {
                const assigneeDenied = guardFrom(fields.assignedTo);
                if (assigneeDenied)
                    return assigneeDenied;
            }
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
    // ── create_mandate ──────────────────────────────────────────────────────────
    server.tool("create_mandate", "Create a cross-orchestrator service mandate. One orchestrator requests a service from another " +
        "with an agreed token budget. The mandate lifecycle: requested → accepted → in_progress → delivered → settled.", {
        requestedBy: creatorSchema.describe("Orchestrator who needs the service"),
        fulfilledBy: creatorSchema.describe("Orchestrator who will provide the service"),
        service: z.string().describe("Description of what service is needed"),
        budget: z.number().describe("Token budget allocated for this mandate"),
        spendingLimits: z
            .object({
            maxPerTransaction: z.number(),
            maxPerPeriod: z.number(),
            periodDays: z.number().optional(),
        })
            .optional()
            .describe("AP2 spending limits"),
        approvedCategories: z
            .array(z.string())
            .optional()
            .describe("Approved service categories"),
        mandateDocument: z
            .string()
            .optional()
            .describe("Signed authorization document or reference"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Create mandate",
    }, async ({ requestedBy, fulfilledBy, service, budget, spendingLimits, approvedCategories, mandateDocument, }) => {
        try {
            const fromDenied = guardFrom(requestedBy);
            if (fromDenied)
                return fromDenied;
            const fulfillerDenied = guardFrom(fulfilledBy);
            if (fulfillerDenied)
                return fulfillerDenied;
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
    // ── accept_mandate ──────────────────────────────────────────────────────────
    server.tool("accept_mandate", "Accept a mandate — sets status to 'accepted'. Only the fulfilledBy orchestrator (or system) can accept.", {
        mandateId: z
            .string()
            .describe("Convex document ID of the mandate to accept"),
        callerOrchestrator: creatorSchema.describe("Must be the fulfilledBy orchestrator or system"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Accept mandate",
    }, async ({ mandateId, callerOrchestrator }) => {
        try {
            const fromDenied = guardFrom(callerOrchestrator);
            if (fromDenied)
                return fromDenied;
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
    // ── update_mandate ──────────────────────────────────────────────────────────
    server.tool("update_mandate", "Update a mandate's status, tokensCost, or linkedTaskIds. " +
        "Only the fulfilledBy orchestrator (or system) can update. Provide only fields you want to change.", {
        mandateId: z
            .string()
            .describe("Convex document ID of the mandate to update"),
        callerOrchestrator: creatorSchema.describe("Must be the fulfilledBy orchestrator or system"),
        status: mandateStatusSchema.optional().describe("New status"),
        tokensCost: z.number().optional().describe("Tokens consumed so far"),
        linkedTaskIds: z
            .array(z.string())
            .optional()
            .describe("Task IDs created to fulfill this mandate"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update mandate",
    }, async ({ mandateId, callerOrchestrator, status, tokensCost, linkedTaskIds, }) => {
        try {
            const fromDenied = guardFrom(callerOrchestrator);
            if (fromDenied)
                return fromDenied;
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
    // ── settle_mandate ──────────────────────────────────────────────────────────
    server.tool("settle_mandate", "Settle a mandate — confirms delivery and records the final token cost. " +
        "Sets status to 'settled'. Only the requestedBy orchestrator (the payer) or system can settle.", {
        mandateId: z
            .string()
            .describe("Convex document ID of the mandate to settle"),
        callerOrchestrator: creatorSchema.describe("Must be the requestedBy orchestrator or system"),
        finalCost: z.number().describe("Final actual token cost to record"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Settle mandate",
    }, async ({ mandateId, callerOrchestrator, finalCost }) => {
        try {
            const fromDenied = guardFrom(callerOrchestrator);
            if (fromDenied)
                return fromDenied;
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
    // ── validate_mandate_spending ───────────────────────────────────────────────
    server.tool("validate_mandate_spending", "Check if a proposed spend is within a mandate's AP2 spending limits. Returns within/exceeded status with details.", {
        mandateId: z.string().describe("Mandate ID to validate against"),
        proposedAmount: z
            .number()
            .describe("Proposed token spend amount to validate"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Validate mandate spending",
    }, async ({ mandateId, proposedAmount }) => {
        try {
            const result = await convex.query("mandates:validateSpending", {
                mandateId: mandateId,
                proposedAmount,
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── list_mandates ───────────────────────────────────────────────────────────
    server.tool("list_mandates", "List mandates with optional filters. Filter by requestedBy, fulfilledBy, and/or status. " +
        "Returns newest first. Use to track service agreements between orchestrators.", {
        requestedBy: creatorSchema
            .optional()
            .describe("Filter by the orchestrator who requested the service"),
        fulfilledBy: creatorSchema
            .optional()
            .describe("Filter by the orchestrator providing the service"),
        status: mandateStatusSchema
            .optional()
            .describe("Filter by mandate status"),
        limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .default(50)
            .describe("Maximum mandates to return (default 50)"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List mandates",
    }, async ({ requestedBy, fulfilledBy, status, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_mandates");
            if (_scopeDenied)
                return _scopeDenied;
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
                        text: capListResponseBytes(mandates, JSON.stringify(mandates, null, 2), "list_mandates"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── create_bu ───────────────────────────────────────────────────────────────
    server.tool("create_bu", "Create a new business unit. Captures strategy, business model, team, and KPIs. " +
        "managementFee defaults to 10 (percentage of revenue).", {
        name: z.string().describe("Business unit name — e.g. 'VantagePeers'"),
        description: z.string().describe("Short description of the BU"),
        purpose: z.string().describe("Why this BU exists — strategic purpose"),
        domain: z
            .string()
            .optional()
            .describe("Primary domain — e.g. 'vantagepeers.com'"),
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Create BU",
    }, async ({ name, description, purpose, domain, orchestratorId, status, businessModel, targetCustomers, services, pricing, revenueProjections, coreTeam, coreProcesses, dependencies, kpis, managementFee, }) => {
        try {
            const fromDenied = guardFrom(orchestratorId);
            if (fromDenied)
                return fromDenied;
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
    // ── update_bu ───────────────────────────────────────────────────────────────
    server.tool("update_bu", "Update any mutable field on a business unit. Provide only the fields you want to change. " +
        "updatedAt is set automatically.", {
        buId: z
            .string()
            .describe("Convex document ID of the business unit to update"),
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
        revenueProjections: revenueProjectionsSchema
            .optional()
            .describe("Updated revenue projections"),
        coreTeam: coreTeamSchema.optional().describe("Updated core team"),
        coreProcesses: flexArrayOptional.describe("New core processes"),
        dependencies: flexArrayOptional.describe("New dependencies"),
        kpis: flexArrayOptional.describe("New KPIs"),
        managementFee: z.number().optional().describe("New management fee %"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update BU",
    }, async ({ buId, name, description, purpose, domain, orchestratorId, status, businessModel, targetCustomers, services, pricing, revenueProjections, coreTeam, coreProcesses, dependencies, kpis, managementFee, }) => {
        try {
            if (orchestratorId) {
                const fromDenied = guardFrom(orchestratorId);
                if (fromDenied)
                    return fromDenied;
            }
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
    // ── get_bu ──────────────────────────────────────────────────────────────────
    server.tool("get_bu", "Fetch a single business unit by its Convex document ID. Returns null if not found.", {
        buId: z.string().describe("Convex document ID of the business unit"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Get BU",
    }, async ({ buId }) => {
        try {
            const _scopeDenied = guardMasterOnly("get_bu");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── list_bus ────────────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List BUs",
    }, async ({ orchestratorId, status, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_bus");
            if (_scopeDenied)
                return _scopeDenied;
            const bus = await convex.query("businessUnits:list", {
                orchestratorId,
                status,
                limit: limit ?? 50,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: capListResponseBytes(bus, JSON.stringify(bus, null, 2), "list_bus"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── delete_bu ───────────────────────────────────────────────────────────────
    server.tool("delete_bu", "Delete a business unit by ID. This action is permanent.", {
        buId: z
            .string()
            .describe("Convex document ID of the business unit to delete"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        title: "Delete BU",
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
    // ── add_repo_mapping ────────────────────────────────────────────────────────
    server.tool("add_repo_mapping", "Add or update a GitHub repo → orchestrator mapping. Used by the webhook pipeline to route GitHub events to the right orchestrator.", {
        repo: z
            .string()
            .describe("Full repo name — e.g. 'vantageos-agency/vantage-peers'"),
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Add repo mapping",
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
    // ── list_repo_mappings ──────────────────────────────────────────────────────
    server.tool("list_repo_mappings", "List all GitHub repo → orchestrator mappings. Shows which repos are monitored and which orchestrator handles each.", {}, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List repo mappings",
    }, async () => {
        try {
            const _scopeDenied = guardMasterOnly("list_repo_mappings");
            if (_scopeDenied)
                return _scopeDenied;
            const mappings = await convex.query("githubRepoMapping:list", {});
            return {
                content: [
                    {
                        type: "text",
                        text: capListResponseBytes(mappings, JSON.stringify(mappings, null, 2), "list_repo_mappings"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── remove_repo_mapping ─────────────────────────────────────────────────────
    server.tool("remove_repo_mapping", "Remove a GitHub repo mapping by repo name. Stops routing webhook events for this repo.", {
        repo: z
            .string()
            .describe("Full repo name to remove — e.g. 'vantageos-agency/vantage-peers'"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        title: "Remove repo mapping",
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
    // ── list_issues ─────────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List issues",
    }, async ({ project, status, assignedTo, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_issues");
            if (_scopeDenied)
                return _scopeDenied;
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
                        text: capListResponseBytes(results, JSON.stringify({ count: results.length, issues: results }, null, 2), "list_issues"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── get_issue ───────────────────────────────────────────────────────────────
    server.tool("get_issue", "Get a single GitHub issue by repo and issue number.", {
        repo: z
            .string()
            .describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
        issueNumber: z.number().int().describe("GitHub issue number"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Get issue",
    }, async ({ repo, issueNumber }) => {
        try {
            const _scopeDenied = guardMasterOnly("get_issue");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── update_issue_status ─────────────────────────────────────────────────────
    server.tool("update_issue_status", "Update the status of a tracked GitHub issue.", {
        repo: z
            .string()
            .describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
        issueNumber: z.number().int().describe("GitHub issue number"),
        status: z
            .enum(["open", "in_progress", "fixed", "verified", "closed"])
            .describe("New status for the issue"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update issue status",
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
    // ── link_commit_to_issue ────────────────────────────────────────────────────
    server.tool("link_commit_to_issue", "Link a fix commit SHA to a GitHub issue. Records who fixed it and when.", {
        repo: z
            .string()
            .describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
        issueNumber: z.number().int().describe("GitHub issue number"),
        commitSha: z.string().describe("Git commit SHA that fixes this issue"),
        fixedBy: z
            .string()
            .describe("Who fixed it — orchestrator name or person"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Link commit to issue",
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
    // ── verify_issue ────────────────────────────────────────────────────────────
    server.tool("verify_issue", "Mark a GitHub issue as verified (fix confirmed). Sets status to 'verified'.", {
        repo: z
            .string()
            .describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
        issueNumber: z.number().int().describe("GitHub issue number"),
        verifiedBy: z
            .string()
            .describe("Who verified the fix — orchestrator name or person"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Verify issue",
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
    // ── issue_stats ─────────────────────────────────────────────────────────────
    server.tool("issue_stats", "Get issue count statistics grouped by status. Optionally filter by project.", {
        project: z
            .string()
            .optional()
            .describe("Filter stats to a specific project — omit for all projects"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Issue statistics",
    }, async ({ project }) => {
        try {
            const _scopeDenied = guardMasterOnly("issue_stats");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── create_fix_pattern ──────────────────────────────────────────────────────
    server.tool("create_fix_pattern", "Create a fix pattern in the knowledge base. Documents a bug symptom, root cause, and optional validated fix. Agents search this BEFORE fixing to avoid repeating mistakes.", {
        symptom: z
            .string()
            .describe("What the bug looks like — the user-visible problem"),
        rootCause: z
            .string()
            .describe("Why the bug happens — the underlying technical cause"),
        tags: flexArray.describe("Tags for categorization — e.g. 'react-hydration', 'convex-subscription'"),
        stack: flexArray.describe("Tech stack involved — e.g. 'next.js', 'convex', 'clerk'"),
        sourceProject: z
            .string()
            .describe("Project where this was discovered — e.g. 'myreeldream'"),
        createdBy: creatorSchema,
        severity: severitySchema,
        validatedFix: z
            .string()
            .optional()
            .describe("The fix that worked — set later if not known yet"),
        files: flexArrayOptional.describe("Files involved in the fix"),
        linkedIssueIds: flexArrayOptional.describe("VantagePeers issue IDs linked to this pattern"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Create fix pattern",
    }, async ({ symptom, rootCause, tags, stack, sourceProject, createdBy, severity, validatedFix, files, linkedIssueIds, }) => {
        try {
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
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
    // ── add_fix_attempt ─────────────────────────────────────────────────────────
    server.tool("add_fix_attempt", "Add a fix attempt to a pattern. Documents what was tried, whether it worked, and why. If worked=true and pattern has no validatedFix, auto-sets it.", {
        patternId: z.string().describe("ID of the fix pattern"),
        description: z.string().describe("What was tried — the fix approach"),
        worked: z.boolean().describe("Did this fix the issue?"),
        why: z.string().describe("Why it worked or didn't — the reasoning"),
        createdBy: creatorSchema,
        commit: z.string().optional().describe("Git commit hash of this attempt"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Add fix attempt",
    }, async ({ patternId, description, worked, why, createdBy, commit }) => {
        try {
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
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
    // ── validate_fix ────────────────────────────────────────────────────────────
    server.tool("validate_fix", "Set or update the validated fix on a pattern. Use after confirming a fix works.", {
        patternId: z.string().describe("ID of the fix pattern"),
        validatedFix: z.string().describe("Description of the validated fix"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Validate fix",
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
    // ── search_fix_patterns ─────────────────────────────────────────────────────
    server.tool("search_fix_patterns", "Semantic search over fix patterns. Use this BEFORE fixing a bug to check if it's been seen before. Returns patterns ranked by relevance.", {
        query: z
            .string()
            .describe("Describe the problem — e.g. 'message disappears after sending'"),
        limit: z
            .number()
            .int()
            .optional()
            .describe("Max results to return (default 10)"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Search fix patterns",
    }, async ({ query, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("search_fix_patterns");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── list_fix_patterns ───────────────────────────────────────────────────────
    server.tool("list_fix_patterns", "List fix patterns, optionally filtered by project. Returns patterns sorted by creation date (newest first).", {
        project: z
            .string()
            .optional()
            .describe("Filter by source project — omit for all"),
        limit: z.number().int().optional().describe("Max results (default 50)"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List fix patterns",
    }, async ({ project, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_fix_patterns");
            if (_scopeDenied)
                return _scopeDenied;
            if (project) {
                const results = await convex.query("fixPatterns:listByProject", {
                    sourceProject: project,
                    limit,
                });
                return {
                    content: [{ type: "text", text: capListResponseBytes(results, JSON.stringify(results, null, 2), "list_fix_patterns") }],
                };
            }
            const allResults = await convex.query("fixPatterns:listAll", {
                limit,
            });
            return {
                content: [
                    { type: "text", text: capListResponseBytes(allResults, JSON.stringify(allResults, null, 2), "list_fix_patterns") },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── link_issue_to_pattern ───────────────────────────────────────────────────
    server.tool("link_issue_to_pattern", "Link a VantagePeers issue to a fix pattern. Creates a bidirectional reference.", {
        patternId: z.string().describe("ID of the fix pattern"),
        issueId: z.string().describe("VantagePeers issue ID to link"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Link issue to fix pattern",
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
    // ── get_mission_template ────────────────────────────────────────────────────
    server.tool("get_mission_template", "Fetch a mission template by name. Returns the template with all steps, or null if not found. " +
        "Use 'issue-resolution-v2' for the default Issue Resolution Protocol.", {
        name: z.string().describe("Template name — e.g. 'issue-resolution-v2'"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Get mission template",
    }, async ({ name }) => {
        try {
            const _scopeDenied = guardMasterOnly("get_mission_template");
            if (_scopeDenied)
                return _scopeDenied;
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
    // ── update_mission_template ─────────────────────────────────────────────────
    server.tool("update_mission_template", "Create or update a mission template by name. " +
        "Each step has a title, description, and optional tags. " +
        "If the template already exists it is overwritten (upsert by name).", {
        name: z
            .string()
            .describe("Template name — must be unique, e.g. 'issue-resolution-v2'"),
        description: z
            .string()
            .optional()
            .describe("Human-readable description of the template"),
        steps: z
            .array(z.object({
            title: z.string().describe("Step title"),
            description: z.string().describe("What to do in this step"),
            tags: z
                .array(z.string())
                .optional()
                .describe("Optional tags for the step"),
            assignedTo: z
                .string()
                .optional()
                .describe("Orchestrator role assigned to this step — e.g. 'proxima'. Falls back to mission.pilot when unset during instantiation."),
            assignedToInstance: z
                .string()
                .optional()
                .describe("Instance-level assignment for this step — e.g. 'proxima-vps'. Optional."),
            dependsOn: z
                .array(z.number())
                .optional()
                .describe("0-based indexes of steps that must complete before this step. Resolved to task IDs on instantiation."),
        }))
            .describe("Ordered list of steps — each becomes one task when instantiated"),
        createdBy: creatorSchema.describe("Who is creating/updating the template"),
        isDefault: z
            .boolean()
            .optional()
            .describe("Mark as the default template for its type"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Update mission template",
    }, async ({ name, description, steps, createdBy, isDefault }) => {
        try {
            const fromDenied = guardFrom(createdBy);
            if (fromDenied)
                return fromDenied;
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
    // ── instantiate_template_into_mission ───────────────────────────────────────
    server.tool("instantiate_template_into_mission", "Create N tasks from a mission template, one per step, each pre-assigned to the step's declared orchestrator (falling back to mission pilot when unset). Unblocks industrial cross-orchestrator workflows — replaces the fragile assign:X tag workaround.", {
        templateName: z
            .string()
            .describe("Name of the mission template to instantiate"),
        missionId: z
            .string()
            .describe("Convex document ID of the target mission"),
        context: z
            .record(z.string(), z.string())
            .optional()
            .describe("Key-value map for {{key}} interpolation in step descriptions. Non-matching placeholders are left intact."),
        titlePrefix: z
            .string()
            .optional()
            .describe("String prepended to every task title — e.g. '[p25]'. Optional."),
        callerOrchestrator: z
            .string()
            .optional()
            .describe("Orchestrator making this call — used as createdBy on tasks. Defaults to 'system'."),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Instantiate mission template",
    }, async ({ templateName, missionId, context, titlePrefix, callerOrchestrator, }) => {
        try {
            const denied = guardMasterOnly("instantiate_template_into_mission");
            if (denied)
                return denied;
            const result = await convex.mutation("missionTemplates:instantiateTemplateIntoMission", {
                templateName,
                missionId: missionId,
                context,
                titlePrefix,
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
    // ── add_deployment ──────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        title: "Add deployment",
    }, async ({ name, deploymentUrl, deployKeyEnvVar, githubRepo, orchestrator, }) => {
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
    // ── remove_deployment ───────────────────────────────────────────────────────
    server.tool("remove_deployment", "Deactivate a monitored deployment. The deployment record is preserved but polling stops.", {
        name: z
            .string()
            .describe("Name of the deployment to deactivate — e.g. 'your-deployment-123'"),
    }, {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        title: "Remove deployment",
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
    // ── list_errors ─────────────────────────────────────────────────────────────
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
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "List errors",
    }, async ({ deployment, limit }) => {
        try {
            const _scopeDenied = guardMasterOnly("list_errors");
            if (_scopeDenied)
                return _scopeDenied;
            const errors = await convex.query("errorMonitor:listErrors", {
                deployment,
                limit: limit ?? 50,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: capListResponseBytes(errors, JSON.stringify(errors, null, 2), "list_errors"),
                    },
                ],
            };
        }
        catch (error) {
            return mcpError(error.message ?? String(error));
        }
    });
    // ── get_error ───────────────────────────────────────────────────────────────
    server.tool("get_error", "Fetch a single error log entry by its Convex document ID, including stack trace and issue linkage.", {
        errorId: z.string().describe("Convex document ID of the errorLogs entry"),
    }, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Get error",
    }, async ({ errorId }) => {
        try {
            const _scopeDenied = guardMasterOnly("get_error");
            if (_scopeDenied)
                return _scopeDenied;
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
}
