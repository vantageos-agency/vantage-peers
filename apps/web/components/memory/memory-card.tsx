"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export type MemoryType =
	| "user"
	| "feedback"
	| "project"
	| "reference"
	| "episode";
export type Creator = "pi" | "tau" | "phi" | "sigma" | "system";
export type RelationType = "updates" | "extends" | "derives";
export type Severity = "critical" | "major" | "minor";

export interface EpisodeData {
	context: string;
	goal: string;
	action: string;
	outcome: string;
	insight: string;
	severity: Severity;
}

export interface MemoryRelation {
	targetId: string;
	type: RelationType;
}

export interface MemoryCardData {
	_id: string;
	namespace: string;
	type: MemoryType;
	content: string;
	createdBy: Creator;
	relations: MemoryRelation[];
	isLatest: boolean;
	ttl?: string;
	episode?: EpisodeData;
	createdAt: number;
	updatedAt: number;
}

const TYPE_STYLES: Record<
	MemoryType,
	{ label: string; bg: string; text: string }
> = {
	user: {
		label: "user",
		bg: "bg-[oklch(0.65_0.15_232)]/15",
		text: "text-[oklch(0.65_0.15_232)]",
	},
	feedback: {
		label: "feedback",
		bg: "bg-[oklch(0.65_0.15_50)]/15",
		text: "text-[oklch(0.65_0.15_50)]",
	},
	project: {
		label: "project",
		bg: "bg-[oklch(0.65_0.15_290)]/15",
		text: "text-[oklch(0.65_0.15_290)]",
	},
	reference: {
		label: "reference",
		bg: "bg-[oklch(0.75_0.18_85)]/15",
		text: "text-[oklch(0.75_0.18_85)]",
	},
	episode: {
		label: "episode",
		bg: "bg-destructive/10",
		text: "text-destructive",
	},
};

const CREATOR_COLORS: Record<Creator, string> = {
	pi: "bg-[oklch(0.65_0.15_232)]/20 text-[oklch(0.65_0.15_232)]",
	tau: "bg-[oklch(0.65_0.15_290)]/20 text-[oklch(0.65_0.15_290)]",
	phi: "bg-[oklch(0.65_0.15_145)]/20 text-[oklch(0.65_0.15_145)]",
	sigma: "bg-[oklch(0.65_0.15_50)]/20 text-[oklch(0.65_0.15_50)]",
	system: "bg-muted text-muted-foreground",
};

function formatRelativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	const minutes = Math.floor(diff / 60_000);
	const hours = Math.floor(diff / 3_600_000);
	const days = Math.floor(diff / 86_400_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	return `${days}d ago`;
}

function isTtlExpiringSoon(ttl?: string): boolean {
	if (!ttl) return false;
	const expiry = new Date(ttl).getTime();
	const sevenDays = 7 * 24 * 60 * 60 * 1000;
	return expiry - Date.now() < sevenDays;
}

interface MemoryCardProps {
	memory: MemoryCardData;
	onClick: () => void;
}

export function MemoryCard({ memory, onClick }: MemoryCardProps) {
	const t = useTranslations("memory_page");
	const typeStyle = TYPE_STYLES[memory.type] ?? TYPE_STYLES.project;
	const creatorColor =
		CREATOR_COLORS[memory.createdBy] ?? CREATOR_COLORS.system;
	const expiringSoon = isTtlExpiringSoon(memory.ttl);
	const preview =
		memory.content.slice(0, 120) + (memory.content.length > 120 ? "…" : "");

	return (
		<button
			type="button"
			className="w-full text-left rounded-xl border border-border bg-card p-4 hover:bg-accent/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onClick}
			aria-label={`${memory.type} memory: ${preview}`}
		>
			{/* Top row: type badge + latest dot + ttl warning */}
			<div className="flex items-center gap-2 mb-2 flex-wrap">
				<span
					className={cn(
						"inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide",
						typeStyle.bg,
						typeStyle.text,
					)}
				>
					{typeStyle.label}
				</span>
				{memory.isLatest && (
					<span className="flex items-center gap-1 text-[10px] text-[oklch(0.65_0.15_145)] font-medium">
						<span
							className="inline-block w-1.5 h-1.5 rounded-full bg-[oklch(0.65_0.15_145)]"
							aria-hidden="true"
						/>
						{t("latest")}
					</span>
				)}
				{expiringSoon && (
					<span
						className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium"
						style={{
							backgroundColor: "oklch(0.75 0.18 55 / 0.15)",
							color: "oklch(0.75 0.18 55)",
						}}
					>
						{t("expires_soon")}
					</span>
				)}
				<span className="ml-auto text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
					{formatRelativeTime(memory.createdAt)}
				</span>
			</div>

			{/* Namespace */}
			<p className="text-[10px] text-muted-foreground/60 font-mono mb-1.5 truncate">
				{memory.namespace}
			</p>

			{/* Content preview */}
			<p className="text-xs text-foreground leading-relaxed line-clamp-2 mb-3">
				{preview}
			</p>

			{/* Footer: createdBy */}
			<div className="flex items-center gap-2">
				<span
					className={cn(
						"inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider",
						creatorColor,
					)}
				>
					{memory.createdBy}
				</span>
				{memory.episode && (
					<span className="text-[10px] text-muted-foreground italic">
						{t("has_episode")}
					</span>
				)}
			</div>
		</button>
	);
}
