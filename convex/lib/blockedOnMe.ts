import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { InboxReader } from "./inboxReader";
import { rbacDenied, taskVisibleTo } from "./inboxReader";
import { MATCH_ENTRY_CAP, STATUS_SCAN_BUDGET } from "./taskClosureGate";
import type { CappedList } from "./taskClosureGate";

/**
 * "Who is waiting on me" -- the dedicated opt-in read behind `list_blocked_on_me`.
 * `check_messages` returns messages only (operator ruling, see the header of
 * convex/__tests__/pendingOnYou.test.ts), so this never rides that envelope.
 *
 * A row is one `blocked` task (U) that cites, through `blockedOnTaskId`, a LIVE
 * task (T) the reader owns.
 */
export type BlockedOnMeEntry = {
	blockedTaskId: Id<"tasks">;
	blockedTitle: string;
	blockedAssignee: string;
	onTaskId: Id<"tasks">;
	onTaskTitle: string;
	age: number; // ms since the blocked task's updatedAt
};

export type BlockedOnMeResult = CappedList<BlockedOnMeEntry> & {
	oldestAge: number;
};

/** Statuses of a task someone can still be blocked on (not done/cancelled/failed). */
const LIVE_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;

/**
 * Bounded two-level walk. Level 1: the reader's live tasks by assignee agent ID
 * (`by_assigneeId_status_updatedAt`); a reader with no agent ID is refused.
 * `taskVisibleTo` re-judges every row.
 * Level 2: for each, the `blocked` rows citing it via `by_blockedOnTaskId`.
 * Both levels share STATUS_SCAN_BUDGET documents; hitting it sets `truncated`,
 * and `total` is then a lower bound -- never a silent partial set.
 * `for await` is used (not a page cursor) so the walk composes with other reads
 * in one function execution.
 */
export async function computeBlockedOnMe(
	ctx: QueryCtx,
	reader: InboxReader,
	now: number,
): Promise<BlockedOnMeResult> {
	const all: BlockedOnMeEntry[] = [];
	let scanned = 0;
	let truncated = false;
	let oldestAge = 0;

	// A task is owned by an agents-row ID; a label never selects a row. A reader
	// with no agent ID (org-name / fleet / operator-admin) is REFUSED, not served
	// an empty list: "you may not" must not read as "nobody is waiting".
	const agentId = reader.agentId as Id<"agents"> | undefined;
	if (agentId === undefined) {
		throw rbacDenied(
			"tasks:listBlockedOnMe",
			"blocked-on-me-needs-agent-id",
			"list_blocked_on_me is read by a verified agent, by ID; a name selects nothing",
		);
	}

	outer: for (const status of LIVE_STATUSES) {
		const mine = ctx.db
			.query("tasks")
			.withIndex("by_assigneeId_status_updatedAt", (q) =>
				q.eq("assignedToId", agentId).eq("status", status),
			);
		for await (const target of mine) {
			scanned += 1;
			if (scanned > STATUS_SCAN_BUDGET) {
				truncated = true;
				break outer;
			}
			if (!taskVisibleTo(reader, target, "assignee")) continue;
			const citing = ctx.db
				.query("tasks")
				.withIndex("by_blockedOnTaskId", (q) =>
					q.eq("blockedOnTaskId", target._id),
				);
			for await (const blocked of citing) {
				scanned += 1;
				if (scanned > STATUS_SCAN_BUDGET) {
					truncated = true;
					break outer;
				}
				if (blocked.status !== "blocked") continue;
				// The blocked row belongs to someone else, so only the TENANT half of
				// taskVisibleTo applies (the reader's agent ID is dropped: it names the
				// owner of the target, not of the waiter). A row stamped with another
				// organisation never surfaces, whatever it cites.
				if (
					!taskVisibleTo({ ...reader, agentId: undefined }, blocked, "assignee")
				) {
					continue;
				}
				const age = Math.max(0, now - blocked.updatedAt);
				oldestAge = Math.max(oldestAge, age);
				all.push(toEntry(blocked, target, age));
			}
		}
	}

	all.sort((a, b) => b.age - a.age);
	return {
		entries: all.slice(0, MATCH_ENTRY_CAP),
		total: all.length,
		truncated,
		oldestAge,
	};
}

function toEntry(
	blocked: Doc<"tasks">,
	target: Doc<"tasks">,
	age: number,
): BlockedOnMeEntry {
	return {
		blockedTaskId: blocked._id,
		blockedTitle: blocked.title,
		blockedAssignee: blocked.assignedTo,
		onTaskId: target._id,
		onTaskTitle: target.title,
		age,
	};
}
