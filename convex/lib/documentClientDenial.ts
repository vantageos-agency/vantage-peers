/**
 * The operator's deny-list of Client ID Metadata Document clients: the ONE place
 * that reads it. Every reader of an access-token row (oauth:getAccessTokenByHash,
 * resolveVerifiedPerson, the orgRoster token readers) asks `isDocumentClientDenied`
 * and none copies the query (.claude/rules/rights-change-migrates-live-connections.md
 * rule 5: a path is not a connection).
 *
 * The row is kept after an unlisting (`active: false`, with its `history`), so the
 * audit survives; only an ACTIVE row denies.
 */

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

type Reader = Pick<QueryCtx, "db">;

/** The row of a client_id in any state (listed, or unlisted with its history). */
export async function documentClientRow(
	ctx: Reader,
	clientId: string,
): Promise<Doc<"oauth_denied_document_clients"> | null> {
	return await ctx.db
		.query("oauth_denied_document_clients")
		.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
		.unique();
}

/** The row when the client is listed now; null otherwise. */
export async function activeDocumentClientDenial(
	ctx: Reader,
	clientId: string,
): Promise<Doc<"oauth_denied_document_clients"> | null> {
	const row = await documentClientRow(ctx, clientId);
	return row?.active ? row : null;
}

/**
 * True when `clientId` is a listed Client ID Metadata Document client. A
 * client_id that is not an https URL is never listed (registered clients have
 * their own revocation) and costs no read.
 */
export async function isDocumentClientDenied(
	ctx: Reader,
	clientId: string,
): Promise<boolean> {
	if (!clientId.startsWith("https://")) return false;
	return (await activeDocumentClientDenial(ctx, clientId)) !== null;
}
