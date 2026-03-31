"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { MissionStatusPipeline } from "./mission-status-pipeline";

type MissionStatus =
	| "brainstorm"
	| "plan"
	| "execute"
	| "validate"
	| "complete";
type MissionPriority = "urgent" | "high" | "medium" | "low";

export interface MissionCardData {
	_id: string;
	name: string;
	description?: string;
	project: string;
	status: MissionStatus;
	priority: MissionPriority;
	pilot: string;
	agents: string[];
	progress?: number;
	targetDate?: number;
	taskCount?: number;
}

const PRIORITY_STYLES: Record<MissionPriority, { bg: string; text: string }> = {
	urgent: { bg: "bg-destructive/10", text: "text-destructive" },
	high: {
		bg: "bg-[oklch(0.65_0.15_50)]/10",
		text: "text-[oklch(0.65_0.15_50)]",
	},
	medium: {
		bg: "bg-[oklch(0.65_0.15_90)]/10",
		text: "text-[oklch(0.65_0.15_90)]",
	},
	low: {
		bg: "bg-[oklch(0.65_0.15_145)]/10",
		text: "text-[oklch(0.65_0.15_145)]",
	},
};

const PILOT_COLORS: Record<string, string> = {
	pi: "bg-[oklch(0.65_0.15_232)]/20 text-[oklch(0.65_0.15_232)]",
	tau: "bg-[oklch(0.65_0.15_290)]/20 text-[oklch(0.65_0.15_290)]",
	phi: "bg-[oklch(0.65_0.15_145)]/20 text-[oklch(0.65_0.15_145)]",
	sigma: "bg-[oklch(0.65_0.15_50)]/20 text-[oklch(0.65_0.15_50)]",
	laurent: "bg-muted text-muted-foreground",
};

interface MissionCardProps {
	mission: MissionCardData;
}

export function MissionCard({ mission }: MissionCardProps) {
	const t = useTranslations("missions_page");
	const priorityStyle =
		PRIORITY_STYLES[mission.priority] ?? PRIORITY_STYLES.medium;
	const pilotColor =
		PILOT_COLORS[mission.pilot] ?? "bg-muted text-muted-foreground";
	const progress = mission.progress ?? 0;

	return (
		<article className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
			{/* Header: priority + project */}
			<div className="flex items-start justify-between gap-2">
				<span
					className={cn(
						"inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize",
						priorityStyle.bg,
						priorityStyle.text,
					)}
				>
					{mission.priority}
				</span>
				<span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono truncate max-w-[120px]">
					{mission.project}
				</span>
			</div>

			{/* Name */}
			<h3 className="text-sm font-semibold text-foreground line-clamp-2 leading-snug">
				{mission.name}
			</h3>

			{/* Status pipeline */}
			<div className="flex flex-col gap-1">
				<MissionStatusPipeline status={mission.status} compact />
				<span className="text-[10px] text-muted-foreground">
					{t(`status_${mission.status}` as Parameters<typeof t>[0])}
				</span>
			</div>

			{/* Progress bar */}
			<div className="flex flex-col gap-1">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-muted-foreground">
						{t("progress")}
					</span>
					<span className="text-[10px] font-medium text-foreground tabular-nums">
						{progress}%
					</span>
				</div>
				<div className="h-1.5 rounded-full bg-muted overflow-hidden">
					<div
						className={cn(
							"h-full rounded-full transition-all duration-500",
							progress >= 100
								? "bg-[oklch(0.65_0.15_145)]"
								: progress > 0
									? "bg-[oklch(0.65_0.15_232)]"
									: "bg-muted-foreground/20",
						)}
						style={{ width: `${Math.min(100, progress)}%` }}
						role="progressbar"
						aria-valuenow={progress}
						aria-valuemin={0}
						aria-valuemax={100}
					/>
				</div>
			</div>

			{/* Footer: pilot + agents + task count */}
			<div className="flex items-center gap-2 pt-1 border-t border-border/50">
				{/* Pilot */}
				<div className="flex items-center gap-1.5 flex-1 min-w-0">
					<span className="text-[10px] text-muted-foreground shrink-0">
						{t("pilot")}:
					</span>
					<span
						className={cn(
							"text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wider",
							pilotColor,
						)}
					>
						{mission.pilot}
					</span>
				</div>

				{/* Agent count */}
				{mission.agents.length > 0 && (
					<div className="flex items-center gap-1 shrink-0">
						{/* Agent icon */}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							className="text-muted-foreground"
							aria-hidden="true"
						>
							<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
							<circle cx="9" cy="7" r="4" />
							<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
							<path d="M16 3.13a4 4 0 0 1 0 7.75" />
						</svg>
						<span className="text-[10px] text-muted-foreground tabular-nums">
							{mission.agents.length}
						</span>
					</div>
				)}

				{/* Task count */}
				{mission.taskCount !== undefined && mission.taskCount > 0 && (
					<div className="flex items-center gap-1 shrink-0">
						{/* Checkbox icon */}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							className="text-muted-foreground"
							aria-hidden="true"
						>
							<rect width="18" height="18" x="3" y="3" rx="2" />
							<path d="m9 12 2 2 4-4" />
						</svg>
						<span className="text-[10px] text-muted-foreground tabular-nums">
							{mission.taskCount}
						</span>
					</div>
				)}
			</div>
		</article>
	);
}
