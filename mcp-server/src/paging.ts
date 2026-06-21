import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// PR-A envelope safety — shared schema + applyPagingDefaults helper
// Reusable by list_bus, list_tasks (PR-B), list_memories (PR-C) etc.
// ─────────────────────────────────────────────────────────────────────────────

export const pagingArgsSchema = z.object({
	limit: z.number().int().min(1).max(200).optional(),
	cursor: z.string().optional(),
	fields: z.enum(["lite", "full"]).optional(),
});

export type PagingArgs = z.infer<typeof pagingArgsSchema>;

export interface PagingDefaults {
	limit: number;
	cap: number;
	fields: "lite" | "full";
}

export const DEFAULT_PAGING: PagingDefaults = {
	limit: 20,
	cap: 200,
	fields: "full",
};

export function applyPagingDefaults(
	args: PagingArgs,
	defaults: PagingDefaults = DEFAULT_PAGING,
): { limit: number; cursor: string | undefined; fields: "lite" | "full" } {
	const requested = args.limit ?? defaults.limit;
	const clamped = Math.min(requested, defaults.cap);
	const limit = Math.max(1, clamped);
	return {
		limit,
		cursor: args.cursor,
		fields: args.fields ?? defaults.fields,
	};
}

// ─────────────────────────────────────────────────────────────────────────────

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

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const ENVELOPE_TARGET_BYTES = 50_000;

/**
 * Clamp a caller-supplied limit to the safe operating range [1, MAX_LIMIT].
 * undefined/null → DEFAULT_LIMIT. Non-integer values are floored.
 */
export function clampLimit(limit: number | null | undefined): number {
	if (limit === undefined || limit === null) return DEFAULT_LIMIT;
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	const floored = Math.floor(limit);
	if (floored < 1) return 1;
	if (floored > MAX_LIMIT) return MAX_LIMIT;
	return floored;
}

export type CursorPayload =
	| { createdBefore: number; lastId?: string }
	| { backendCursor: string | null };

/**
 * Encode a cursor payload into a URL-safe opaque token.
 * Uses base64url to avoid `=` padding + `/` characters that confuse MCP
 * clients that paste cursors into URL contexts.
 */
export function encodeCursor(payload: CursorPayload): string {
	const json = JSON.stringify(payload);
	return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor token. Returns null when token is undefined/empty
 * (no-cursor sentinel). Throws a typed Error on malformed input so MCP tool
 * handlers can surface a user-facing "invalid cursor" message rather than
 * leaking a JSON.parse exception.
 */
export function decodeCursor(
	token: string | null | undefined,
): CursorPayload | null {
	if (!token) return null;
	try {
		const json = Buffer.from(token, "base64url").toString("utf8");
		const parsed = JSON.parse(json) as unknown;
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error("invalid cursor: payload is not an object");
		}
		const p = parsed as Record<string, unknown>;
		if (
			"createdBefore" in p &&
			typeof p.createdBefore === "number" &&
			Number.isFinite(p.createdBefore)
		) {
			const out: { createdBefore: number; lastId?: string } = {
				createdBefore: p.createdBefore,
			};
			if (typeof p.lastId === "string") out.lastId = p.lastId;
			return out;
		}
		if (
			"backendCursor" in p &&
			(typeof p.backendCursor === "string" || p.backendCursor === null)
		) {
			return { backendCursor: p.backendCursor };
		}
		throw new Error("invalid cursor: unrecognised payload shape");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.toLowerCase().includes("invalid cursor")) throw err;
		throw new Error(`invalid cursor: ${msg}`);
	}
}

export interface EnvelopeCapResult<T> {
	items: T[];
	isCapped: boolean;
}

/**
 * Enforce the ENVELOPE_TARGET_BYTES soft cap by halving the rows array until
 * the JSON-serialized payload fits, or only 1 row remains (single-huge-row
 * floor — a 200 KB single row will still be returned with isCapped=true).
 */
export function enforceEnvelopeCap<T>(
	rows: T[],
	targetBytes: number = ENVELOPE_TARGET_BYTES,
): EnvelopeCapResult<T> {
	if (!Array.isArray(rows) || rows.length === 0) {
		return { items: rows, isCapped: false };
	}
	const fullText = JSON.stringify(rows);
	if (Buffer.byteLength(fullText, "utf8") <= targetBytes) {
		return { items: rows, isCapped: false };
	}
	let n = rows.length;
	let truncated: T[] = rows;
	while (n > 1) {
		n = Math.max(1, Math.floor(n / 2));
		truncated = rows.slice(0, n);
		const txt = JSON.stringify(truncated);
		if (Buffer.byteLength(txt, "utf8") <= targetBytes) break;
	}
	return { items: truncated, isCapped: true };
}

export interface PageResult<T> {
	items: T[];
	nextCursor: string | null;
	isCapped?: boolean;
}

/**
 * Assemble the canonical page envelope returned to MCP callers.
 * nextCursor is null when hasMore is false (end-of-data sentinel).
 */
export function buildPageResult<T>(input: {
	rows: T[];
	hasMore: boolean;
	nextCursor: string | null;
	isCapped?: boolean;
}): PageResult<T> {
	return {
		items: input.rows,
		nextCursor: input.hasMore ? input.nextCursor : null,
		...(input.isCapped ? { isCapped: true } : {}),
	};
}
