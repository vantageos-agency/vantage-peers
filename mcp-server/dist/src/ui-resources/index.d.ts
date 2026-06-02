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
export declare const MCP_UI_CAPABILITY_KEY: "io.modelcontextprotocol/ui";
export declare const MCP_UI_MIME_TYPE = "text/html;profile=mcp-app";
type UIResourceMeta = Record<string, never>;
export type UiResourceParsed = {
    primitive: string;
    query: URLSearchParams;
};
export declare function parseUiUri(uri: string): UiResourceParsed | null;
export declare const PRIMITIVES: readonly ["tasks-table", "messages-feed", "diary-entry", "mission-timeline", "briefing-note", "memory-quote"];
export type Primitive = (typeof PRIMITIVES)[number];
export declare const PRIMITIVE_DESCRIPTIONS: Record<Primitive, string>;
export type UiResourceListEntry = {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
    _meta: {
        ui: UIResourceMeta;
    };
};
export declare function listUiResources(): UiResourceListEntry[];
export type UiResourceContent = {
    uri: string;
    mimeType: string;
    text: string;
    _meta?: {
        ui: UIResourceMeta;
    };
} | {
    uri: string;
    mimeType: "text/markdown";
    text: string;
};
export type UiResourceReadResult = {
    contents: UiResourceContent[];
};
export declare function readUiResource(uri: string, fetchConvex: (functionName: string, args: Record<string, unknown>) => Promise<unknown>): Promise<UiResourceReadResult>;
export {};
