import { isFleetStamp } from "@vantageos/cloud-identity";
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { orgRefOfRow } from "./lib/authOrgMapping";
import { fleetOperatorRef } from "./lib/operatorOrg";
import { acceptedReviewers } from "./lib/reviewRouting";

// ─────────────────────────────────────────────────────────────────────────────
// publishApproval — the verdict behind POST /api/eta/verify-publish-token.
//
// The route authenticates the caller (the fleet master bearer, judged by the
// package) and calls this internal door; no Clerk identity exists here. The
// whole verdict is computed INSIDE the query so a task's note never leaves the
// database layer: the caller learns a reason code, never a row's text.
//
// A publish approval is a FLEET object: the reviewer closes a fleet task with
// the [ETA-APPROVED] marker. A task stamped with any other organisation is not
// readable through this door at all and answers exactly like a task that does
// not exist (`task-not-found`), so the route is no oracle on a client's tasks.
// ─────────────────────────────────────────────────────────────────────────────

export const APPROVAL_MARKER = "[ETA-APPROVED]";
const FULL_SHA = /^[0-9a-f]{40}$/i;

export function isFullSha(value: string): boolean {
	return FULL_SHA.test(value);
}

const verdictValidator = v.union(
	v.object({ valid: v.literal(true), completedAt: v.number() }),
	v.object({ valid: v.literal(false), reason: v.string() }),
);

export const verdictForPublish = internalQuery({
	args: { taskId: v.string(), expectedSha: v.string() },
	returns: verdictValidator,
	handler: async (ctx, args) => {
		if (!isFullSha(args.expectedSha)) {
			return { valid: false as const, reason: "invalid-sha" };
		}
		const id = ctx.db.normalizeId("tasks", args.taskId);
		const task = id === null ? null : await ctx.db.get(id);
		if (task === null) {
			return { valid: false as const, reason: "task-not-found" };
		}
		// Only the fleet's own tasks (unstamped, or stamped with the operator org,
		// decided by the package from the stored mapping) can carry an approval.
		const operator = await fleetOperatorRef(ctx.db);
		if (!isFleetStamp(orgRefOfRow(task), operator)) {
			return { valid: false as const, reason: "task-not-found" };
		}
		const accepted = await acceptedReviewers(ctx, task.reviewPrRepoFullName);
		if (!accepted.includes((task.assignedTo ?? "").trim().toLowerCase())) {
			return { valid: false as const, reason: "wrong-assignee" };
		}
		if (task.status !== "done") {
			return { valid: false as const, reason: "wrong-status" };
		}
		const note = task.completionNote ?? "";
		if (!note.includes(APPROVAL_MARKER)) {
			return { valid: false as const, reason: "not-approved" };
		}
		// The FULL commit SHA, on hex boundaries: a prefix, a fragment or a longer
		// hex run that merely contains it is not the reviewed commit.
		const cited = new RegExp(
			`(?<![0-9a-f])${args.expectedSha.toLowerCase()}(?![0-9a-f])`,
		);
		if (!cited.test(note.toLowerCase())) {
			return { valid: false as const, reason: "sha-not-in-note" };
		}
		return { valid: true as const, completedAt: task.completedAt ?? task.updatedAt };
	},
});
