import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// sendMessage — send a message to one, many, or all orchestrators
// channel: "broadcast" | "tau" | "pi,phi" (comma-separated for multi)
// Creates one message row + one receipt per recipient.
// ─────────────────────────────────────────────────────────────────────────────

const ALL_ORCHESTRATORS = ["pi", "tau", "phi"] as const;

function resolveRecipients(
	from: string,
	channel: string,
): string[] {
	if (channel === "broadcast") {
		return ALL_ORCHESTRATORS.filter((o) => o !== from);
	}
	return channel
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && s !== from);
}

export const sendMessage = mutation({
	args: {
		from: creatorValidator,
		channel: v.string(),
		content: v.string(),
		sessionDay: v.optional(v.number()),
	},
	returns: v.id("messages"),
	handler: async (ctx, args) => {
		const messageId = await ctx.db.insert("messages", {
			from: args.from,
			channel: args.channel,
			content: args.content,
			sessionDay: args.sessionDay,
			createdAt: Date.now(),
		});

		// Create one receipt per recipient
		const recipients = resolveRecipients(args.from, args.channel);
		for (const recipient of recipients) {
			await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: recipient as "pi" | "tau" | "phi" | "system",
				readAt: undefined,
			});
		}

		return messageId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// checkNewMessages — get unread messages for a recipient
// Returns messages with their receipt IDs (for marking as read).
// ─────────────────────────────────────────────────────────────────────────────

export const checkNewMessages = query({
	args: {
		recipient: creatorValidator,
	},
	returns: v.array(
		v.object({
			receiptId: v.id("messageReceipts"),
			messageId: v.id("messages"),
			from: creatorValidator,
			channel: v.optional(v.string()),
			content: v.string(),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		// Get unread receipts (readAt === undefined)
		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_recipient_unread", (q) =>
				q.eq("recipient", args.recipient),
			)
			.filter((q) => q.eq(q.field("readAt"), undefined))
			.take(100);

		const results = [];
		for (const receipt of receipts) {
			const message = await ctx.db.get(receipt.messageId);
			if (message !== null) {
				results.push({
					receiptId: receipt._id,
					messageId: receipt.messageId,
					from: message.from,
					channel: message.channel,
					content: message.content,
					createdAt: message.createdAt,
				});
			}
		}

		return results;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// markAsRead — mark one or more receipts as read
// ─────────────────────────────────────────────────────────────────────────────

export const markAsRead = mutation({
	args: {
		receiptIds: v.array(v.id("messageReceipts")),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		const now = Date.now();
		let count = 0;
		for (const receiptId of args.receiptIds) {
			const receipt = await ctx.db.get(receiptId);
			if (receipt !== null && receipt.readAt === undefined) {
				await ctx.db.patch(receiptId, { readAt: now });
				count++;
			}
		}
		return count;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listMessages — get messages for a day or from a sender (history/replay)
// ─────────────────────────────────────────────────────────────────────────────

export const listMessages = query({
	args: {
		sessionDay: v.optional(v.number()),
		from: v.optional(creatorValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("messages"),
			from: creatorValidator,
			channel: v.optional(v.string()),
			to: v.optional(creatorValidator),
			content: v.string(),
			sessionDay: v.optional(v.number()),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 100;

		if (args.sessionDay !== undefined) {
			return await ctx.db
				.query("messages")
				.withIndex("by_day", (q) => q.eq("sessionDay", args.sessionDay!))
				.order("asc")
				.take(limit);
		}

		if (args.from !== undefined) {
			return await ctx.db
				.query("messages")
				.withIndex("by_from", (q) => q.eq("from", args.from!))
				.order("desc")
				.take(limit);
		}

		return await ctx.db.query("messages").order("desc").take(limit);
	},
});
