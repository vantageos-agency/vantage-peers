import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { INVITE_SCAN_CAP, normalizeInviteEmail } from "./lib/personalAgentInvite";

// ─────────────────────────────────────────────────────────────────────────────
// personalAgentBind — "bind at first sign-up, automatic"
// (VantagePeers Cloud, task k178xp66h7p0ds6vg69sqzw2vn8hbfrw).
//
// An operator records, on each agent, the email its person was invited under
// (`agents:recordPersonalAgentInvite`). When the Clerk membership webhook reports a member of
// that agent's OWN organisation, `bindFromClerk` asks Clerk who that user is and
// `applyVerifiedEmails` binds every agent of THAT organisation whose invite names one of the
// user's VERIFIED addresses.
//
// Why an action: the membership payload carries `public_user_data.identifier` (an email or a
// username, with no verification status), so it is not a proof. The user is read from the Clerk
// Backend API and only addresses whose `verification.status` is "verified" count. FAIL-CLOSED: no
// CLERK_SECRET_KEY, a Clerk error, or a user id that does not match the one asked for binds
// nothing and raises; the invite stays, and re-running the onboarding command retries.
//
// Cross-tenant: agents are read through the membership's own `clerkOrgId` index key and the
// membership row must be live, so another organisation's agent is never read, and a member of
// organisation A with the same email as an invite in organisation B binds nothing.
// A name is never matched. An agent that already designates a person is never overwritten.
// ─────────────────────────────────────────────────────────────────────────────

const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;

export const applyVerifiedEmails = internalMutation({
	args: {
		clerkOrgId: v.string(),
		clerkUserId: v.string(),
		verifiedEmails: v.array(v.string()),
	},
	returns: v.object({ bound: v.array(v.id("agents")) }),
	handler: async (ctx, args) => {
		if (!CLERK_USER_ID_PATTERN.test(args.clerkUserId)) {
			throw new ConvexError(
				"PERSONAL_AGENT_PERSON_ID_INVALID: clerkUserId must be a Clerk user ID (user_ followed by letters and digits)",
			);
		}
		const verified = new Set(
			args.verifiedEmails.flatMap((e) => {
				const n = normalizeInviteEmail(e);
				return n === null ? [] : [n];
			}),
		);
		if (verified.size === 0) return { bound: [] };

		// The person must be a live member of THIS organisation now.
		const membership = await ctx.db
			.query("orgMembership")
			.withIndex("by_org_user_clerk_id", (q) =>
				q.eq("clerkOrgId", args.clerkOrgId).eq("clerkUserId", args.clerkUserId),
			)
			.unique();
		if (membership === null || membership.deletedAt !== undefined) return { bound: [] };

		const agents = await ctx.db
			.query("agents")
			.withIndex("by_org_clerk_id", (q) => q.eq("clerkOrgId", args.clerkOrgId))
			.take(INVITE_SCAN_CAP + 1);
		if (agents.length > INVITE_SCAN_CAP) {
			throw new ConvexError(
				`PERSONAL_AGENT_BIND_SCAN_INCOMPLETE: organisation ${args.clerkOrgId} holds more than ${INVITE_SCAN_CAP} agents; refusing to bind from a partial read`,
			);
		}
		const bound: Id<"agents">[] = [];
		for (const agent of agents) {
			const invite = agent.personalAgentInvite;
			if (!agent.isActive || invite === undefined || agent.personalAgentOf !== undefined) continue;
			if (agent.kind === "service") continue;
			if (!verified.has(invite.email)) continue;
			await ctx.db.patch(agent._id, {
				personalAgentOf: args.clerkUserId,
				personalAgentInvite: undefined,
			});
			bound.push(agent._id);
		}
		return { bound };
	},
});

type ClerkEmail = { email_address?: unknown; verification?: { status?: unknown } | null };
type ClerkUser = { id?: unknown; email_addresses?: unknown };

export const bindFromClerk = internalAction({
	args: { clerkOrgId: v.string(), clerkUserId: v.string() },
	returns: v.object({ bound: v.number() }),
	handler: async (ctx, args): Promise<{ bound: number }> => {
		if (!CLERK_USER_ID_PATTERN.test(args.clerkUserId)) {
			throw new ConvexError(
				"PERSONAL_AGENT_PERSON_ID_INVALID: clerkUserId must be a Clerk user ID (user_ followed by letters and digits)",
			);
		}
		const secretKey = process.env.CLERK_SECRET_KEY;
		if (!secretKey) {
			throw new ConvexError(
				"CLERK_SECRET_KEY_MISSING: CLERK_SECRET_KEY is not set — refusing to bind a personal agent without a verified email",
			);
		}
		const res = await fetch(`https://api.clerk.com/v1/users/${args.clerkUserId}`, {
			headers: { Authorization: `Bearer ${secretKey}` },
		});
		// The status is named, the key and the response body never are.
		if (!res.ok) {
			throw new ConvexError(`CLERK_USER_READ_FAILED: Clerk answered HTTP ${res.status}`);
		}
		const user = (await res.json()) as ClerkUser;
		if (user.id !== args.clerkUserId || !Array.isArray(user.email_addresses)) {
			throw new ConvexError("CLERK_USER_READ_MISMATCH: Clerk's answer is not the user asked for");
		}
		const verifiedEmails = (user.email_addresses as ClerkEmail[]).flatMap((e) =>
			e.verification?.status === "verified" && typeof e.email_address === "string"
				? [e.email_address]
				: [],
		);
		const out: { bound: Id<"agents">[] } = await ctx.runMutation(internal.personalAgentBind.applyVerifiedEmails, {
			clerkOrgId: args.clerkOrgId,
			clerkUserId: args.clerkUserId,
			verifiedEmails,
		});
		return { bound: out.bound.length };
	},
});
