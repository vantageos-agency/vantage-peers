"use client";

import { useTranslations } from "next-intl";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

export type TaskAssigneeFilter =
	| "pi"
	| "tau"
	| "phi"
	| "sigma"
	| "laurent"
	| "all";
export type TaskPriorityFilter = "urgent" | "high" | "medium" | "low" | "all";

interface TaskFiltersProps {
	assignedTo: TaskAssigneeFilter;
	project: string;
	priority: TaskPriorityFilter;
	projects: string[];
	onAssignedToChange: (value: TaskAssigneeFilter) => void;
	onProjectChange: (value: string) => void;
	onPriorityChange: (value: TaskPriorityFilter) => void;
}

export function TaskFilters({
	assignedTo,
	project,
	priority,
	projects,
	onAssignedToChange,
	onProjectChange,
	onPriorityChange,
}: TaskFiltersProps) {
	const t = useTranslations("tasks_page");

	return (
		<div className="flex flex-wrap items-center gap-2">
			{/* Assignee filter */}
			<Select value={assignedTo} onValueChange={onAssignedToChange}>
				<SelectTrigger className="h-8 text-xs w-36">
					<SelectValue placeholder={t("filter_assignee")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">{t("all_assignees")}</SelectItem>
					<SelectItem value="pi">pi</SelectItem>
					<SelectItem value="tau">tau</SelectItem>
					<SelectItem value="phi">phi</SelectItem>
					<SelectItem value="sigma">sigma</SelectItem>
					<SelectItem value="laurent">laurent</SelectItem>
				</SelectContent>
			</Select>

			{/* Project filter */}
			<Select value={project} onValueChange={onProjectChange}>
				<SelectTrigger className="h-8 text-xs w-36">
					<SelectValue placeholder={t("filter_project")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">{t("all_projects")}</SelectItem>
					{projects.map((p) => (
						<SelectItem key={p} value={p}>
							{p}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			{/* Priority filter */}
			<Select value={priority} onValueChange={onPriorityChange}>
				<SelectTrigger className="h-8 text-xs w-36">
					<SelectValue placeholder={t("filter_priority")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">{t("all_priorities")}</SelectItem>
					<SelectItem value="urgent">urgent</SelectItem>
					<SelectItem value="high">high</SelectItem>
					<SelectItem value="medium">medium</SelectItem>
					<SelectItem value="low">low</SelectItem>
				</SelectContent>
			</Select>
		</div>
	);
}
