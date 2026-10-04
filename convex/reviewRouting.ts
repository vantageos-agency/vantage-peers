import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { acceptedReviewers, resolveReviewer } from "./lib/reviewRouting";

// Internal doors for convex/http.ts (HMAC / master-bearer authenticated; no Clerk
// identity). Not reachable from the public API.

export const resolveForRepo = internalQuery({
	args: { repo: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) =>
		(await resolveReviewer(ctx, args.repo)).assignee,
});

export const acceptedForRepo = internalQuery({
	args: { repo: v.optional(v.string()) },
	returns: v.array(v.string()),
	handler: async (ctx, args) => await acceptedReviewers(ctx, args.repo),
});
