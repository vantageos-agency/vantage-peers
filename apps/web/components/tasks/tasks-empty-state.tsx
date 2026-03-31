"use client";

import { useTranslations } from "next-intl";

export function TasksEmptyState() {
	const t = useTranslations("tasks_page");

	return (
		<div className="flex flex-col items-center justify-center py-20 px-4 text-center">
			{/* Kanban icon */}
			<div className="mb-4 text-muted-foreground/40">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="48"
					height="48"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<rect width="18" height="18" x="3" y="3" rx="2" />
					<path d="M9 3v11" />
					<path d="M15 3v7" />
				</svg>
			</div>
			<h3 className="text-base font-semibold text-foreground mb-1">
				{t("empty_title")}
			</h3>
			<p className="text-sm text-muted-foreground max-w-xs">
				{t("empty_description")}
			</p>
		</div>
	);
}
