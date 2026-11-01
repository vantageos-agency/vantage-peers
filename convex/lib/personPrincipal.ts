import {
	assertTargetBelongsTo,
	checkPersonCallShape,
	type PersonRefusal,
	resolveActingPrincipal,
	resolvePersonPrincipal,
} from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	personPrincipalLookups,
	refuseWith as refuseIdentity,
	requireServiceAccountForClaim,
} from "./actingPrincipal";
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

// The package's typed refusal, said in this backend's wire shape. The DECISION
// is @vantageos/cloud-identity's; only the transport (a ConvexError carrying
// its code as the prefix and {reason, door} as the payload) is local.
export function refuseWith(r: PersonRefusal): never {
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

	requireServiceAccountForClaim(transportScope, "verifiedPerson", door);
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
	// Under an acting org the person must be a member of THAT organisation, judged
	// by the package by its permanent ID (the same resolver as the ID path below).
	if (transportScope.serviceTransport === true) {
		const inActingOrg = await resolveActingPrincipal(
			{
				kind: "person",
				personId: principal.subject,
				verifiedOrgId: transportScope.orgClerkId ?? "",
				...(principal.orgRole !== undefined
					? { verifiedOrgRole: principal.orgRole }
					: {}),
			},
			personPrincipalLookups(ctx, principal.subject),
			door,
		);
		if (!inActingOrg.ok) refuseIdentity(inActingOrg.refusal);
		const sameAsToken = await assertTargetBelongsTo(
			inActingOrg.principal,
			{ orgId: mapping.clerkOrgId },
			personPrincipalLookups(ctx, principal.subject),
			{ door },
		);
		if (!sameAsToken.ok) refuseIdentity(sameAsToken.refusal);
	}
	// `resolvePersonPrincipal` selects the organisation by the LABEL the token
	// was minted under, and a label is renamable: after a rename another
	// organisation can hold it, and the lookup above then answers THAT
	// organisation. Where the token carries the permanent org ID, the package
	// proves the person in that organisation by ID, and the organisation the
	// label resolved to must be that same one, or the call is refused.
	if (row?.clerkOrgId !== undefined) {
		const lookups = personPrincipalLookups(ctx, principal.subject);
		const byId = await resolveActingPrincipal(
			{
				kind: "person",
				personId: principal.subject,
				verifiedOrgId: row.clerkOrgId,
				...(principal.orgRole !== undefined
					? { verifiedOrgRole: principal.orgRole }
					: {}),
			},
			lookups,
			door,
		);
		if (!byId.ok) refuseIdentity(byId.refusal);
		const sameOrganisation = await assertTargetBelongsTo(
			byId.principal,
			{ orgId: mapping.clerkOrgId },
			lookups,
			{ door },
		);
		if (!sameOrganisation.ok) refuseIdentity(sameOrganisation.refusal);
	}
	return {
		userId: principal.subject,
		orgSlug: principal.orgSlug,
		// The org's permanent ID, from the mapping row resolved above, so row
		// ownership compares IDs (M4: no label fallback on a row compare).
		...(mapping.clerkOrgId !== undefined
			? { orgClerkId: mapping.clerkOrgId }
			: {}),
		allowedOrchestrators: mapping.allowedOrchestrators,
		allowedAgentIds: mapping.allowedAgentIds ?? [],
		fleetWide: false,
		scopes: mapping.scopes,
		isMaster: false,
		...(principal.orgRole !== undefined ? { orgRole: principal.orgRole } : {}),
	};
}
