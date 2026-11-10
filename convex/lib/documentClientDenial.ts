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

import { getDomain } from "tldts";
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

/** What a listing covers: one exact URL, every URL of a host, or every URL of a registrable domain. */
export type DenialScope = "url" | "host" | "domain";

/**
 * The key a listing is stored under. A URL is its own key; a host or a domain
 * is prefixed, so the three can never collide in the one `by_clientId` index
 * (a URL always starts with "https://").
 */
export function denialKey(scope: DenialScope, value: string): string {
	return scope === "url" ? value : `${scope}:${value}`;
}

/** The host of an https client_id URL, lower-case, no trailing dot; null when it does not parse. */
export function hostOfClientId(clientId: string): string | null {
	try {
		const host = new URL(clientId).hostname.toLowerCase().replace(/\.+$/, "");
		return host === "" ? null : host;
	} catch {
		return null;
	}
}

/**
 * The registrable domain (eTLD+1) of a host from the Public Suffix List, private
 * suffixes included (the same rule as mcp-server `domainKeyOf`): `evil.vercel.app`
 * and `victim.vercel.app` are different domains. A host with none returns null.
 */
export function registrableDomainOf(host: string): string | null {
	return getDomain(host, { allowPrivateDomains: true });
}

/**
 * The row that denies `clientId` now, or null: the exact URL, its host, or its
 * registrable domain, whichever is listed and active. The URL row is read first
 * so the answer names the narrowest listing.
 */
export async function activeDocumentClientDenial(
	ctx: Reader,
	clientId: string,
): Promise<Doc<"oauth_denied_document_clients"> | null> {
	const own = await documentClientRow(ctx, clientId);
	if (own?.active) return own;
	const host = hostOfClientId(clientId);
	if (host === null) return null;
	const byHost = await documentClientRow(ctx, denialKey("host", host));
	if (byHost?.active) return byHost;
	const domain = registrableDomainOf(host);
	if (domain === null) return null;
	const byDomain = await documentClientRow(ctx, denialKey("domain", domain));
	return byDomain?.active ? byDomain : null;
}

/**
 * True when `clientId` is a listed Client ID Metadata Document client, by its
 * exact URL, its host or its registrable domain. The id's shape
 * is not trusted: an opaque id parses to no host and costs one read. The grant is derived here at request time: a token minted
 * before a host or domain listing stops answering the moment it is listed.
 */
export async function isDocumentClientDenied(
	ctx: Reader,
	clientId: string,
): Promise<boolean> {
	return (await activeDocumentClientDenial(ctx, clientId)) !== null;
}
