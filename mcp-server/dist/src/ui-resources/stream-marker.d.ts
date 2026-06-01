/**
 * VP Tool Result stream markers for SEP-1865 M3.
 *
 * The Gen UI iframe embed intercepts MCP tool responses and detects
 * __VP_TOOL_RESULT__<json>__END__ markers to render structured primitives
 * inline (Shadow DOM scoped). The marker is emitted only when
 * VP_EMIT_UI_MARKERS=1, so prod behaviour is unchanged by default.
 *
 * Mission : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
 */
import { type VpToolResult } from "./schemas.js";
export declare const MARKER_START = "__VP_TOOL_RESULT__";
export declare const MARKER_END = "__END__";
/**
 * Validate `payload` against VpToolResultSchema, then wrap it in the VP
 * stream marker format:
 *   __VP_TOOL_RESULT__{"kind":"tasks-table","items":[...]}__END__
 *
 * Throws a TypeError if the payload does not conform to VpToolResultSchema.
 */
export declare function wrapToolResult(payload: VpToolResult): string;
/**
 * Extract and parse a VP tool result marker from `text`.
 *
 * Handles three cases:
 *  - text IS the marker (bare: `__VP_TOOL_RESULT__<json>__END__`)
 *  - text CONTAINS the marker embedded in surrounding content
 *  - text does NOT contain a marker (returns null)
 *
 * Returns the validated VpToolResult on success, or null on any failure
 * (missing marker, malformed JSON, schema violation).
 */
export declare function parseToolResult(text: string): VpToolResult | null;
