import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
// convex-strict-mode-doc-type-import-needed-when-refactoring-list-query-from-early-return-to-accumulator-post-filter
import type { Doc } from "./_generated/dataModel";
import { creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// sendMessage — send a message to one, many, or all orchestrators
// channel: "broadcast" | "tau" | "pi,phi" (comma-separated for multi)
// Creates one message row + one receipt per recipient.
// ─────────────────────────────────────────────────────────────────────────────

// Broadcast resolves dynamically from the profiles table.
// Any orchestrator with a profile receives broadcasts.
// No hardcoded list — new orchestrators are included automatically after calling update_profile.

export const sendMessage = mutation({
	args: {
		from: creatorValidator,
		fromInstanceId: v.optional(v.string()),
		channel: v.string(),
		content: v.string(),
		sessionDay: v.optional(v.number()),
		tenantId: v.optional(v.string()),
	},
	returns: v.id("messages"),
	handler: async (ctx, args) => {
		const messageId = await ctx.db.insert("messages", {
			from: args.from,
			fromInstanceId: args.fromInstanceId,
			channel: args.channel,
			content: args.content,
			sessionDay: args.sessionDay,
			tenantId: args.tenantId,
			createdAt: Date.now(),
		});

		// Resolve recipients — channel can be a role or instanceId
		// If channel contains "-" (e.g. "pi-vps"), treat as instance-level
		let recipients: string[];
		if (args.channel === "broadcast") {
			// Dynamic: get all registered orchestrators from profiles
			const profiles = await ctx.db.query("profiles").collect();
			const orchestratorIds = [...new Set(profiles.map((p) => p.orchestratorId))];
			recipients = orchestratorIds.filter((o) => o !== args.from);
		} else {
			recipients = args.channel
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0 && s !== args.from);
		}

		for (const recipient of recipients) {
			// Determine if this is an instance target or role target
			const isInstance = recipient.includes("-");
			const role = isInstance ? recipient.split("-")[0] : recipient;

			await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: role,
				recipientInstanceId: isInstance ? recipient : undefined,
				tenantId: args.tenantId,
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
		tenantId: v.optional(v.string()),
		since: v.optional(v.number()), // Unix ms — only return receipts with _creationTime > since
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
	// tenantId filtering: when provided, only returns messages for that tenant.
	// When omitted, returns all messages (backward-compatible single-tenant mode).
	// This is intentional — omitting tenantId = admin/legacy access, not a bypass.
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
				.filter((q) => {
					const base = q.eq(q.field("readAt"), undefined);
					return args.since !== undefined
						? q.and(base, q.gt(q.field("_creationTime"), args.since))
						: base;
				})
				.take(100);

			const roleReceipts = await ctx.db
				.query("messageReceipts")
				.withIndex("by_recipient_unread", (q) =>
					q.eq("recipient", args.recipient),
				)
				.filter((q) => {
					const base = q.and(
						q.eq(q.field("readAt"), undefined),
						q.eq(q.field("recipientInstanceId"), undefined),
					);
					return args.since !== undefined
						? q.and(base, q.gt(q.field("_creationTime"), args.since))
						: base;
				})
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

			// No tenant+instance index — JS filter is acceptable for instance-targeted messages (low volume)
			if (args.tenantId !== undefined) {
				receipts = receipts.filter(
					(r) => r.tenantId === args.tenantId,
				);
			}
		} else {
			// Role-level: get all unread for this role
			if (args.tenantId !== undefined) {
				receipts = await ctx.db
					.query("messageReceipts")
					.withIndex("by_tenant_recipient_unread", (q) =>
						q.eq("tenantId", args.tenantId).eq("recipient", args.recipient).eq("readAt", undefined),
					)
					.filter((q) =>
						args.since !== undefined
							? q.gt(q.field("_creationTime"), args.since)
							: true,
					)
					.take(100);
			} else {
				receipts = await ctx.db
					.query("messageReceipts")
					.withIndex("by_recipient_unread", (q) =>
						q.eq("recipient", args.recipient),
					)
					.filter((q) => {
						const base = q.eq(q.field("readAt"), undefined);
						return args.since !== undefined
							? q.and(base, q.gt(q.field("_creationTime"), args.since))
							: base;
					})
					.take(100);
			}
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
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		sessionDay: v.optional(v.number()),
		from: v.optional(creatorValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("messages"),
			_creationTime: v.number(),
			from: creatorValidator,
			fromInstanceId: v.optional(v.string()),
			channel: v.optional(v.string()),
			to: v.optional(creatorValidator),
			content: v.string(),
			sessionDay: v.optional(v.number()),
			createdAt: v.number(),
			// Day 98 Cat A k17e611z4 fix — issues #655, #644, #643. Multi-tenant
			// rows carry tenantId; returns shape must declare it or Convex
			// emits ReturnsValidationError "extra field tenantId".
			tenantId: v.optional(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 100;
		const before = args.createdBefore;

		let rows: Doc<"messages">[];
		if (args.sessionDay !== undefined) {
			rows = await ctx.db
				.query("messages")
				.withIndex("by_day", (q) => q.eq("sessionDay", args.sessionDay!))
				.order("asc")
				.take(limit);
		} else if (args.from !== undefined) {
			rows = await ctx.db
				.query("messages")
				.withIndex("by_from", (q) => q.eq("from", args.from!))
				.order("desc")
				.take(limit);
		} else {
			rows = await ctx.db.query("messages").order("desc").take(limit);
		}

		// S3.3 B8 follow-up batch 2 — drop rows newer-or-equal to anchor.
		if (before !== undefined) {
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getUnreadCount — count unread receipts for a recipient role
// ─────────────────────────────────────────────────────────────────────────────

export const getUnreadCount = query({
	args: { orchestratorId: creatorValidator },
	returns: v.number(),
	handler: async (ctx, { orchestratorId }) => {
		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_recipient_unread", (q) =>
				q.eq("recipient", orchestratorId),
			)
			.filter((q) => q.eq(q.field("readAt"), undefined))
			.take(500);
		return receipts.length;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listBroadcastStatus — show who read a broadcast message and who didn't
// ─────────────────────────────────────────────────────────────────────────────

export const listBroadcastStatus = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		messageId: v.id("messages"),
	},
	returns: v.object({
		messageId: v.id("messages"),
		from: creatorValidator,
		channel: v.optional(v.string()),
		createdAt: v.number(),
		receipts: v.array(
			v.object({
				recipient: v.string(),
				recipientInstanceId: v.optional(v.string()),
				read: v.boolean(),
				readAt: v.optional(v.number()),
			}),
		),
	}),
	handler: async (ctx, { messageId }) => {
		const message = await ctx.db.get(messageId);
		if (!message) throw new Error("Message not found");

		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", messageId))
			.collect();

		return {
			messageId,
			from: message.from,
			channel: message.channel,
			createdAt: message.createdAt,
			receipts: receipts.map((r) => ({
				recipient: r.recipient,
				recipientInstanceId: r.recipientInstanceId,
				read: r.readAt !== undefined,
				readAt: r.readAt,
			})),
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByChannel — list recent messages for a channel (or all if unspecified)
// ─────────────────────────────────────────────────────────────────────────────

export const listByChannel = query({
	args: {
		channel: v.optional(v.string()),
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
	handler: async (ctx, { channel, limit }) => {
		const take = limit ?? 100;
		if (channel !== undefined) {
			return await ctx.db
				.query("messages")
				.withIndex("by_channel", (q) => q.eq("channel", channel))
				.order("desc")
				.take(take);
		}
		return await ctx.db.query("messages").order("desc").take(take);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 100 — Phase 2 get_by_id surface fix (task k172735brsw6bc3j2dkkkfxqrx88kkjq)
// Single-row read by Convex doc ID. Returns null on miss (MCP layer reshapes
// to scope-aware "not found"). No validator on returns — schema for messages
// rows varies by send variant; raw row is fine for read-by-id.
// ─────────────────────────────────────────────────────────────────────────────

export const getById = query({
	args: { messageId: v.id("messages") },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.messageId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r).
// BM25 keyword search over message content via Convex native .searchIndex().
//
// Backed by the `search_content` searchIndex declared in schema.ts.
// Filter axes: from, channel, sessionDay, tenantId (matches messages.list()).
// ─────────────────────────────────────────────────────────────────────────────

export const searchMessagesByKeyword = query({
	args: {
		query: v.string(),
		from: v.optional(creatorValidator),
		channel: v.optional(v.string()),
		sessionDay: v.optional(v.number()),
		tenantId: v.optional(v.string()),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
	},
	handler: async (ctx, args) => {
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
		const lite = args.fields === "lite";

		const results = await ctx.db
			.query("messages")
			.withSearchIndex("search_content", (q) => {
				let qb = q.search("content", args.query);
				if (args.from !== undefined) qb = qb.eq("from", args.from);
				if (args.channel !== undefined) qb = qb.eq("channel", args.channel);
				if (args.sessionDay !== undefined)
					qb = qb.eq("sessionDay", args.sessionDay);
				if (args.tenantId !== undefined) qb = qb.eq("tenantId", args.tenantId);
				return qb;
			})
			.take(limit);

		if (!lite) return results;
		return results.map((m) => ({
			_id: m._id,
			from: m.from,
			channel: m.channel,
			content: m.content,
			sessionDay: m.sessionDay,
			createdAt: m.createdAt,
		}));
	},
});
