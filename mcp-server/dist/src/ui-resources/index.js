/**
 * SEP-1865 ui:// resources for VantagePeers Generative UI.
 *
 * Canonical PR #1865 (MERGED 2026-01-28) compliance:
 *  - MIME: text/html;profile=mcp-app (RESOURCE_MIME_TYPE)
 *  - _meta.ui: UIResourceMeta envelope (nested, NOT flat _meta["ui/resourceUri"])
 *  - Capability key declared at server initialize: io.modelcontextprotocol/ui
 *  - Fallback markdown content item in resources/read response (Critical Rule #1)
 *
 * Uses @mcp-ui/server createUIResource() helper (reference impl by SEP-1865 co-author).
 *
 * URI pattern : ui://vp/v1/<primitive>?<query>
 * Examples :
 *   ui://vp/v1/tasks-table?assignedTo=pi&status=review&fields=lite&limit=10
 *   ui://vp/v1/messages-feed?recipient=sigma&limit=20
 *
 * Pattern Hybrid 60% static lit-ui + 11% Gen UI + 27% Hybrid (cf vp-gui-views-research-2026-05-28.md).
 *
 * Reference instance Theta : theta-vantage-crm-gui-iframe-embed-v1 (blissful-gopher-531).
 * Mission Sigma : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
 */
import { RESOURCE_MIME_TYPE } from "@mcp-ui/server";
import { renderBriefingNote } from "./primitives/briefing-note.js";
import { renderDiaryEntry } from "./primitives/diary-entry.js";
import { renderMemoryQuote } from "./primitives/memory-quote.js";
import { renderMessagesFeed } from "./primitives/messages-feed.js";
import { renderMissionTimeline } from "./primitives/mission-timeline.js";
import { renderTasksTable } from "./primitives/tasks-table.js";
// MCP Apps capability negotiation key (declared at server initialize handshake).
// Tools opting into UI resources reference it from their _meta.ui field.
export const MCP_UI_CAPABILITY_KEY = "io.modelcontextprotocol/ui";
// PR #1865 MIME — re-export from @mcp-ui/server for downstream visibility.
export const MCP_UI_MIME_TYPE = RESOURCE_MIME_TYPE;
const DEFAULT_UI_META = {};
// URI parser : ui://vp/v1/<primitive>?<query>
const UI_URI_RE = /^ui:\/\/vp\/v1\/([a-z][a-z0-9-]*)(?:\?(.*))?$/;
export function parseUiUri(uri) {
    const match = UI_URI_RE.exec(uri);
    if (!match)
        return null;
    const primitive = match[1];
    const queryString = match[2] ?? "";
    return {
        primitive,
        query: new URLSearchParams(queryString),
    };
}
// Primitive registry — M1 ships 1 (tasks-table). M2 adds 5 more.
export const PRIMITIVES = [
    "tasks-table",
    "messages-feed",
    "diary-entry",
    "mission-timeline",
    "briefing-note",
    "memory-quote",
];
export const PRIMITIVE_DESCRIPTIONS = {
    "tasks-table": "Render a compact table of tasks. Query params: assignedTo, status, fields=lite|full, limit. Mirrors list_tasks tool semantics.",
    "messages-feed": "Render a chronological feed of VantagePeers messages. Query params: from, channel, limit, lang.",
    "diary-entry": "Render a single diary entry or list of recent entries. Query params: date (YYYY-MM-DD), orchestrator, limit, lang.",
    "mission-timeline": "Render a missions timeline. Query params: pilot, project, status, limit, lang.",
    "briefing-note": "Render briefing note details. Query params: noteId or (topic + limit), lang.",
    "memory-quote": "Render memory quotes from a namespace. Query params: namespace, type, limit, lang.",
};
// Resource list — returned by resources/list MCP handler.
// PR #1865 canonical: mimeType=text/html;profile=mcp-app + _meta.ui envelope.
export function listUiResources() {
    return PRIMITIVES.map((p) => ({
        uri: `ui://vp/v1/${p}`,
        name: p,
        description: PRIMITIVE_DESCRIPTIONS[p],
        mimeType: MCP_UI_MIME_TYPE,
        _meta: { ui: DEFAULT_UI_META },
    }));
}
// Markdown fallback per Critical Rule #1: every UI resource MUST provide a
// meaningful text-only payload for hosts without the UI extension. We render a
// short hint + the primitive description so model + non-UI clients still get
// usable output (raw HTML is not a substitute — it is the same content the iframe
// would render, defeating the fallback purpose).
function renderMarkdownFallback(uri, primitive) {
    const desc = PRIMITIVE_DESCRIPTIONS[primitive];
    return [
        `# ${primitive}`,
        "",
        `This resource (${uri}) provides an interactive UI rendering for VantagePeers \`${primitive}\` data.`,
        "",
        desc,
        "",
        "Your client does not appear to support the MCP UI extension (`text/html;profile=mcp-app`). For a textual view of the same data, call the corresponding VantagePeers tool directly (e.g. `list_tasks`, `list_messages`, `list_diaries`, `list_missions`, `list_briefing_notes`, `recall`) with equivalent filters.",
    ].join("\n");
}
// Resource read — dispatched by primitive name. Returns canonical
// resources/read contents array: [HTML profile=mcp-app, markdown fallback].
export async function readUiResource(uri, fetchConvex) {
    const parsed = parseUiUri(uri);
    if (!parsed) {
        throw new Error(`[VP UI Resources] Invalid ui:// URI: ${uri}`);
    }
    if (!PRIMITIVES.includes(parsed.primitive)) {
        throw new Error(`[VP UI Resources] Unknown primitive: ${parsed.primitive}. Available: ${PRIMITIVES.join(", ")}`);
    }
    const primitive = parsed.primitive;
    let html;
    switch (primitive) {
        case "tasks-table":
            html = await renderTasksTable(parsed.query, fetchConvex);
            break;
        case "messages-feed":
            html = await renderMessagesFeed(parsed.query, fetchConvex);
            break;
        case "diary-entry":
            html = await renderDiaryEntry(parsed.query, fetchConvex);
            break;
        case "mission-timeline":
            html = await renderMissionTimeline(parsed.query, fetchConvex);
            break;
        case "briefing-note":
            html = await renderBriefingNote(parsed.query, fetchConvex);
            break;
        case "memory-quote":
            html = await renderMemoryQuote(parsed.query, fetchConvex);
            break;
        default:
            throw new Error(`[VP UI Resources] Unimplemented primitive: ${parsed.primitive}`);
    }
    return {
        contents: [
            {
                uri,
                mimeType: MCP_UI_MIME_TYPE,
                text: html,
                _meta: { ui: DEFAULT_UI_META },
            },
            {
                uri,
                mimeType: "text/markdown",
                text: renderMarkdownFallback(uri, primitive),
            },
        ],
    };
}
