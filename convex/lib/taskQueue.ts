// taskQueue — the explicit per-assignee task queue (task k174gp4nejkdmh4wt6zb7tgy1x8jvhpc).
//
// Two things live here, both pure of the task doors that use them:
//
//   1. compareQueueOrder — the ONE comparator of a queue: ranked tasks first by
//      `queueRank` ascending, then unranked tasks by priority (urgent > high >
//      medium > low), then by creation time ascending. `tasks:list { sort:"queue" }`
//      and `tasks:nextForAssignee` both read it, so the two can never disagree.
//
//   2. requireQueueAuthority — who may reorder an assignee's queue, decided at
//      REQUEST TIME from the verified principal and the live organisation mapping
//      (rule authority-attached-to-anonymous-object: the principal is read first,
//      the mapping is consulted by the principal's own org, an unresolved caller or
//      a lookup miss is a refusal, never a default). Allowed iff
//        (a) the caller IS the assignee (actor ID === assignee ID), or
//        (b) the signed-in person is org:admin of the queue's organisation, or
//        (c) the caller's agent ID is listed in that organisation's
//            `client_org_mapping.queueCoordinatorIds`.
//      Never a hardcoded name; never "the creator of a task".
//
// rights-derivation: the coordinator list is read from client_org_mapping on every
// call and the admin role from the verified session on every call; nothing is copied
// onto a token, so a change to either reaches every live connection by construction.

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { hasFleetRead } from "@vantageos/cloud-identity";
import { assigneeNotInOrgRefusal, requireAssigneeAgentActive } from "./actingPrincipal";
import type { OrgScope } from "./auth";
import { lookupOrgMapping } from "./auth";
import { memberActorOf, resolveHumanActor } from "./humanActor";
import { rbacDenied } from "./inboxReader";
import { requireId } from "./ids";

/** Most tasks one `reorderQueue` may rank. */
export const QUEUE_MAX_TASKS = 100;

/** The statuses of a task that is still on someone's plate. */
export const OPEN_QUEUE_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export type QueueSortable = {
	queueRank?: number;
	priority: string;
	_creationTime: number;
};

/**
 * Queue order: ranked first (rank ascending), then unranked by priority, then age
 * (oldest first). Two tasks of equal rank fall through to priority and age, so the
 * order is total and stable.
 */
export function compareQueueOrder(a: QueueSortable, b: QueueSortable): number {
	const aRanked = a.queueRank !== undefined;
	const bRanked = b.queueRank !== undefined;
	if (aRanked && !bRanked) return -1;
	if (!aRanked && bRanked) return 1;
	if (aRanked && bRanked && a.queueRank !== b.queueRank) {
		return (a.queueRank as number) - (b.queueRank as number);
	}
	const byPriority =
		(PRIORITY_ORDER[a.priority] ?? PRIORITY_ORDER.low + 1) -
		(PRIORITY_ORDER[b.priority] ?? PRIORITY_ORDER.low + 1);
	if (byPriority !== 0) return byPriority;
	return a._creationTime - b._creationTime;
}

type Ctx = QueryCtx | MutationCtx;

type QueueCaller = OrgScope & {
	callerActorId?: string;
	callerActorOrg?: string;
};

export type QueueOrg = {
	slug: string;
	mapping: Doc<"client_org_mapping">;
};

/**
 * The organisation whose queue is being written, from the VERIFIED principal only.
 *   - a person: the org of the verified session;
 *   - an agent: the org the transport verified (`verifiedOrg`), the org of its own
 *     verified scope, the org of its verified agent row. Every one of those that is
 *     present must name the same org; none present, or a disagreement, refuses.
 * The org's mapping must be ONE active row, whose permanent ID agrees with the
 * session's when the session carries one.
 */
