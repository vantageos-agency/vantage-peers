import { hasFleetRead } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import { MutationCtx, mutation, query } from "./_generated/server";
import { sameOrg } from "@vantageos/cloud-identity";
import { anonymousRefusal } from "./lib/agentIdentity";
import {
	lookupOrgMapping,
	proveOrgAdmin,
	requireResolvedCaller,
	withOrgScope,
} from "./lib/auth";
import { orgRefOfScope } from "./lib/authOrgMapping";
import { clerkOrgIdForSlug } from "./lib/orgClerkId";

// ─────────────────────────────────────────────────────────────────────────────
// orgMembership — audit record of who administers which organisation.
// Task k17a7t4a9d4hx11sgj2tcdf7kx8et4cp.
//
// AUDIT RECORD, WITH ONE NARROW READ. See the table comment in
// convex/schema.ts. `requireOrgAdmin` (convex/lib/auth.ts) keeps deciding admin
// status from the verified `org_role` JWT claim, unchanged. Nothing in this
// module decides whether an action is allowed — it answers "who
// administers/belongs to which org". The one read that is not display: the
// package's agent-owner proof (`resolveCallerFromAgentCredential`, through
// `agentCallerDeps` in convex/lib/actingPrincipal.ts) asks, by (org ID, person
// ID), whether an agent's OWNER is still a member. That read can only WITHHOLD:
// it gates an agent that is already bound to an owner, and a missing or
// deactivated row refuses it.
// ─────────────────────────────────────────────────────────────────────────────

const membershipShape = v.object({
	clerkOrgSlug: v.string(),
	clerkUserId: v.string(),
	role: v.union(v.literal("admin"), v.literal("member")),
	createdAt: v.number(),
	updatedAt: v.number(),
	deactivatedAt: v.optional(v.number()),
});

