"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { TaskCard, type TaskCardData } from "./task-card";

type TaskStatus = "todo" | "in_progress" | "review" | "blocked" | "done";

const STATUS_STYLES: Record<
	TaskStatus,
	{ header: string; dot: string; label: string }
> = {
	todo: {
		header: "bg-muted/60 text-muted-foreground",
		dot: "bg-muted-foreground",
		label: "column_todo",
	},
	in_progress: {
		header: "bg-[oklch(0.65_0.15_232)]/10 text-[oklch(0.65_0.15_232)]",
		dot: "bg-[oklch(0.65_0.15_232)]",
		label: "column_in_progress",
	},
	review: {
		header: "bg-[oklch(0.65_0.15_290)]/10 text-[oklch(0.65_0.15_290)]",
		dot: "bg-[oklch(0.65_0.15_290)]",
		label: "column_review",
	},
	blocked: {
		header: "bg-destructive/10 text-destructive",
		dot: "bg-destructive",
		label: "column_blocked",
	},
	done: {
		header: "bg-[oklch(0.65_0.15_145)]/10 text-[oklch(0.65_0.15_145)]",
		dot: "bg-[oklch(0.65_0.15_145)]",
		label: "column_done",
	},
};

interface TaskColumnProps {
	status: TaskStatus;
	tasks: TaskCardData[];
	onTaskClick: (task: TaskCardData) => void;
}

export function TaskColumn({ status, tasks, onTaskClick }: TaskColumnProps) {
	const t = useTranslations("tasks_page");
	const style = STATUS_STYLES[status];

	return (
		<section
			aria-label={`${t(style.label as Parameters<typeof t>[0])} column`}
			className="flex flex-col min-w-[260px] max-w-[300px] shrink-0"
		>
			{/* Column header */}
			<div
				className={cn(
					"flex items-center gap-2 px-3 py-2 rounded-lg mb-3",
					style.header,
				)}
			>
				<span
					className={cn("size-2 rounded-full shrink-0", style.dot)}
					aria-hidden="true"
				/>
				<span className="text-xs font-semibold uppercase tracking-wider">
					{t(style.label as Parameters<typeof t>[0])}
				</span>
				<span className="ml-auto text-xs font-medium bg-background/50 px-1.5 py-0.5 rounded-full tabular-nums">
					{tasks.length}
				</span>
			</div>

			{/* Card list */}
			<ul className="flex flex-col gap-2 flex-1 overflow-y-auto min-h-[80px]">
				{tasks.length === 0 ? (
					<li className="flex items-center justify-center h-20 border border-dashed border-border rounded-lg text-xs text-muted-foreground/60">
						—
					</li>
				) : (
					tasks.map((task) => (
						<li key={task._id}>
							<TaskCard task={task} onClick={() => onTaskClick(task)} />
						</li>
					))
				)}
			</ul>
		</section>
	);
}
