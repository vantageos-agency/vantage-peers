"use client";

import { cn } from "@/lib/utils";

type TaskPriority = "urgent" | "high" | "medium" | "low";
type TaskStatus = "todo" | "in_progress" | "review" | "blocked" | "done";

export interface TaskCardData {
	_id: string;
	title: string;
	assignedTo: string;
	priority: TaskPriority;
	status: TaskStatus;
	project?: string;
	claimedByInstance?: string;
	description?: string;
	completionNote?: string;
	estimatedMinutes?: number;
	actualMinutes?: number;
	dependsOn?: string[];
	createdAt: number;
	updatedAt: number;
}

const PRIORITY_STYLES: Record<TaskPriority, { bg: string; text: string }> = {
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

const ASSIGNEE_COLORS: Record<string, string> = {
	pi: "bg-[oklch(0.65_0.15_232)]/20 text-[oklch(0.65_0.15_232)]",
	tau: "bg-[oklch(0.65_0.15_290)]/20 text-[oklch(0.65_0.15_290)]",
	phi: "bg-[oklch(0.65_0.15_145)]/20 text-[oklch(0.65_0.15_145)]",
	sigma: "bg-[oklch(0.65_0.15_50)]/20 text-[oklch(0.65_0.15_50)]",
	laurent: "bg-muted text-muted-foreground",
};

interface TaskCardProps {
	task: TaskCardData;
	onClick: () => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
	const priorityStyle =
		PRIORITY_STYLES[task.priority] ?? PRIORITY_STYLES.medium;
	const assigneeColor =
		ASSIGNEE_COLORS[task.assignedTo] ?? "bg-muted text-muted-foreground";

	return (
		<button
			type="button"
			className="w-full text-left rounded-xl border border-border bg-card p-3 cursor-pointer hover:bg-accent/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onClick}
			aria-label={task.title}
		>
			{/* Priority + project */}
			<div className="flex items-start justify-between gap-2 mb-2">
				<span
					className={cn(
						"inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize",
						priorityStyle.bg,
						priorityStyle.text,
					)}
				>
					{task.priority}
				</span>
				{task.project && (
					<span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono truncate max-w-[100px]">
						{task.project}
					</span>
				)}
			</div>

			{/* Title */}
			<p className="text-xs font-medium text-foreground line-clamp-2 mb-3">
				{task.title}
			</p>

			{/* Footer: assignee + claimed instance */}
			<div className="flex items-center gap-2 flex-wrap">
				<span
					className={cn(
						"inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider",
						assigneeColor,
					)}
				>
					{task.assignedTo}
				</span>
				{task.claimedByInstance && (
					<span className="text-[10px] text-muted-foreground italic truncate">
						{task.claimedByInstance}
					</span>
				)}
			</div>
		</button>
	);
}
