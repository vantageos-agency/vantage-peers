// receiptRecipientIdAudit — the REPORT of unread receipts the inbox no longer
// delivers (module M6). An agent reader is served by `recipientId` only
// (convex/lib/inboxReader.ts); a receipt with no `recipientId` reaches nobody,
// so it must be listed, never dropped silently. Read-only, caller-walked, one
// bounded page per execution.
//
//   npx convex run receiptRecipientIdAudit:unaddressedUnreadPage '{}'
//   -> repeat with {"cursor": <nextCursor>} until isDone. `unaddressedCount`
//      summed over the pages is 0 when migrations/backfill_actor_ids has filled
//      every receipt it can; each remaining row is an unknownAgent /
//      ambiguousAgent receipt that backfill_actor_ids also lists by row ID.
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import { internalQuery } from "./_generated/server";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

export const unaddressedUnreadPage = internalQuery({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		examined: v.number(),
		unaddressedCount: v.number(),
		unaddressed: v.array(
			v.object({
				receiptId: v.id("messageReceipts"),
				tenantId: v.union(v.string(), v.null()),
				recipient: v.string(),
			}),
		),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
		if (
			!Number.isInteger(pageSize) ||
			pageSize < 1 ||
			pageSize > MAX_PAGE_SIZE
		) {
			throw new ConvexError(
				`receiptRecipientIdAudit: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const page = await ctx.db
			.query("messageReceipts")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });
		const unaddressed = page.page
			.filter((r) => r.readAt === undefined && r.recipientId === undefined)
			.map((r) => ({
				receiptId: r._id,
				tenantId: r.tenantId ?? null,
				recipient: r.recipient,
			}));
		return {
			examined: page.page.length,
			unaddressedCount: unaddressed.length,
			unaddressed,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
