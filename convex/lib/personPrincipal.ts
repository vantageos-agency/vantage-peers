import {
	checkPersonCallShape,
	type PersonRefusal,
	resolvePersonPrincipal,
} from "@vantageos/cloud-identity";
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

// The package's typed refusal, said in this backend's wire shape. The DECISION
// is @vantageos/cloud-identity's; only the transport (a ConvexError carrying
// its code as the prefix and {reason, door} as the payload) is local.
function refuseWith(r: PersonRefusal): never {
	throw new ConvexError(
		`${r.code}: ${r.detail} — ${JSON.stringify({ reason: r.reason, door: r.door })}`,
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
	const shape = checkPersonCallShape({
		door,
		...(opts.agentProof === true ? { agentProof: true } : {}),
		...(opts.assertedName !== undefined
			? { actingName: opts.assertedName }
			: {}),
	});
	if (shape !== null) refuseWith(shape);

	const row = await ctx.db
		.query("oauth_access_tokens")
		.withIndex("by_tokenHash", (q) => q.eq("tokenHash", proof.accessTokenHash))
		.unique();
	const resolved = await resolvePersonPrincipal(
		row === null
			? null
			: {
					subject: row.userId,
					expiresAt: row.expiresAt,
					...(row.principal !== undefined ? { principal: row.principal } : {}),
					...(row.clerkOrgSlug !== undefined
						? { orgSlug: row.clerkOrgSlug }
						: {}),
					...(row.orgRole !== undefined ? { orgRole: row.orgRole } : {}),
					...(row.revokedAt !== undefined ? { revokedAt: row.revokedAt } : {}),
				},
		{
			now: Date.now(),
			lookupOrganisation: (slug) => lookupOrgMapping(ctx, slug),
		},
		door,
	);
	if (!resolved.ok) refuseWith(resolved.refusal);
	const { principal, organisation: mapping } = resolved;
	return {
		userId: principal.subject,
		orgSlug: principal.orgSlug,
		allowedOrchestrators: mapping.allowedOrchestrators,
		allowedAgentIds: mapping.allowedAgentIds ?? [],
		fleetWide: false,
		scopes: mapping.scopes,
		isMaster: false,
		...(principal.orgRole !== undefined ? { orgRole: principal.orgRole } : {}),
	};
}