function toShape(row: {
	clerkOrgSlug: string;
	clerkUserId: string;
	role: "admin" | "member";
	createdAt: number;
	updatedAt: number;
	deactivatedAt?: number;
}) {
	return {
		clerkOrgSlug: row.clerkOrgSlug,
		clerkUserId: row.clerkUserId,
		role: row.role,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		...(row.deactivatedAt !== undefined
			? { deactivatedAt: row.deactivatedAt }
			: {}),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertAdminMembership — the ONE write path onto orgMembership. Called
// exclusively from convex/oauth.ts's `provisionOrganization`, org-admin
// path (a verified human subject exists there; the master/callerToken path
// records nothing — see that mutation's comment and the PR body "Why").
//
// Idempotent: provisioning the same org twice (the mutation's replay
// branch) must leave exactly one row for (clerkOrgSlug, clerkUserId), never
// a duplicate — looked up by the `by_org_user` index with `.unique()`.
//
// allow-local-identity: writes the orgMembership AUDIT record (schema.ts: "AUDIT RECORD ONLY - NEVER AN AUTHORISATION SOURCE"); nothing here decides whether anyone may act, that stays the package's org-admin proof over the verified session
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertAdminMembership(
	ctx: MutationCtx,
	clerkOrgSlug: string,
	clerkUserId: string,
): Promise<void> {
	const now = Date.now();
	const existing = await ctx.db
		.query("orgMembership")
		.withIndex("by_org_user", (q) =>
			q.eq("clerkOrgSlug", clerkOrgSlug).eq("clerkUserId", clerkUserId),
		)
		.unique();

	if (existing) {
		if (existing.role !== "admin") {
			await ctx.db.patch(existing._id, { role: "admin", updatedAt: now });
		}
		return;
	}

	await ctx.db.insert("orgMembership", {
		clerkOrgSlug,
		clerkOrgId: await clerkOrgIdForSlug(ctx, clerkOrgSlug),
		clerkUserId,
		role: "admin",
		createdAt: now,
		updatedAt: now,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// getMembership — answers BOTH directions, authorised from the VERIFIED
// identity only (withOrgScope), never from a caller-supplied argument
// naming who is asking.
//
//   args.clerkOrgSlug present  → "who administers/belongs to org X". X is a
//     LABEL: it is resolved to its mapping row and read BY THE ORG'S
//     PERMANENT ID (`by_org_clerk_id`); the caller's own org is compared by
//     ID too. A row stamped with a label only (no org ID yet) is not served
//     until `backfill_org_clerk_id` fills it.
//     Master / service-account (scope.isMaster) may ask about ANY
//     organisation. An org-scoped caller may ask ONLY about its OWN
//     organisation (same org ID) — asking about any
//     other org is refused with RBAC_DENIED, not an empty list, so there is
//     no existence oracle.
//
//   args.clerkOrgSlug absent   → "which orgs does the CALLER belong to",
//     keyed on the caller's own verified subject (scope.userId) — never a
//     caller-supplied clerkUserId.
//
// An anonymous caller (no verified identity at all — withOrgScope's
// fail-closed default) is refused with RBAC_DENIED BEFORE any db read, so
// there is no existence oracle on that path either.
//
// BOUND — both reads below are catalog-scale (one row per org-admin per
// org — the same scale as `client_org_mapping`/`oauth_scope_profiles`,
// never per-memory or per-message volume), so a bounded read at this
// rare, admin/audit-only surface is the correct tool, mirroring
// `findSeatNameCollision`'s `SEAT_NAME_COLLISION_SCAN_LIMIT` discipline in
// convex/oauth.ts. `.take(MEMBERSHIP_QUERY_LIMIT)` replaces `.collect()`;
// hitting the limit exactly means rows beyond it were never read —
// silently returning a partial membership list in that case would
// misinform an admin/audit caller about who actually holds an org, so
// this throws `MEMBERSHIP_QUERY_INCOMPLETE` instead of resolving a
// truncated array.
// ─────────────────────────────────────────────────────────────────────────────
// Exported so the test suite seeds exactly this many rows to prove the
// MEMBERSHIP_QUERY_INCOMPLETE refusal fires, rather than hard-coding 1000
// in two places that could silently drift apart.
export const MEMBERSHIP_QUERY_LIMIT = 1000;

function assertNotTruncated(rowCount: number, describe: string): void {
	if (rowCount === MEMBERSHIP_QUERY_LIMIT) {
		throw new ConvexError(
			`MEMBERSHIP_QUERY_INCOMPLETE: orgMembership read for ${describe} hit its ${MEMBERSHIP_QUERY_LIMIT}-row bound before finishing — refusing to return a truncated membership list`,
		);
	}
}

// allow-local-identity: reads the orgMembership AUDIT record to answer "who administers which organisation"; it is never an authorisation source (schema.ts), and who may ask is decided by the package (hasFleetRead, sameOrg) over the verified scope
// fleet-wide: the fleet (service account or operator human) may ask about ANY organisation's administrators by purpose, this is the operator audit read; an organisation-scoped caller is confined to its own organisation by org ID
export const getMembership = query({
	args: { clerkOrgSlug: v.optional(v.string()) },
	returns: v.array(membershipShape),
	handler: async (ctx, args) => {
		// isolation-contract: no reactive subscriber exists — enumerated at /root/coding/vantage-peers-dashboard@71da625 with `grep -rn 'api\.orgMembership\.getMembership' --include=*.tsx --include=*.ts app components hooks lib contexts providers` -> 0 matches. Only the dashboard was enumerated; other callers were not individually traced. R-50 declared divergence (a claim, verified against that enumeration).
		// R-50: reactively-subscribed public query — refuseWithoutThrow
		// narrows the signed-in-no-org branch to a typed refused scope
		// instead of a throw. The pre-existing anonymous-caller throw below
		// is UNCHANGED (out of this brief's scope, a distinct caller class).
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });

		// A caller presenting no credential at all is refused by RAISING, before
		// any db.query call (`requireResolvedCaller`: the one refusal helper).
		requireResolvedCaller(scope, "orgMembership:getMembership");

		// A signed-in caller with no organisation yet (scope.refused) has no
		// "own org" to compare against — a typed empty result, not a throw,
		// regardless of which org (if any) was requested.
		if (scope.refused) {
			return [];
		}

		if (args.clerkOrgSlug !== undefined) {
			// The argument is a LABEL naming the org to read. It is resolved to its
			// mapping row and the two organisations are compared by their permanent
			// IDs (`sameOrg`): a member of a NEW org that took a freed slug is not a
			// member of the org the stale label used to name, and a renamed org keeps
			// its members. The service account and the operator admin (master) may
			// read any org.
			const target = await lookupOrgMapping(ctx, args.clerkOrgSlug);
			if (
				!hasFleetRead(scope) &&
				!(
					target?.isActive === true &&
					sameOrg({ id: target.clerkOrgId }, orgRefOfScope(scope))
				)
			) {
				throw new ConvexError(
					`RBAC_DENIED: caller may only read membership for its own organisation — ${JSON.stringify(
						{ requested: args.clerkOrgSlug, reason: "not-own-organisation" },
					)}`,
				);
			}
			// An org no mapping holds, or one with no ID yet, has no members to name.
			const targetOrgId = target?.clerkOrgId;
			if (targetOrgId === undefined) return [];
			// Narrow before bound: the read is keyed on the org ID.
			const rows = await ctx.db
				.query("orgMembership")
				.withIndex("by_org_clerk_id", (q) => q.eq("clerkOrgId", targetOrgId))
				.take(MEMBERSHIP_QUERY_LIMIT);
			assertNotTruncated(rows.length, `org "${args.clerkOrgSlug}"`);
			return rows.map(toShape);
		}

		const rows = await ctx.db
			.query("orgMembership")
			.withIndex("by_user", (q) => q.eq("clerkUserId", scope.userId))
			.take(MEMBERSHIP_QUERY_LIMIT);
		assertNotTruncated(rows.length, `subject "${scope.userId}"`);
		return rows.map(toShape);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// setMember — an organisation ADMINISTRATOR records a person as a member of
// its own organisation, or marks the person deactivated (and back). This is the
// row the agent-owner proof reads: an agent bound to a person is served only
// while that person's row here is present and not deactivated.
//
// Gated by the package's org-admin proof (`proveOrgAdmin`, org ID against the
// verified session), no master carve-out. The row is keyed by the org's
// permanent ID. RETURNS `{ recorded, active }`: `recorded` is true when this
// call created the row; `active` is the state now stored.
// ─────────────────────────────────────────────────────────────────────────────
export const setMember = mutation({
	args: {
		orgSlug: v.string(),
		clerkUserId: v.string(),
		active: v.boolean(),
	},
	returns: v.object({ recorded: v.boolean(), active: v.boolean() }),
	handler: async (ctx, args) => {
		// write-contract: imperative admin door, no subscriber — 0 call sites in mcp-server/src, mcp-server/server-http.ts, scripts and the dashboard for "orgMembership:setMember" (new door, measured with `git grep -n "setMember" -- mcp-server scripts`); proveOrgAdmin refuses a caller with no organisation RBAC_DENIED at an imperative call, never at a render.
		const door = "orgMembership:setMember";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const proof = await proveOrgAdmin(ctx, identity, args.orgSlug, door);
		const orgId = proof.org.id;
		const now = Date.now();
		const existing = await ctx.db
			.query("orgMembership")
			.withIndex("by_org_user_clerk_id", (q) =>
				q.eq("clerkOrgId", orgId).eq("clerkUserId", args.clerkUserId),
			)
			.unique();
		if (existing === null) {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: proof.org.label,
				clerkOrgId: orgId,
				clerkUserId: args.clerkUserId,
				role: "member",
				createdAt: now,
				updatedAt: now,
				...(args.active ? {} : { deactivatedAt: now }),
			});
			return { recorded: true, active: args.active };
		}
		await ctx.db.patch(existing._id, {
			updatedAt: now,
			deactivatedAt: args.active ? undefined : (existing.deactivatedAt ?? now),
		});
		return { recorded: false, active: args.active };
	},
});
