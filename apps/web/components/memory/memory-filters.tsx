"use client";

import { useTranslations } from "next-intl";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { MemoryType } from "./memory-card";

export type MemoryTypeFilter = MemoryType | "all";

interface MemoryFiltersProps {
	namespace: string;
	type: MemoryTypeFilter;
	isLatest: boolean;
	onNamespaceChange: (value: string) => void;
	onTypeChange: (value: MemoryTypeFilter) => void;
	onIsLatestChange: (value: boolean) => void;
}

export function MemoryFilters({
	namespace,
	type,
	isLatest,
	onNamespaceChange,
	onTypeChange,
	onIsLatestChange,
}: MemoryFiltersProps) {
	const t = useTranslations("memory_page.filters");

	return (
		<div className="flex flex-wrap items-center gap-2">
			{/* Namespace input */}
			<div className="relative">
				<input
					type="text"
					value={namespace}
					onChange={(e) => onNamespaceChange(e.target.value)}
					placeholder={t("namespace_placeholder")}
					className="h-8 rounded-md border border-input bg-background px-3 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 w-44"
					aria-label={t("namespace_label")}
				/>
			</div>

			{/* Type filter */}
			<Select
				value={type}
				onValueChange={(v) => onTypeChange(v as MemoryTypeFilter)}
			>
				<SelectTrigger className="h-8 text-xs w-36">
					<SelectValue placeholder={t("type_placeholder")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">{t("all_types")}</SelectItem>
					<SelectItem value="user">{t("type_user")}</SelectItem>
					<SelectItem value="feedback">{t("type_feedback")}</SelectItem>
					<SelectItem value="project">{t("type_project")}</SelectItem>
					<SelectItem value="reference">{t("type_reference")}</SelectItem>
					<SelectItem value="episode">{t("type_episode")}</SelectItem>
				</SelectContent>
			</Select>

			{/* isLatest toggle */}
			<label className="flex items-center gap-2 cursor-pointer h-8 px-3 rounded-md border border-input bg-background text-xs text-muted-foreground hover:text-foreground transition-colors">
				<input
					type="checkbox"
					checked={isLatest}
					onChange={(e) => onIsLatestChange(e.target.checked)}
					className="w-3.5 h-3.5 accent-primary rounded"
					aria-label={t("is_latest_label")}
				/>
				{t("is_latest_label")}
			</label>
		</div>
	);
}
