// taskQueue — the explicit per-assignee task queue (task k174gp4nejkdmh4wt6zb7tgy1x8jvhpc).
//
// Two things live here, both pure of the task doors that use them:
//
//   1. compareQueueOrder — the ONE comparator of a queue: ranked tasks first by
//      `queueRank` ascending, then unranked tasks by priority (urgent > high >
//      medium > low), then by creation time ascending. `tasks:list { sort:"queue" }`
//      and `tasks:nextForAssignee` both read it, so the two can never disagree.
//
//   2. loadTaskOfPrincipalOrg — the target check of a reorder: a listed task must be
//      stamped with the resolved principal's organisation ID (the package's
//      `assertTargetBelongsTo`).
//
// WHO may reorder an assignee's queue is decided in the door itself (tasks:reorderQueue),
// at REQUEST TIME, from the principal @vantageos/cloud-identity resolves (rule
// authority-attached-to-anonymous-object) and the live organisation mapping:
//   (a) the caller IS the assignee (agent ID === assignee ID), or
//   (b) the signed-in person is org:admin of the queue's organisation, or
//   (c) the caller's agent ID is listed in that organisation's
//       `client_org_mapping.queueCoordinators`.
// Never a hardcoded name; never "the creator of a task".
//
// rights-derivation: the coordinator list is read from client_org_mapping on every
// call and the admin role from the verified session on every call; nothing is copied
// onto a token, so a change to either reaches every live connection by construction.

import {
	type ActingPrincipal,
	assertTargetBelongsTo,
	hasFleetRead,
	sameOrg,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assigneeNotInOrgRefusal } from "./actingPrincipal";
import type { OrgScope } from "./auth";
import { requireId } from "./ids";
import { orgByIdPrincipalLookups } from "./orgIdLookups";

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

/**
 * The task an ID names, judged against the principal's organisation by the package
 * (`assertTargetBelongsTo`, stored organisation IDs): another organisation's task, or
 * one stamped with no organisation, is REFUSED naming the task, never ranked and never
 * reported as absent. A task that does not exist raises TASK_NOT_FOUND.
 */
export async function loadTaskOfPrincipalOrg(
	ctx: Ctx,
	principal: ActingPrincipal,
	taskId: Id<"tasks">,
	door: string,
): Promise<Doc<"tasks">> {
	const task = await ctx.db.get(taskId);
	if (task === null) {
		throw new ConvexError(
			`TASK_NOT_FOUND: Task ${taskId} not found — ${JSON.stringify({ taskId })}`,
		);
	}
	const verdict = await assertTargetBelongsTo(
		principal,
		{ orgId: task.clerkOrgId ?? null },
		orgByIdPrincipalLookups(ctx),
		{ door },
	);
	if (!verdict.ok) {
		throw new ConvexError(
			`${verdict.refusal.code}: task ${taskId} belongs to another organisation or to none; ${verdict.refusal.detail} — ${JSON.stringify({ reason: verdict.refusal.reason, door: verdict.refusal.door, taskId })}`,
		);
	}
	return task;
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
	// The agent's organisation is its permanent ID, compared with the caller's own.
	if (!hasFleetRead(scope) && !sameOrg({ id: row.clerkOrgId }, { id: scope.orgClerkId })) {
		throw assigneeNotInOrgRefusal(agentId, scope.orgSlug ?? undefined, door);
	}
	return row._id;
}

/** Throws QUEUE_* refusals with the shape every other task refusal has. */
export function queueRefusal(code: string, taskId: string | null, detail: string): ConvexError<string> {
	return new ConvexError(`${code}: ${detail} — ${JSON.stringify({ taskId })}`);
}
