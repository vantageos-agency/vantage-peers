import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";

// Helpers for the email-keyed personal agent invite (task k178xp66h7p0ds6vg69sqzw2vn8hbfrw).
// The decision "does this verified email designate this agent" lives in convex/personalAgentBind.ts;
// this file only normalises an address and schedules that decision.

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Lowercased, trimmed address; null when it is not an address. */
export function normalizeInviteEmail(email: string): string | null {
	const normalized = email.trim().toLowerCase();
	return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

// An organisation's agent and member counts are small; a client org beyond these bounds is refused
// loudly by the bind rather than partially processed.
export const INVITE_SCAN_CAP = 500;

/** Whether the org holds at least one active agent with a pending invite and no person yet. */
export async function orgHasPendingInvites(
	ctx: Pick<MutationCtx, "db">,
	clerkOrgId: string,
): Promise<boolean> {
	const agents = await ctx.db
		.query("agents")
		.withIndex("by_org_clerk_id", (q) => q.eq("clerkOrgId", clerkOrgId))
		.take(INVITE_SCAN_CAP);
	return agents.some(
		(a) => a.isActive && a.personalAgentInvite !== undefined && a.personalAgentOf === undefined,
	);
}

/** Schedule the bind for ONE member of the org (the webhook path). */
export async function scheduleInviteBind(
	ctx: Pick<MutationCtx, "scheduler">,
	clerkOrgId: string,
	clerkUserId: string,
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.personalAgentBind.bindFromClerk, {
		clerkOrgId,
		clerkUserId,
	});
}

/** Schedule the bind for every member Clerk lists for the org (the invite-recorded-late path). */
export async function scheduleInviteBindForOrg(
	ctx: Pick<MutationCtx, "scheduler">,
	clerkOrgId: string,
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.personalAgentBind.bindOrgFromClerk, { clerkOrgId });
}
