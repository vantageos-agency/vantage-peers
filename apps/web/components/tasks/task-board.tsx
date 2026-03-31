"use client";

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { TaskCardData } from "./task-card";
import { TaskColumn } from "./task-column";
import { TaskDetailSheet } from "./task-detail-sheet";
import {
	type TaskAssigneeFilter,
	TaskFilters,
	type TaskPriorityFilter,
} from "./task-filters";
import { TasksEmptyState } from "./tasks-empty-state";

type TaskStatus = "todo" | "in_progress" | "review" | "blocked" | "done";

const STATUS_ORDER: TaskStatus[] = [
	"todo",
	"in_progress",
	"review",
	"blocked",
	"done",
];

export function TaskBoard() {
	const [assignedTo, setAssignedTo] = useState<TaskAssigneeFilter>("all");
	const [project, setProject] = useState<string>("all");
	const [priority, setPriority] = useState<TaskPriorityFilter>("all");
	const [selectedTask, setSelectedTask] = useState<TaskCardData | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);

	// Fetch all tasks — filter client-side since list() only supports one filter at a time via indexes
	const allTasks = useQuery(api.tasks.list, {});

	const tasks = useMemo<TaskCardData[]>(() => {
		if (!allTasks) return [];
		return allTasks
			.filter((t) => assignedTo === "all" || t.assignedTo === assignedTo)
			.filter((t) => project === "all" || t.project === project)
			.filter((t) => priority === "all" || t.priority === priority)
			.map((t) => ({
				_id: t._id as string,
				title: t.title,
				assignedTo: t.assignedTo,
				priority: t.priority,
				status: t.status,
				project: t.project,
				claimedByInstance: t.claimedByInstance,
				description: t.description,
				completionNote: t.completionNote,
				estimatedMinutes: t.estimatedMinutes,
				actualMinutes: t.actualMinutes,
				dependsOn: t.dependsOn as string[] | undefined,
				createdAt: t.createdAt,
				updatedAt: t.updatedAt,
			}));
	}, [allTasks, assignedTo, project, priority]);

	const projects = useMemo(() => {
		if (!allTasks) return [];
		const set = new Set<string>();
		for (const t of allTasks) {
			if (t.project) set.add(t.project);
		}
		return Array.from(set).sort();
	}, [allTasks]);

	const tasksByStatus = useMemo(() => {
		const map = new Map<TaskStatus, TaskCardData[]>();
		for (const s of STATUS_ORDER) map.set(s, []);
		for (const task of tasks) {
			map.get(task.status as TaskStatus)?.push(task);
		}
		return map;
	}, [tasks]);

	const handleTaskClick = (task: TaskCardData) => {
		setSelectedTask(task);
		setSheetOpen(true);
	};

	// Loading state
	if (allTasks === undefined) {
		return (
			<div className="flex flex-col gap-4 p-4 md:p-6">
				<div className="flex gap-2">
					<Skeleton className="h-8 w-36" />
					<Skeleton className="h-8 w-36" />
					<Skeleton className="h-8 w-36" />
				</div>
				<div className="flex gap-4 overflow-x-auto pb-4">
					{STATUS_ORDER.map((s) => (
						<div key={s} className="min-w-[260px] flex flex-col gap-2">
							<Skeleton className="h-8 w-full" />
							<Skeleton className="h-24 w-full" />
							<Skeleton className="h-24 w-full" />
						</div>
					))}
				</div>
			</div>
		);
	}

	const isEmpty = allTasks.length === 0;

	return (
		<>
			<div className="flex flex-col gap-4 p-4 md:p-6 h-full">
				{/* Filters */}
				<TaskFilters
					assignedTo={assignedTo}
					project={project}
					priority={priority}
					projects={projects}
					onAssignedToChange={setAssignedTo}
					onProjectChange={setProject}
					onPriorityChange={setPriority}
				/>

				{/* Board */}
				{isEmpty ? (
					<TasksEmptyState />
				) : (
					<div className="flex gap-4 overflow-x-auto pb-6 flex-1">
						{STATUS_ORDER.map((status) => (
							<TaskColumn
								key={status}
								status={status}
								tasks={tasksByStatus.get(status) ?? []}
								onTaskClick={handleTaskClick}
							/>
						))}
					</div>
				)}
			</div>

			<TaskDetailSheet
				task={selectedTask}
				open={sheetOpen}
				onOpenChange={setSheetOpen}
			/>
		</>
	);
}
