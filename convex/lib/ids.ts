import { ConvexError } from "convex/values";
import type { Id, TableNames } from "../_generated/dataModel";

/**
 * Structured payload carried by every wrong-table rejection.
 *
 * It travels on `ConvexError.data`, which is the ONLY channel Convex does not
 * redact in prod: a plain `Error` (including the `v.id()` validator's own
 * rejection) reaches the client as `[Request ID: …] Server Error` with
 * `error.data` undefined. Measured, not assumed — see PR #1069.
 *
 * `mcp-server`'s `mcpConvexError` prefers `error.data`, so this payload surfaces
 * to MCP callers verbatim, with no boundary change.
 *
 * Note the two runtime shapes of `.data`: a JSON **string** under `convex-test`,
 * the thrown **object** against prod. Consumers must tolerate both.
 */
export type WrongTablePayload = {
	path: string;
	expectedTable: TableNames;
	receivedId: string;
	message: string;
};

/** Minimal surface needed: works for both query and mutation ctx. */
type NormalizeCtx = {
	db: {
		normalizeId: <T extends TableNames>(table: T, id: string) => Id<T> | null;
	};
};

/**
 * Narrow a caller-supplied string to an `Id<table>`, or throw an actionable
 * `ConvexError` naming the offending argument.
 *
 * Why a helper and not `v.id(table)` in the args validator: the validator runs
 * BEFORE the handler, so there is no seam at which to intercept its rejection
 * and enrich it. Arguments carrying document IDs must therefore be declared
 * `v.string()` and narrowed here, on the first line of the handler.
 *
 * `hint` should tell the caller where to obtain the right ID (e.g. "use the
 * receiptId returned by check_messages"). It is appended to `message`.
 *
 * A well-formed ID of the RIGHT table that points at a deleted document is NOT
 * an error here — `normalizeId` accepts it and the caller's `ctx.db.get` returns
 * `null`, preserving the existing contract.
 */
export function requireId<T extends TableNames>(
	ctx: NormalizeCtx,
	table: T,
	raw: string,
	path: string,
	hint?: string,
): Id<T> {
	const normalized = ctx.db.normalizeId(table, raw);
	if (normalized !== null) return normalized;

	const base = `${path} is not a valid ${table} ID.`;
	throw new ConvexError({
		path,
		expectedTable: table,
		receivedId: raw,
		message: hint ? `${base} ${hint}` : base,
	} satisfies WrongTablePayload);
}