export async function resolveQueueOrg(
	ctx: Ctx,
	scope: QueueCaller,
	verifiedOrgSlug: string | undefined,
	isPerson: boolean,
	door: string,
): Promise<QueueOrg> {
	const named = isPerson
		? [scope.orgSlug]
		: [verifiedOrgSlug, scope.orgSlug, scope.callerActorOrg];
	const present = named.filter((s): s is string => typeof s === "string");
	const slug = present[0];
	if (slug === undefined || present.some((s) => s !== slug)) {
		throw rbacDenied(
			door,
			"queue-org-unresolved",
			"the organisation of this queue could not be derived from the verified caller",
		);
	}
	const mapping = await lookupOrgMapping(ctx, slug);
	if (
		mapping === null ||
		!mapping.isActive ||
		(scope.orgClerkId !== undefined &&
			mapping.clerkOrgId !== undefined &&
			scope.orgClerkId !== mapping.clerkOrgId)
	) {
		throw rbacDenied(
			door,
			"queue-org-not-active",
			`organisation "${slug}" has no single active mapping for this caller`,
		);
	}
	return { slug, mapping };
}

/**
 * Refuses unless the caller may reorder the queue of `assigneeId` in `org`.
 * Returns nothing; every refusal is RBAC_DENIED carrying a machine-readable reason.
 */
export async function requireQueueAuthority(
	ctx: MutationCtx,
	args: {
		scope: QueueCaller;
		isPerson: boolean;
		org: QueueOrg;
		assigneeId: string;
		door: string;
	},
): Promise<void> {
	const { scope, org, assigneeId, door } = args;
	if (args.isPerson) {
		// A person is admitted through the ONE human gate (verified session, org
		// member, writer role) as org:admin of the org. The "own queue" branch is
		// effectively dead: memberActorOf(scope) yields `user:<sub>` while assigneeId
		// is an agent _id, so the comparison is never true and every person is
		// admin-only (fail closed). Behaviour is unchanged by this comment.
		const own = memberActorOf(scope) === assigneeId;
		await resolveHumanActor(ctx, scope, { door, adminOnly: !own });
		return;
	}
	const callerId = scope.callerActorId;
	if (callerId === undefined) {
		throw rbacDenied(
			door,
			"queue-caller-unresolved",
			"the caller resolves to no verified agent; a queue is reordered by its assignee, a listed coordinator or an org admin",
		);
	}
	if (callerId === assigneeId) return; // (a) the assignee; its ID was resolved inside `org`
	// (c) a listed coordinator, read from the live mapping by the principal's own org.
	if ((org.mapping.queueCoordinatorIds ?? []).includes(callerId)) {
		// The listed ID must still be an ACTIVE agent of this very org.
		await requireAssigneeAgentActive(ctx, callerId, org.slug, door, org.mapping.clerkOrgId);
		return;
	}
	throw rbacDenied(
		door,
		"queue-not-assignee-or-coordinator",
		`caller is neither the assignee of this queue, a queue coordinator of "${org.slug}", nor an org admin`,
	);
}

/**
 * The assignee ID an agent-ID argument names, for a READ: a member sees only agents
 * of its own org (another org's agent is refused, never answered as absent); the
 * fleet reader sees any. undefined when the ID names no agent.
 */
export async function assigneeIdFromAgentIdForRead(
	ctx: Ctx,
	scope: OrgScope,
	agentId: string,
	field: string,
	door: string,
): Promise<string | undefined> {
	const id = requireId(ctx, "agents", agentId, field, `${door} takes an agent ID as returned by list_peers \`agentId\`.`);
	const row = await ctx.db.get(id);
	if (row === null) return undefined;
	if (!hasFleetRead(scope) && (scope.orgSlug === null || row.orgSlug !== scope.orgSlug)) {
		throw assigneeNotInOrgRefusal(agentId, scope.orgSlug ?? undefined, door);
	}
	return row._id;
}

/** Throws QUEUE_* refusals with the shape every other task refusal has. */
export function queueRefusal(code: string, taskId: string | null, detail: string): ConvexError<string> {
	return new ConvexError(`${code}: ${detail} — ${JSON.stringify({ taskId })}`);
}
