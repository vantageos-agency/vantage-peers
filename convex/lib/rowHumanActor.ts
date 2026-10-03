import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	assertMemberMayWrite,
	loadMemberWriterRoles,
} from "../memberWriterRoles";
import type { OrgScope } from "./auth";
import { isOrchestratorOnOrgRoster } from "./auth";
import { assertMemberIsAdmin, memberActorOf } from "./humanActor";

// ─────────────────────────────────────────────────────────────────────────────
// resolveHumanRowActor — the ROW-GENERIC sibling of `resolveHumanActor`
// (convex/lib/humanActor.ts), for the doors whose row is not a task: messages,
// diary, business units, recurring tasks. Task k17d5k5bw741p3681bc0pq76ah8fk4sn
// (Admin CRUD B2).
//
// It is an ADAPTER, not a second authority: it calls the same underlying checks
// resolveHumanActor calls (`loadMemberWriterRoles` + `assertMemberMayWrite` for
// the writer allowlist held as DATA, `assertMemberIsAdmin` for destructive acts,
// `memberActorOf` for the "user:<Clerk subject>" name). Only the TENANT compare
// differs, because these tables do not all carry the same tenant key:
//
//   - "stamp":  the row carries the org slug it belongs to (`messages.tenantId`,
//               `recurringTasks.orgId`). The stamp must EQUAL the caller's org
//               slug — an absent stamp denies, never grants (`undefined` is never
//               equal to a resolved slug). `assignedTo`, when the row has one,
//               narrows (roster intersect), the same rule `recurringTasks:update`
//               applies. (`isRowVisibleToScope` is not used: its roster leg
//               denies any row without an assignee, which is every message.)
//   - "roster": the table has NO org column (`diary.orchestrator`,
//               `businessUnits.orchestratorId`); its readers key the tenant on
//               the org's own roster, so the human path does too — the row's owner
//               name must be on the caller's roster (normalised, "*" names nobody).
//               DECLARED LIMIT: a roster is a NAME membership test; two orgs whose
//               rosters carry the same name are not told apart by it. That is the
//               readers' own limit, kept so the write cannot reach a row the
//               caller's read cannot.
//   - "create": no existing row; the tenant is stamped from the scope by the
//               caller, not compared.
//
// Order (as resolveHumanActor): eligibility, tenant, writer role, admin role.
// Call ONLY when the caller-name argument is ABSENT (the agent path is decided
// elsewhere and untouched). Refusals reuse the RBAC_DENIED codes of the task doors.
// ─────────────────────────────────────────────────────────────────────────────

export type HumanRowTenant =
	| { kind: "stamp"; row: { orgId?: string; assignedTo?: string } }
	| { kind: "roster"; owner: string }
	| { kind: "create" };

export async function resolveHumanRowActor(
	ctx: QueryCtx | MutationCtx,
	scope: OrgScope,
	opts: {
		door: string;
		/** What is being acted on, for the refusal text (e.g. "message <id>"). */
		subject: string;
		tenant: HumanRowTenant;
		adminOnly?: boolean;
	},
): Promise<string> {
	if (scope.isMaster || scope.orgSlug === null || scope.refused === true) {
		throw new ConvexError(
			`RBAC_DENIED: caller name is required — omitting it is refused, not exempted — ${JSON.stringify({ door: opts.door, subject: opts.subject })}`,
		);
	}
	const tenant = opts.tenant;
	if (
		tenant.kind === "stamp" &&
		(tenant.row.orgId !== scope.orgSlug ||
			(tenant.row.assignedTo !== undefined &&
				!isOrchestratorOnOrgRoster(scope, tenant.row.assignedTo)))
	) {
		throw new ConvexError(
			`RBAC_DENIED: ${opts.subject} is outside the caller's organisation (tenant boundary) — ${JSON.stringify({ door: opts.door, callerOrg: scope.orgSlug })}`,
		);
	}
	if (tenant.kind === "roster" && !isOrchestratorOnOrgRoster(scope, tenant.owner)) {
		throw new ConvexError(
			`RBAC_DENIED: ${opts.subject} is outside the caller's organisation (tenant boundary) — ${JSON.stringify({ door: opts.door, callerOrg: scope.orgSlug, reason: "owner-not-on-roster" })}`,
		);
	}
	const writerRoles = await loadMemberWriterRoles(ctx, scope.orgSlug);
	assertMemberMayWrite(scope, writerRoles, opts.door);
	if (opts.adminOnly === true) assertMemberIsAdmin(scope, opts.door);
	return memberActorOf(scope);
}
