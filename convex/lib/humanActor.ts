import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	assertMemberMayWrite,
	loadMemberWriterRoles,
} from "../memberWriterRoles";
import type { OrgScope } from "./auth";
import { isOrchestratorOnOrgRoster, isRowVisibleToScope } from "./auth";

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
//   - `row` + `tenantOnly` (stamp compare) / `rosterOwner` (roster compare) for
//     messages, recurring tasks, diary and business units; neither = create;
//   - verified org_role not on the writer list -> reason "role-not-writer";
//   - `adminOnly` and role !== "org:admin" -> reason "role-not-admin".
// Order: eligibility, tenant, writer role, admin role (as the original gate).
// ─────────────────────────────────────────────────────────────────────────────

export const MEMBER_ACTOR_PREFIX = "user:";
export const ADMIN_ROLE = "org:admin";

/** How a HUMAN org member is written down as "who did it" (verified subject only). */
export function memberActorOf(scope: OrgScope): string {
	return `${MEMBER_ACTOR_PREFIX}${scope.userId}`;
}

/** The TENANT compare shared by every task write site (same predicate as the readers). */
export function assertTaskVisibleToCaller(
	task: { orgId?: string; assignedTo?: string; pilot?: string },
	callerScope: OrgScope,
	taskId: string,
): void {
	assertRowVisibleToCaller(task, callerScope, "task", taskId);
}

/**
 * Row-generic TENANT compare (tasks, missions, briefing notes). Default: the
 * same predicate as the readers (`isRowVisibleToScope`: tenant gate, then the
 * roster as a narrowing intersect). `tenantOnly` is for a row that carries no
 * orchestrator field at all (a briefing note): the roster leg has nothing to
 * compare and would refuse every row, so only the tenant stamp decides — an
 * absent `orgId` still never equals a resolved org slug, so an unstamped row
 * is refused.
 */
export function assertRowVisibleToCaller(
	row: { orgId?: string; assignedTo?: string; pilot?: string },
	callerScope: OrgScope,
	kind: string,
	rowId: string,
	tenantOnly = false,
): void {
	const visible = tenantOnly
		? callerScope.orgSlug !== null && row.orgId === callerScope.orgSlug
		: isRowVisibleToScope(callerScope, row);
	if (!visible) {
		throw new ConvexError(
			`RBAC_DENIED: ${kind} ${rowId} is outside the caller's organisation (tenant boundary) — ${JSON.stringify({ rowId, kind, callerOrg: callerScope.orgSlug })}`,
		);
	}
}

/**
 * ROSTER tenant compare, for a row whose table has NO org column (diary,
 * business units): the row's owner name must be on the caller's own roster
 * (normalised, "*" names nobody) — the key those tables' readers use.
 * DECLARED LIMIT: a roster is a NAME membership test; two orgs whose rosters
 * carry the same name are not told apart by it.
 */
export function assertOwnerOnCallerRoster(
	owner: string,
	callerScope: OrgScope,
	kind: string,
	rowId: string,
): void {
	if (callerScope.orgSlug === null || !isOrchestratorOnOrgRoster(callerScope, owner)) {
		throw new ConvexError(
			`RBAC_DENIED: ${kind} ${rowId} is outside the caller's organisation (tenant boundary) — ${JSON.stringify({ rowId, kind, callerOrg: callerScope.orgSlug, reason: "owner-not-on-roster" })}`,
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
		task?: { orgId?: string; assignedTo?: string; pilot?: string };
		taskId?: string;
		/** Row-generic form of `task`/`taskId` for missions and briefing notes. */
		row?: { orgId?: string; assignedTo?: string; pilot?: string };
		rowKind?: string;
		rowId?: string;
		/** The row has no orchestrator field (briefing note): tenant stamp only. */
		tenantOnly?: boolean;
		/** The row has no org column (diary, business unit): its owner name must be on the caller's roster. */
		rosterOwner?: string;
		adminOnly?: boolean;
	},
): Promise<string> {
	if (scope.isMaster || scope.orgSlug === null || scope.refused === true) {
		throw new ConvexError(
			`RBAC_DENIED: callerOrchestrator is required — omitting it is refused, not exempted — ${JSON.stringify({ taskId: opts.taskId })}`,
		);
	}
	if (opts.task !== undefined) {
		assertTaskVisibleToCaller(opts.task, scope, opts.taskId ?? "");
	}
	if (opts.row !== undefined) {
		assertRowVisibleToCaller(
			opts.row,
			scope,
			opts.rowKind ?? "row",
			opts.rowId ?? "",
			opts.tenantOnly === true,
		);
	}
	if (opts.rosterOwner !== undefined) {
		assertOwnerOnCallerRoster(opts.rosterOwner, scope, opts.rowKind ?? "row", opts.rowId ?? "");
	}
	const writerRoles = await loadMemberWriterRoles(ctx, scope.orgSlug);
	assertMemberMayWrite(scope, writerRoles, opts.door);
	if (opts.adminOnly === true) assertMemberIsAdmin(scope, opts.door);
	return memberActorOf(scope);
}
