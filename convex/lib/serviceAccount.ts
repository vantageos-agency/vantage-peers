// The FLEET SERVICE ACCOUNT, resolved from data (module M2 part 2).
//
// Before: a caller was the service account when its verified subject equalled
// the environment variable CLERK_SERVICE_ACCOUNT_USER_ID, with no organisation
// anywhere in the decision. Now the authority is stored:
//
//   verified subject
//     -> the `agents` row (kind "service") carrying it as `authSubject`
//     -> that row's organisation, by permanent org ID: the operator org's
//        mapping row, whose `serviceAccountAgentId` column must name the row back
//     -> the row judged active, of the operator org, by the package
//     -> a `fleet` principal, built and judged by @vantageos/cloud-identity
//        (resolveActingPrincipal over ID-keyed lookups).
//
// An absent column, an absent or inactive row, a row of another kind, a row
// that carries another subject, and a row whose organisation is not the
// operator org each REFUSE with a typed reason. Nothing here reads the environment, and
// nothing falls back to it. The one place the old environment value is read is
// the one-off backfill (migrations/linkServiceAccountAgent), which writes it
// into data once.

import {
	type ActingPrincipal,
	resolveActingPrincipal,
} from "@vantageos/cloud-identity";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { serviceAccountPrincipalLookups } from "./actingPrincipal";
import { lookupOrgMapping } from "./authOrgMapping";

export type ServiceAccountResolution =
	| { ok: true; principal: ActingPrincipal; operatorOrgId: string }
	| {
			ok: false;
			/**
			 * True when the subject IS the `authSubject` of a `kind: "service"` row:
			 * the caller claims to be a service account, so a failed resolution is a
			 * refusal. False when no such row exists: the caller is simply not a
			 * service account and is judged as an ordinary caller.
			 */
			claimsServiceAccount: boolean;
			reason: string;
	  };

/**
 * Is `subject` the fleet service account? Decided from stored rows only.
 * `ctx` needs a database reader; the function never writes.
 *
 * The chain is read from the subject outward and confirmed from the mapping
 * inward: a `kind: "service"` row carrying the subject names an organisation;
 * THAT organisation's mapping row (by its permanent org ID) must name the row
 * back in `serviceAccountAgentId`. The mapping column is the authority; the
 * agents row alone grants nothing.
 */
export async function resolveServiceAccount(
	ctx: Pick<QueryCtx, "db">,
	subject: string,
	door: string,
): Promise<ServiceAccountResolution> {
	// A subject that is no `authSubject` of a service row is not claiming to be
	// the service account: one indexed read, so the ordinary caller pays no more.
	const claimed = await ctx.db
		.query("agents")
		.withIndex("by_auth_subject_kind", (q) =>
			q.eq("authSubject", subject).eq("kind", "service"),
		)
		.take(8);
	if (claimed.length === 0) {
		return {
			ok: false,
			claimsServiceAccount: false,
			reason: "not-service-account",
		};
	}

	let reason = "service-account-absent";
	for (const row of claimed) {
		const judged = await judgeServiceRow(ctx, row, subject, door);
		if (judged.ok) return judged;
		reason = judged.reason;
	}
	return { ok: false, claimsServiceAccount: true, reason };
}

type RowJudgement =
	| { ok: true; principal: ActingPrincipal; operatorOrgId: string }
	| { ok: false; reason: string };

/** One candidate service row, confirmed from the operator mapping inward. */
async function judgeServiceRow(
	ctx: Pick<QueryCtx, "db">,
	row: Doc<"agents">,
	subject: string,
	door: string,
): Promise<RowJudgement> {
	if (row.clerkOrgId === undefined) {
		return { ok: false, reason: "service-account-org-id-not-filled" };
	}
	const mapping = await lookupOrgMapping(ctx, { clerkOrgId: row.clerkOrgId });
	// The operator org's mapping must name THIS row. An absent column, a column
	// naming another row, an unreadable or two-claimed org ID all stop here.
	if (mapping === null) return { ok: false, reason: "operator-org-unreadable" };
	const serviceAccountId = mapping.serviceAccountAgentId;
	if (serviceAccountId === undefined || serviceAccountId !== row._id) {
		return { ok: false, reason: "service-account-absent" };
	}
	const resolved = await resolveActingPrincipal(
		{ kind: "service", serviceAccountId },
		serviceAccountPrincipalLookups(ctx, subject),
		door,
	);
	if (!resolved.ok) return { ok: false, reason: resolved.refusal.reason };
	const { principal } = resolved;
	// `fleet` is the package's verdict that the row's stored organisation is the
	// operator org (orgKindOf, from the mapping's orgKind). A service account of
	// any other organisation resolves as `service`, never as the fleet.
	if (
		principal.kind !== "fleet" ||
		principal.orgId !== row.clerkOrgId ||
		principal.principalId !== serviceAccountId
	) {
		return { ok: false, reason: "not-the-operator-service-account" };
	}
	return { ok: true, principal, operatorOrgId: principal.orgId };
}
