import {
	isPersonActorName,
	PERSON_ACTOR_PREFIX,
	personActorName,
	resolveCallerStanding,
	resolvePersonTenantAccess,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	assertMemberMayWrite,
	loadMemberWriterRoles,
} from "../memberWriterRoles";
import {
	personPrincipalLookups,
	type RosterRow,
	scopedRowFilter,
} from "./actingPrincipal";
import type { OrgScope } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// resolveHumanActor — the ONE decision "may this human act on this door, and
// under what name". Used by every task door a dashboard human reaches
// (start / complete / blockTask / create / update / pause / resume / failTask /
// deleteTask) and by the mission and briefing-note doors (`row`). No door carries its own copy of this logic.
//
// Pi rulings: a human acts in its OWN name, never under an agent's name; own
// organisation only, never across orgs; write access comes from the writer-role
// allowlist held as DATA (convex/memberWriterRoles.ts); the actor is recorded
// as "user:<Clerk subject>" (never a bare slug, so it can never be read as an
// orchestrator name).
//
// Contract. Call it ONLY when `callerOrchestrator === undefined` (the agent
// path is decided elsewhere and is untouched). It returns the actor string or
// throws a ConvexError carrying the existing RBAC_DENIED codes:
//   - master scope / signed-in-no-org / refused scope -> "callerOrchestrator is
//     required" (the human path admits only a resolved NON-master org member);
//   - `task` given and not visible to the member's org (other org, or unstamped)
//     -> tenant-boundary RBAC_DENIED;
//   - verified org_role not on the writer list -> reason "role-not-writer";
//   - `adminOnly` and role !== "org:admin" -> reason "role-not-admin".
// Order: eligibility, tenant, writer role, admin role (as the original gate).
// ─────────────────────────────────────────────────────────────────────────────

// The spelling and the reservation belong to @vantageos/cloud-identity.
export const MEMBER_ACTOR_PREFIX = PERSON_ACTOR_PREFIX;
export const ADMIN_ROLE = "org:admin";

/**
 * True when `name` is spelled like a human actor ("user:<subject>", after
 * normalizeOrchestratorId). Such a name is RESERVED: agent registration, agent
 * rename and seat provisioning refuse it, so a stored actor "user:..." can only
 * ever have been written by `memberActorOf` from a verified subject, and an
 * agent can never be named so as to read as a person.
 */
export function isHumanActorName(name: string): boolean {
	return isPersonActorName(name);
}

/** How a HUMAN org member is written down as "who did it" (verified subject only). */
export function memberActorOf(scope: OrgScope): string {
	return personActorName(scope.userId);
}

/** The TENANT compare shared by every task write site (same predicate as the readers). */
export async function assertTaskVisibleToCaller(
	ctx: QueryCtx | MutationCtx,
	task: RosterRow,
	callerScope: OrgScope,
	taskId: string,
): Promise<void> {
	await assertRowVisibleToCaller(ctx, task, callerScope, "task", taskId);
}

/**
 * Row-generic TENANT compare (tasks, missions, briefing notes). Default: the
 * same decision as the readers (the package's `filterTargetsInPersonScope`:
 * the row's organisation by permanent ID, then its agent ID on the organisation's
 * stored roster as a narrowing intersect). `tenantOnly` is for a row that carries no
 * orchestrator field at all (a briefing note): the roster leg has nothing to
 * compare and would refuse every row, so only the tenant stamp decides — an
 * absent `orgId` still never equals a resolved org slug, so an unstamped row
 * is refused.
 */
export async function assertRowVisibleToCaller(
	ctx: QueryCtx | MutationCtx,
	row: RosterRow,
	callerScope: OrgScope,
	kind: string,
	rowId: string,
	tenantOnly = false,
): Promise<void> {
	// tenantOnly: the organisation compare is the package's; the roster leg has
	// nothing to compare on a row without an agent field.
	const visible = tenantOnly
		? callerScope.orgSlug !== null &&
			resolvePersonTenantAccess({
				principal: {
					subject: callerScope.userId,
					orgSlug: callerScope.orgSlug,
					actor: memberActorOf(callerScope),
				},
				rowOrgId: row.orgId,
				door: kind,
			}).ok
		: (await (await scopedRowFilter(ctx, callerScope, kind))([row])).length === 1;
	if (!visible) {
		throw new ConvexError(
			`RBAC_DENIED: ${kind} ${rowId} is outside the caller's organisation (tenant boundary) — ${JSON.stringify({ rowId, kind, callerOrg: callerScope.orgSlug })}`,
		);
	}
}

/** Refuse a member whose verified role is not org:admin (delete / cancel). */
export function assertMemberIsAdmin(
	scope: Pick<OrgScope, "orgRole" | "orgSlug">,
	door: string,
): void {
	const role = scope.orgRole ?? null;
	if (role !== ADMIN_ROLE) {
		throw new ConvexError(
			`RBAC_DENIED: member role is not an admin role — ${JSON.stringify({
				reason: "role-not-admin",
				door,
				role,
				orgSlug: scope.orgSlug,
			})}`,
		);
	}
}

export async function resolveHumanActor(
	ctx: QueryCtx | MutationCtx,
	scope: OrgScope,
	opts: {
		door: string;
		/** Absent for create (the tenant is stamped from the scope, not compared). */
		task?: RosterRow;
		taskId?: string;
		/** Row-generic form of `task`/`taskId` for missions and briefing notes. */
		row?: RosterRow;
		rowKind?: string;
		rowId?: string;
		/** The row has no orchestrator field (briefing note): tenant stamp only. */
		tenantOnly?: boolean;
		adminOnly?: boolean;
	},
): Promise<string> {
	// WHO MAY ACT AS A HUMAN is @vantageos/cloud-identity's decision: the verified
	// session (subject + the permanent org ID + the role claim) is resolved to a
	// person principal of that org, and only a MEMBER or an ADMIN of it acts here.
	// The fleet service account, an anonymous session, a session with no
	// organisation and a session whose org ID resolves no active organisation
	// are not members, so they are refused.
	const standing = await resolveCallerStanding(
		scope.orgClerkId === undefined
			? null
			: {
					kind: "person",
					personId: scope.userId,
					verifiedOrgId: scope.orgClerkId,
					verifiedOrgRole: scope.orgRole,
				},
		personPrincipalLookups(ctx, scope.userId),
		{ adminRoles: [ADMIN_ROLE], door: opts.door },
	);
	if (
		scope.orgSlug === null ||
		(standing.standing !== "member" && standing.standing !== "admin")
	) {
		throw new ConvexError(
			`RBAC_DENIED: callerOrchestrator is required — omitting it is refused, not exempted — ${JSON.stringify({ taskId: opts.taskId })}`,
		);
	}
	if (opts.task !== undefined) {
		await assertTaskVisibleToCaller(ctx, opts.task, scope, opts.taskId ?? "");
	}
	if (opts.row !== undefined) {
		await assertRowVisibleToCaller(
			ctx,
			opts.row,
			scope,
			opts.rowKind ?? "row",
			opts.rowId ?? "",
			opts.tenantOnly === true,
		);
	}
	const writerRoles = await loadMemberWriterRoles(ctx, scope.orgSlug);
	assertMemberMayWrite(scope, writerRoles, opts.door);
	if (opts.adminOnly === true) assertMemberIsAdmin(scope, opts.door);
	return memberActorOf(scope);
}
