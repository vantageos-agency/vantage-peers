"use client";

import { useTranslations } from "next-intl";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

export type MissionStatusFilter =
	| "brainstorm"
	| "plan"
	| "execute"
	| "validate"
	| "complete"
	| "all";

export type MissionPriorityFilter =
	| "urgent"
	| "high"
	| "medium"
	| "low"
	| "all";

interface MissionFiltersProps {
	status: MissionStatusFilter;
	priority: MissionPriorityFilter;
	onStatusChange: (value: MissionStatusFilter) => void;
	onPriorityChange: (value: MissionPriorityFilter) => void;
}

export function MissionFilters({
	status,
	priority,
	onStatusChange,
	onPriorityChange,
}: MissionFiltersProps) {
	const t = useTranslations("missions_page");

	return (
		<div className="flex flex-wrap items-center gap-2">
			{/* Status filter */}
			<Select value={status} onValueChange={onStatusChange}>
				<SelectTrigger className="h-8 text-xs w-36">
					<SelectValue placeholder={t("filter_status")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">{t("all_statuses")}</SelectItem>
					<SelectItem value="brainstorm">{t("status_brainstorm")}</SelectItem>
					<SelectItem value="plan">{t("status_plan")}</SelectItem>
					<SelectItem value="execute">{t("status_execute")}</SelectItem>
					<SelectItem value="validate">{t("status_validate")}</SelectItem>
					<SelectItem value="complete">{t("status_complete")}</SelectItem>
				</SelectContent>
			</Select>

			{/* Priority filter */}
			<Select value={priority} onValueChange={onPriorityChange}>
				<SelectTrigger className="h-8 text-xs w-36">
					<SelectValue placeholder={t("filter_priority")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">{t("all_priorities")}</SelectItem>
					<SelectItem value="urgent">{t("priority_urgent")}</SelectItem>
					<SelectItem value="high">{t("priority_high")}</SelectItem>
					<SelectItem value="medium">{t("priority_medium")}</SelectItem>
					<SelectItem value="low">{t("priority_low")}</SelectItem>
				</SelectContent>
			</Select>
		</div>
	);
}
