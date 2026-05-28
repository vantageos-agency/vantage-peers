/**
 * SEP-1865 ui:// resources for VantagePeers Generative UI.
 *
 * URI pattern : ui://vp/v1/<primitive>?<query>
 * Examples :
 *   ui://vp/v1/tasks-table?assignedTo=pi&status=review&fields=lite&limit=10
 *   ui://vp/v1/messages-feed?recipient=sigma&limit=20
 *
 * M1 scope : 1 primitive (tasks-table) — proves the pipeline.
 * M2 scope : ≥6 primitives (tasks/messages/diary/missions/briefingNotes/memories).
 *
 * Pattern Hybrid 60% static lit-ui + 11% Gen UI + 27% Hybrid (cf vp-gui-views-research-2026-05-28.md).
 * Returns HTML inline with embedded JS + CSS Shadow DOM scoped.
 *
 * Reference instance Theta : theta-vantage-crm-gui-iframe-embed-v1 (blissful-gopher-531).
 * Mission Sigma : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
 */
export type UiResourceParsed = {
    primitive: string;
    query: URLSearchParams;
};
export declare function parseUiUri(uri: string): UiResourceParsed | null;
export declare const PRIMITIVES: readonly ["tasks-table", "messages-feed", "diary-entry", "mission-timeline", "briefing-note", "memory-quote"];
export type Primitive = (typeof PRIMITIVES)[number];
export declare const PRIMITIVE_DESCRIPTIONS: Record<Primitive, string>;
export declare function listUiResources(): Array<{
    uri: string;
    name: string;
    description: string;
    mimeType: string;
}>;
export declare function readUiResource(uri: string, fetchConvex: (functionName: string, args: Record<string, unknown>) => Promise<unknown>): Promise<{
    uri: string;
    mimeType: string;
    text: string;
}>;
