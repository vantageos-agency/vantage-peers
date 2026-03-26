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
		fromInstanceId: v.optional(v.string()),
		channel: v.string(),
		content: v.string(),
		sessionDay: v.optional(v.number()),
	},
	returns: v.id("messages"),
	handler: async (ctx, args) => {
		const messageId = await ctx.db.insert("messages", {
			from: args.from,
			fromInstanceId: args.fromInstanceId,
			channel: args.channel,
			content: args.content,
			sessionDay: args.sessionDay,
			createdAt: Date.now(),
		});

		// Resolve recipients — channel can be a role or instanceId
		// If channel contains "-" (e.g. "pi-vps"), treat as instance-level
		const recipients = resolveRecipients(args.from, args.channel);

		for (const recipient of recipients) {
			// Determine if this is an instance target or role target
			const isInstance = recipient.includes("-");
			const role = isInstance ? recipient.split("-")[0] : recipient;

			await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: role as "pi" | "tau" | "phi" | "system",
				recipientInstanceId: isInstance ? recipient : undefined,
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
		recipientInstanceId: v.optional(v.string()),
	},
	returns: v.array(
		v.object({
			receiptId: v.id("messageReceipts"),
			messageId: v.id("messages"),
			from: creatorValidator,
			fromInstanceId: v.optional(v.string()),
			channel: v.optional(v.string()),
			content: v.string(),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		let receipts;

		if (args.recipientInstanceId !== undefined) {
			// Instance-level: get messages targeted at this specific instance
			// PLUS role-level messages (recipientInstanceId === undefined)
			const instanceReceipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_instance_unread", (q) =>
					q.eq("recipientInstanceId", args.recipientInstanceId!),
				)
				.filter((q) => q.eq(q.field("readAt"), undefined))
				.take(100);

			const roleReceipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_recipient_unread", (q) =>
					q.eq("recipient", args.recipient),
				)
				.filter((q) =>
					q.and(
						q.eq(q.field("readAt"), undefined),
						q.eq(q.field("recipientInstanceId"), undefined),
					),
				)
				.take(100);

			// Merge and deduplicate by receiptId
			const seen = new Set<string>();
			receipts = [];
			for (const r of [...instanceReceipts, ...roleReceipts]) {
				if (!seen.has(r._id)) {
					seen.add(r._id);
					receipts.push(r);
				}
			}
		} else {
			// Role-level: get all unread for this role
			receipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_recipient_unread", (q) =>
					q.eq("recipient", args.recipient),
				)
				.filter((q) => q.eq(q.field("readAt"), undefined))
				.take(100);
		}

		const results = [];
		for (const receipt of receipts) {
			const message = await ctx.db.get(receipt.messageId);
			if (message !== null) {
				results.push({
					receiptId: receipt._id,
					messageId: receipt.messageId,
					from: message.from,
					fromInstanceId: message.fromInstanceId,
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
// deleteMessage — delete a message and cascade-delete its receipts
// RBAC: only the sender or "system" may delete. Pass callerOrchestrator=undefined
// to bypass the check (server-to-server / admin use).
// ─────────────────────────────────────────────────────────────────────────────

export const deleteMessage = mutation({
	args: {
		messageId: v.id("messages"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.object({ deleted: v.boolean(), receiptsDeleted: v.number() }),
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.messageId);
		if (!message) throw new Error("Message not found");

		// RBAC: if callerOrchestrator provided, must match message.from
		if (
			args.callerOrchestrator !== undefined &&
			args.callerOrchestrator !== "system"
		) {
			if (message.from !== args.callerOrchestrator) {
				throw new Error(
					`Unauthorized: only ${message.from} (sender) or system can delete this message`,
				);
			}
		}

		// Cascade: delete all receipts for this message
		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", args.messageId))
			.collect();

		for (const receipt of receipts) {
			await ctx.db.delete(receipt._id);
		}

		// Delete the message
		await ctx.db.delete(args.messageId);

		return { deleted: true, receiptsDeleted: receipts.length };
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
			_creationTime: v.number(),
			from: creatorValidator,
			fromInstanceId: v.optional(v.string()),
			channel: v.string(),
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
