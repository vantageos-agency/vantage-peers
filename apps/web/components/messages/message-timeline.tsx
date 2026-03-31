"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { type ChannelFilter, ChannelFilterBar } from "./channel-filter";
import { MessageRow, type MessageRowData } from "./message-row";
import { MessagesEmptyState } from "./messages-empty-state";

// ── Loading skeleton ──────────────────────────────────────────────────────────

function TimelineSkeleton() {
	return (
		<div className="rounded-xl border border-border bg-card overflow-hidden">
			<div className="divide-y divide-border/60">
				{(["a", "b", "c", "d", "e"] as const).map((k) => (
					<div key={k} className="flex flex-col gap-2 px-4 py-3">
						<div className="flex items-center gap-2">
							<Skeleton className="h-4 w-10 rounded" />
							<Skeleton className="h-4 w-16 rounded" />
							<Skeleton className="h-3 w-12 rounded ml-auto" />
						</div>
						<Skeleton className="h-3 w-full" />
						<Skeleton className="h-3 w-3/4" />
					</div>
				))}
			</div>
		</div>
	);
}

// ── Main component ────────────────────────────────────────────────────────────

export function MessageTimeline() {
	const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");

	// Queries
	const messages = useQuery(
		api.messages.listByChannel,
		channelFilter !== "all" ? { channel: channelFilter } : {},
	);

	const unreadCount = useQuery(api.messages.getUnreadCount, {
		orchestratorId: "pi",
	});

	// Unread receipts for marking as read — use checkNewMessages to get receipt IDs
	const unreadMessages = useQuery(api.messages.checkNewMessages, {
		recipient: "pi",
	});

	const markAsRead = useMutation(api.messages.markAsRead);

	// Build a set of message IDs that are unread (have a receipt without readAt)
	const unreadMessageIds = useMemo(() => {
		if (!unreadMessages) return new Set<string>();
		return new Set(unreadMessages.map((m) => m.messageId as string));
	}, [unreadMessages]);

	// Build a map from messageId -> receiptId for markAsRead
	const receiptByMessageId = useMemo(() => {
		const map = new Map<string, Id<"messageReceipts">>();
		if (!unreadMessages) return map;
		for (const m of unreadMessages) {
			map.set(m.messageId as string, m.receiptId);
		}
		return map;
	}, [unreadMessages]);

	const handleMarkOneRead = useCallback(
		async (messageId: string) => {
			const receiptId = receiptByMessageId.get(messageId);
			if (receiptId) {
				await markAsRead({ receiptIds: [receiptId] });
			}
		},
		[receiptByMessageId, markAsRead],
	);

	const handleMarkAllRead = useCallback(async () => {
		if (!unreadMessages || unreadMessages.length === 0) return;
		const receiptIds = unreadMessages.map((m) => m.receiptId);
		await markAsRead({ receiptIds });
	}, [unreadMessages, markAsRead]);

	const rows = useMemo<MessageRowData[]>(() => {
		if (!messages) return [];
		return messages.map((m) => ({
			_id: m._id as string,
			from: m.from,
			fromInstanceId: m.fromInstanceId,
			channel: m.channel,
			content: m.content,
			createdAt: m.createdAt,
		}));
	}, [messages]);

	const isLoading = messages === undefined;

	return (
		<div className="flex flex-col gap-4">
			{/* Filters row */}
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<ChannelFilterBar value={channelFilter} onChange={setChannelFilter} />

				<div className="flex items-center gap-3">
					{unreadCount !== undefined && unreadCount > 0 && (
						<>
							<span
								className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
								style={{
									backgroundColor: "oklch(0.55 0.22 27 / 0.15)",
									color: "oklch(0.55 0.22 27)",
								}}
							>
								{unreadCount} unread
							</span>
							<button
								type="button"
								onClick={handleMarkAllRead}
								className="text-xs font-medium text-[oklch(0.65_0.15_232)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
							>
								Mark all read
							</button>
						</>
					)}
				</div>
			</div>

			{/* Timeline */}
			{isLoading ? (
				<TimelineSkeleton />
			) : rows.length === 0 ? (
				<MessagesEmptyState />
			) : (
				<div className="rounded-xl border border-border bg-card overflow-hidden">
					<div className="divide-y divide-border/60">
						{rows.map((message) => (
							<MessageRow
								key={message._id}
								message={message}
								isUnread={unreadMessageIds.has(message._id)}
								onMarkRead={() => handleMarkOneRead(message._id)}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
