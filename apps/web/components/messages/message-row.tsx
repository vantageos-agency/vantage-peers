"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

type OrchestratorId = "pi" | "tau" | "phi" | "sigma" | string;

const ORCHESTRATOR_COLORS: Record<string, { bg: string; text: string }> = {
	pi: {
		bg: "bg-[oklch(0.65_0.15_232)]/15",
		text: "text-[oklch(0.65_0.15_232)]",
	},
	tau: {
		bg: "bg-[oklch(0.65_0.15_145)]/15",
		text: "text-[oklch(0.65_0.15_145)]",
	},
	phi: {
		bg: "bg-[oklch(0.65_0.15_290)]/15",
		text: "text-[oklch(0.65_0.15_290)]",
	},
	sigma: {
		bg: "bg-[oklch(0.65_0.15_50)]/15",
		text: "text-[oklch(0.65_0.15_50)]",
	},
};

export function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1_000);
	const minutes = Math.floor(diff / 60_000);
	const hours = Math.floor(diff / 3_600_000);
	const days = Math.floor(diff / 86_400_000);

	if (seconds < 60) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	return `${days}d ago`;
}

export interface MessageRowData {
	_id: string;
	from: OrchestratorId;
	fromInstanceId?: string;
	channel: string;
	content: string;
	createdAt: number;
}

interface MessageRowProps {
	message: MessageRowData;
	isUnread?: boolean;
	onMarkRead?: () => void;
}

function OrchestratorBadge({ orchestratorId }: { orchestratorId: string }) {
	const colors = ORCHESTRATOR_COLORS[orchestratorId] ?? {
		bg: "bg-muted",
		text: "text-muted-foreground",
	};

	return (
		<span
			className={cn(
				"inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider shrink-0",
				colors.bg,
				colors.text,
			)}
		>
			{orchestratorId}
		</span>
	);
}

function ChannelLabel({ channel }: { channel: string }) {
	return (
		<span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground font-mono shrink-0">
			{channel}
		</span>
	);
}

export function MessageRow({ message, isUnread, onMarkRead }: MessageRowProps) {
	const t = useTranslations("messages_page");

	return (
		<article
			className={cn(
				"flex flex-col gap-2 px-4 py-3 border-b border-border/60 last:border-0 transition-colors",
				isUnread ? "bg-[oklch(0.65_0.15_232)]/4" : "hover:bg-muted/20",
			)}
			aria-label={`Message from ${message.from}`}
		>
			{/* Header row */}
			<div className="flex items-center gap-2 flex-wrap">
				<OrchestratorBadge orchestratorId={message.from} />
				{message.fromInstanceId && (
					<span className="text-[10px] text-muted-foreground/70 font-mono">
						{message.fromInstanceId}
					</span>
				)}
				<ChannelLabel channel={message.channel} />
				<span className="ml-auto text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
					{formatRelativeTime(message.createdAt)}
				</span>
				{isUnread && onMarkRead && (
					<button
						type="button"
						onClick={onMarkRead}
						className="text-[10px] font-medium text-[oklch(0.65_0.15_232)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded shrink-0"
					>
						{t("mark_read")}
					</button>
				)}
			</div>

			{/* Content */}
			<p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
				{message.content}
			</p>
		</article>
	);
}
