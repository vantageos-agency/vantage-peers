"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

interface TasksByStatus {
	todo: number;
	in_progress: number;
	review: number;
	blocked: number;
	done: number;
}

export interface ProjectCardData {
	name: string;
	missionCount: number;
	tasksByStatus: TasksByStatus;
	activeOrchestrators: string[];
}

const STATUS_COLORS: Record<keyof TasksByStatus, string> = {
	done: "bg-[oklch(0.65_0.15_145)]",
	in_progress: "bg-[oklch(0.65_0.15_232)]",
	review: "bg-[oklch(0.65_0.15_290)]",
	blocked: "bg-destructive",
	todo: "bg-muted-foreground/30",
};

const ORCHESTRATOR_COLORS: Record<string, string> = {
	pi: "bg-[oklch(0.65_0.15_232)]/20 text-[oklch(0.65_0.15_232)]",
	tau: "bg-[oklch(0.65_0.15_290)]/20 text-[oklch(0.65_0.15_290)]",
	phi: "bg-[oklch(0.65_0.15_145)]/20 text-[oklch(0.65_0.15_145)]",
	sigma: "bg-[oklch(0.65_0.15_50)]/20 text-[oklch(0.65_0.15_50)]",
	laurent: "bg-muted text-muted-foreground",
};

interface ProjectCardProps {
	project: ProjectCardData;
}

export function ProjectCard({ project }: ProjectCardProps) {
	const t = useTranslations("projects_page");

	const totalTasks = Object.values(project.tasksByStatus).reduce(
		(a, b) => a + b,
		0,
	);
	const taskEntries = (
		[
			["done", project.tasksByStatus.done],
			["in_progress", project.tasksByStatus.in_progress],
			["review", project.tasksByStatus.review],
			["blocked", project.tasksByStatus.blocked],
			["todo", project.tasksByStatus.todo],
		] as [keyof TasksByStatus, number][]
	).filter(([, count]) => count > 0);

	return (
		<article className="rounded-xl border border-border bg-card p-4 flex flex-col gap-4">
			{/* Project name */}
			<div className="flex items-start justify-between gap-2">
				<h3 className="text-sm font-semibold text-foreground leading-snug font-mono">
					{project.name}
				</h3>
				{project.missionCount > 0 && (
					<div className="flex items-center gap-1 shrink-0">
						{/* Target icon */}
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
							<circle cx="12" cy="12" r="10" />
							<circle cx="12" cy="12" r="6" />
							<circle cx="12" cy="12" r="2" />
						</svg>
						<span className="text-[10px] text-muted-foreground tabular-nums">
							{project.missionCount} {t("missions")}
						</span>
					</div>
				)}
			</div>

			{/* Task breakdown bar */}
			{totalTasks > 0 ? (
				<div className="flex flex-col gap-2">
					<span className="text-[10px] text-muted-foreground uppercase tracking-wider">
						{t("tasks_breakdown")} ({totalTasks})
					</span>
					{/* Stacked bar */}
					<div
						className="flex h-2 rounded-full overflow-hidden gap-px"
						aria-hidden="true"
					>
						{taskEntries.map(([status, count]) => (
							<div
								key={status}
								className={cn("h-full transition-all", STATUS_COLORS[status])}
								style={{ width: `${(count / totalTasks) * 100}%` }}
								title={`${t((status === "in_progress" ? "in_progress" : status) as Parameters<typeof t>[0])}: ${count}`}
							/>
						))}
					</div>
					{/* Legend */}
					<div className="flex flex-wrap gap-x-3 gap-y-1">
						{taskEntries.map(([status, count]) => (
							<div key={status} className="flex items-center gap-1">
								<span
									className={cn("size-1.5 rounded-full", STATUS_COLORS[status])}
									aria-hidden="true"
								/>
								<span className="text-[10px] text-muted-foreground capitalize">
									{status.replace("_", " ")} {count}
								</span>
							</div>
						))}
					</div>
				</div>
			) : (
				<div className="h-2 rounded-full bg-muted" aria-hidden="true" />
			)}

			{/* Active orchestrators */}
			{project.activeOrchestrators.length > 0 && (
				<div className="flex items-center gap-2 pt-1 border-t border-border/50">
					<span className="text-[10px] text-muted-foreground shrink-0">
						{t("orchestrators")}:
					</span>
					<div className="flex flex-wrap gap-1">
						{project.activeOrchestrators.map((orch) => (
							<span
								key={orch}
								className={cn(
									"text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wider",
									ORCHESTRATOR_COLORS[orch] ?? "bg-muted text-muted-foreground",
								)}
							>
								{orch}
							</span>
						))}
					</div>
				</div>
			)}
		</article>
	);
}
