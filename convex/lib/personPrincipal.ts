import { ConvexError, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { lookupOrgMapping, type OrgScope } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// verifiedPerson — the bridge that lets a PERSON signed in through the MCP
// OAuth flow (#1444: Claude.ai, ChatGPT) reach the dashboard's human doors in
// its own name. Task k176ch9tamzab3dnhye94kga1d8fkbhm.
//
// Why a bridge. The MCP server reaches Convex as the fleet service account
// (mcp-server/src/authenticatedConvexClient.ts), so on a person's call
// `ctx.auth` is the service account, never the person; `resolveHumanActor`
// would see master and refuse. The person is not on `ctx.auth`, but the
// credential it presented is in `oauth_access_tokens`.
//
// What is carried. ONLY the SHA-256 hex of the bearer the person presented
// (`accessTokenHash`), the same locator the bearer middleware already used to
// resolve that call (`oauth:getAccessTokenByHash`). Nothing about WHO the
// person is travels as an argument: subject, organisation and role are re-read
// here from the token row by that hash. The validator is an exact object, so a
// subject, an org or a role cannot ride along.
//
// Who is believed. The fleet service account only (`masterSource
// "service-account"`, the same trust rule as `verifiedActor`); anyone else
// presenting it is refused, never ignored. A direct caller of the public API
// would have to hold BOTH the service account's identity and a live person
// token's hash.
//
// What it yields. The person's own OrgScope, shaped exactly like the ordinary
// member scope `withOrgScope` returns for a dashboard human (non-master; org
// from the token row's `clerkOrgSlug`; roster and scopes from that org's ACTIVE
// `client_org_mapping` row; `orgRole` from the row; `userId` = the row's Clerk
// subject). The door then runs its unchanged human path: `resolveHumanActor`
// (writer role, tenant, admin) records "user:<subject>".
// ─────────────────────────────────────────────────────────────────────────────

export const verifiedPersonValidator = v.object({
	accessTokenHash: v.string(),
});

export type VerifiedPerson = { accessTokenHash: string };

function refuse(reason: string, door: string, detail: string): never {
	throw new ConvexError(
		`RBAC_DENIED: ${detail} — ${JSON.stringify({ reason, door })}`,
	);
}

/**
 * Returns `transportScope` unchanged when no `verifiedPerson` is carried.
 * Otherwise returns the PERSON's scope or throws RBAC_DENIED. Checks, in order:
 *   1. trusted from the service account only      (verified-person-not-trusted)
 *   2. one proof, no agent proof beside it         (agent-proof-on-person-path)
 *   3. no acting name: a person acts as itself     (PERSON_ACTS_AS_ITSELF)
 *   4. the token row exists, is live, is a person  (person-token-not-live /
 *      not-a-person-token), carries an org         (person-token-no-org)
 *   5. that org is mapped and active               (org-not-active)
 */
export async function resolveVerifiedPerson(
	ctx: QueryCtx | MutationCtx,
	transportScope: OrgScope,
	proof: VerifiedPerson | undefined,
	opts: { door: string; assertedName?: string; agentProof?: boolean },
): Promise<OrgScope> {
	if (proof === undefined) return transportScope;
	const { door } = opts;

	if (
		!(
			transportScope.isMaster &&
			transportScope.masterSource === "service-account"
		)
	) {
		refuse(
			"verified-person-not-trusted",
			door,
			"verifiedPerson is a transport-verified claim and is accepted only from the fleet service account",
		);
	}
	if (opts.agentProof === true) {
		refuse(
			"agent-proof-on-person-path",
			door,
			"a person's call carries no agent credential and no verified actor",
		);
	}
	if (opts.assertedName !== undefined) {
		throw new ConvexError(
			`PERSON_ACTS_AS_ITSELF: a person acts only in its own name; this call also names "${opts.assertedName}" — ${JSON.stringify({ reason: "person-acts-as-itself", door })}`,
		);
	}

	const row = await ctx.db
		.query("oauth_access_tokens")
		.withIndex("by_tokenHash", (q) => q.eq("tokenHash", proof.accessTokenHash))
		.unique();
	if (
		row === null ||
		row.revokedAt !== undefined ||
		row.expiresAt < Date.now()
	) {
		refuse(
			"person-token-not-live",
			door,
			"verifiedPerson names no live access token",
		);
	}
	if (row.principal !== "person") {
		refuse(
			"not-a-person-token",
			door,
			"verifiedPerson names a token that does not act for a person",
		);
	}
	const orgSlug = row.clerkOrgSlug;
	if (orgSlug === undefined) {
		refuse(
			"person-token-no-org",
			door,
			"the person's token is bound to no organisation",
		);
	}
	const mapping = await lookupOrgMapping(ctx, orgSlug);
	if (mapping === null || !mapping.isActive) {
		refuse(
			"org-not-active",
			door,
			`Org "${orgSlug}" not in client_org_mapping or inactive`,
		);
	}
	return {
		userId: row.userId,
		orgSlug,
		allowedOrchestrators: mapping.allowedOrchestrators,
		scopes: mapping.scopes,
		isMaster: false,
		...(row.orgRole !== undefined ? { orgRole: row.orgRole } : {}),
	};
}
