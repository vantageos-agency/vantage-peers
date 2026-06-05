/**
 * Shared paging utility for VP MCP `list_*` tools (S3.3 B8).
 *
 * Friction origin (Sigma stale-cleanup session, 2026-06-04):
 *   list_tasks at the 200-row page-cap with newest-first ordering blocks tail
 *   drain — 6 iterations of identical 132-task batches because there was no
 *   cursor and no createdBefore filter.
 *
 * Design contract (additive, backward-compat):
 *   - DEFAULT_LIMIT = 50 — sensible default for cursor-paged callers (existing
 *     tools that hard-code `?? 20` are NOT touched; they keep their default).
 *   - MAX_LIMIT = 200 — hard ceiling; clampLimit floors out-of-range input.
 *   - ENVELOPE_TARGET_BYTES = 50_000 — pre-MCP-envelope (60 KB) headroom for
 *     framing + UI markers. enforceEnvelopeCap halves until the JSON-serialized
 *     items array fits, but always returns at least 1 row.
 *   - Cursor token = base64url(JSON({ ...opaque-payload })). Two payload shapes
 *     are supported:
 *       * { createdBefore: number; lastId?: string }
 *         For convex queries without paginate() (tasks, briefingNotes…) — the
 *         MCP layer forwards createdBefore as a where-filter and computes the
 *         next cursor from the last row's _creationTime.
 *       * { backendCursor: string | null }
 *         For convex queries that support paginationOpts (memories, …) — the
 *         MCP layer forwards backendCursor as paginationOpts.cursor and the
 *         next token is built from the backend's continueCursor.
 *
 * Note: cursor tokens are intentionally opaque to callers. Format may evolve
 * without breaking MCP clients as long as encode/decode stay paired.
 */
export declare const DEFAULT_LIMIT = 50;
export declare const MAX_LIMIT = 200;
export declare const ENVELOPE_TARGET_BYTES = 50000;
/**
 * Clamp a caller-supplied limit to the safe operating range [1, MAX_LIMIT].
 * undefined/null → DEFAULT_LIMIT. Non-integer values are floored.
 */
export declare function clampLimit(limit: number | null | undefined): number;
export type CursorPayload = {
    createdBefore: number;
    lastId?: string;
} | {
    backendCursor: string | null;
};
/**
 * Encode a cursor payload into a URL-safe opaque token.
 * Uses base64url to avoid `=` padding + `/` characters that confuse MCP
 * clients that paste cursors into URL contexts.
 */
export declare function encodeCursor(payload: CursorPayload): string;
/**
 * Decode an opaque cursor token. Returns null when token is undefined/empty
 * (no-cursor sentinel). Throws a typed Error on malformed input so MCP tool
 * handlers can surface a user-facing "invalid cursor" message rather than
 * leaking a JSON.parse exception.
 */
export declare function decodeCursor(token: string | null | undefined): CursorPayload | null;
export interface EnvelopeCapResult<T> {
    items: T[];
    isCapped: boolean;
}
/**
 * Enforce the ENVELOPE_TARGET_BYTES soft cap by halving the rows array until
 * the JSON-serialized payload fits, or only 1 row remains (single-huge-row
 * floor — a 200 KB single row will still be returned with isCapped=true).
 */
export declare function enforceEnvelopeCap<T>(rows: T[], targetBytes?: number): EnvelopeCapResult<T>;
export interface PageResult<T> {
    items: T[];
    nextCursor: string | null;
    isCapped?: boolean;
}
/**
 * Assemble the canonical page envelope returned to MCP callers.
 * nextCursor is null when hasMore is false (end-of-data sentinel).
 */
export declare function buildPageResult<T>(input: {
    rows: T[];
    hasMore: boolean;
    nextCursor: string | null;
    isCapped?: boolean;
}): PageResult<T>;
